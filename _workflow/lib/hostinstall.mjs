// Host-install pure helpers (KI-O5 — controller-asset installation, SETUP.md § 3).
//
// Three concerns, all pure/injectable-first so `setup/init.mjs` and `setup/install.mjs` stay thin
// shells around selftest-covered logic (the pre-KI-O5 installers had ZERO behavioural coverage —
// only `bash -n` parse pins, see KI-E52's selftest block):
//
//   1. mergeOpencodeConfig  — deep-merges the factory's OpenCode controller policy (an
//      `instructions` entry + `permission`/`permissions` deny rules, plus, per host major version,
//      a set of worker-profile `agent`/`agents` entries) into a HOST-OWNED `opencode.json`/
//      `opencode.jsonc`. Claude/Copilot assets are whole FILES the factory owns end to end, so
//      `copyTree`'s byte-compare + `*.factory-new` no-clobber is enough for them. An OpenCode config
//      is different in kind: it is the host's own file, carrying the host's own model/provider/mcp
//      settings, so the factory has to merge INTO it rather than own it. Rule ORDER is load-bearing
//      — opencode evaluates the LAST matching permission pattern — so the factory's deny rules are
//      always re-appended at the END of each tool's rule object, never left wherever a previous
//      install happened to put them (a plain `{...host, ...factory}` spread keeps an existing key in
//      its ORIGINAL position, which would let a later broad host `git *` allow silently outrank a
//      factory deny; that is the whole reason this is a real function and not an object spread at
//      the call site). OpenCode's config shape forked at major version 2 (`permission` object ->
//      `permissions` rule array, `agent` -> `agents`) — `mergeOpencodeConfig`'s `major` parameter
//      (ported from a host-mount session) selects the matching merge path and REFUSES a v1 config
//      carrying v2 keys or vice versa rather than guessing.
//
//   2. pickLatestReleaseTag — the strict `vX.Y.Z` + semver-sort resolution `setup/install.sh`
//      does with `grep -E | sort -V`, ported so the Node installer cannot drift from it
//      (`sort -V` ranks `v1.0.0-rc1` ABOVE `v1.0.0` and a date-like `v20250101` above every real
//      release, which is why the bash side greps strict-semver FIRST — same posture here).
//
//   3. installManagedFile / installAgentsGuidance / writeAssetAtomic (ported from a host-mount
//      session) — the factory-owned-whole-file install path (concern 1's "Claude/Copilot assets are
//      whole FILES" case) as real, atomic, hash-tracked filesystem operations rather than a bare
//      byte-compare left to the caller: a managed file created by an earlier install is UPDATED in
//      place when the on-disk content still matches the LAST hash the factory itself installed
//      (`hashes[key]`), and PRESERVED (written instead to a `.factory-new` sibling, never clobbering
//      the host's own edit) the moment the on-disk content has drifted from that hash — the host
//      edited the file since the last install, and that edit wins. `installAgentsGuidance` applies
//      the same rule to a single delimited `<!-- ai-factory:begin/end -->` block inside a host-owned
//      AGENTS.md the factory does not otherwise own.
//
// Filesystem installation helpers use an explicit host root — the pure merge/comparator logic above
// still takes every input as a parameter and touches nothing on its own.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseOpenCodeVersion } from '../opencode/compatibility.mjs';

// The host paths an OpenCode project config can live at, in opencode's own resolution order.
// A `.jsonc` host file that does not parse as strict JSON is REFUSED by mergeOpencodeConfig
// rather than silently rewritten without its comments.
export const OPENCODE_CONFIG_CANDIDATES = ['.opencode/opencode.jsonc', '.opencode/opencode.json', 'opencode.jsonc', 'opencode.json'];

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// v2's rule-array `effect` values. `FLAT_TOOLS` are v1 tools whose permission value is ALWAYS a bare
// string (never a per-resource rule object) — `todowrite`/`question`/`webfetch`/`websearch`/
// `doom_loop` have no resource dimension to pattern-match against, so treating one as a rule object
// (the `PATTERNED_TOOLS`-style path every other tool takes) would silently accept a shape opencode
// itself rejects.
const ACTIONS = new Set(['allow', 'ask', 'deny']);
const FLAT_TOOLS = new Set(['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop']);
const ruleObject = (value) => typeof value === 'string' ? { '*': value } : value || {};
// A v1 `permission` object is only safely mergeable when every entry is either a bare action string
// or a per-resource object whose OWN values are bare action strings — anything else (a nested object,
// an unrecognized action) is a shape mergeOpencodeConfig has no safe rule for and must refuse rather
// than guess at.
function validPermissions(permission) {
  return permission === undefined || (isPlainObject(permission) && Object.entries(permission).every(([tool, rules]) =>
    ACTIONS.has(rules) || (!FLAT_TOOLS.has(tool) && isPlainObject(rules) && Object.values(rules).every((action) => ACTIONS.has(action)))));
}

// `readFileSync(p, 'utf8')` does NOT strip a UTF-8 BOM, and JSON.parse rejects one outright.
// Windows tooling writes BOMs routinely (PowerShell 5.1's `Set-Content -Encoding utf8`, older
// Visual Studio, Notepad), so parsing a host's opencode.json without this turns a perfectly
// valid config into an "unparseable — REFUSING to touch" warning, and the factory's controller
// policy then silently never installs on exactly the hosts that need install.mjs most.
// Live-caught 2026-08-17 against a BOM'd fixture, before shipping.
export function stripBom(text) { return String(text).replace(/^\uFEFF/, ''); }

// JSON.parse over a possibly-BOM'd file body. Throws on genuinely malformed JSON — the caller
// distinguishes "cannot parse" (refuse, never clobber) from "parsed fine".
export function parseJsonFile(text) { return JSON.parse(stripBom(text)); }

// Re-append `factoryRules` at the END of `hostRules`, dropping any factory-owned key from its
// previous position first. Returns a NEW object; neither input is mutated.
//
// Fix (ported from a host-mount session): a host `deny` on a key the factory ALSO rules on, or on a
// wildcard/pattern key overlapping several factory keys, must never be silently outranked by a
// factory `allow`/`ask` re-append landing AFTER it — opencode's last-match-wins evaluation would then
// let the factory's rule win over an explicit host deny. Every host `deny` (bare or on a `?`/`*`
// pattern key) is re-appended LAST, after the factory's own rules, so it remains the final word.
export function appendRulesLast(hostRules, factoryRules) {
  const owned = new Set(Object.keys(factoryRules));
  const out = {};
  for (const [k, v] of Object.entries(hostRules)) if (!owned.has(k)) out[k] = v;
  for (const [k, v] of Object.entries(factoryRules)) out[k] = hostRules[k] === 'deny' ? 'deny' : v;
  for (const [k, v] of Object.entries(hostRules)) {
    if (v !== 'deny') continue;
    delete out[k]; out[k] = v;
  }
  for (const [k, v] of Object.entries(factoryRules)) {
    if (v !== 'deny') continue;
    delete out[k]; out[k] = v;
  }
  return out;
}

// Union an `instructions` array with the factory's entries, preserving host order and appending
// only what is genuinely absent (idempotent across re-installs and upgrades).
export function appendInstructions(hostList, factoryList) {
  const out = Array.isArray(hostList) ? hostList.slice() : [];
  for (const e of factoryList) if (!out.includes(e)) out.push(e);
  return out;
}

// Merge the factory's OpenCode policy fragment into a host config object.
//
//   hostCfg   parsed host opencode.json ({} / null for "no file yet")
//   fragment  opencode-assets/opencode.config.json (parsed), OR a `major`-matched fragment built by
//             opencodeFragment() (worker profiles included)
//   major     1 or 2 (ported from a host-mount session) — selects which OpenCode config generation
//             this host runs; defaults to 1 (the pre-existing shape) for every caller that has not
//             yet been updated to pass it explicitly
//
// Returns { config, changed, notes, refused }:
//   config   the merged object (a NEW object — hostCfg is never mutated)
//   changed  true when `config` differs from `hostCfg`
//   notes    human-readable lines describing every edit (or why one was skipped)
//   refused  a reason string when the host config cannot be safely merged (caller must warn
//            loudly and leave the file alone), else null
export function mergeOpencodeConfig(hostCfg, fragment, major = 1) {
  if (major === 2) return mergeOpencodeV2(hostCfg, fragment);
  if (major !== 1) return { config: hostCfg, changed: false, notes: [], refused: 'unknown OpenCode version; select --opencode-version 1 or 2' };
  if (hostCfg != null && !isPlainObject(hostCfg)) return { config: hostCfg, changed: false, notes: [], refused: 'host config must be an object' };
  const host = isPlainObject(hostCfg) ? hostCfg : {};
  const notes = [];
  if (host.permissions || host.agents) return { config: host, changed: false, notes, refused: 'v2 keys in a v1 config; migrate explicitly' };

  // A bare-string `permission` covers tools the factory says nothing about — never narrow it.
  if (typeof host.permission === 'string') {
    return {
      config: host,
      changed: false,
      notes: [],
      refused: 'host permission is the bare-string form ("' + host.permission + '"), which applies to EVERY tool; '
        + 'expanding it to the per-tool object form would silently change read/glob/grep/list/task posture too',
    };
  }
  if (!validPermissions(host.permission)) {
    return { config: host, changed: false, notes: [], refused: 'host permission is neither an object nor a string' };
  }
  if (fragment.agent && host.tools && Object.values(host.tools).includes(false)) return { config: host, changed: false, notes: [], refused: 'legacy disabled tools require explicit permission migration before installing worker profiles' };
  if (host.permission?.['*'] === 'deny') return { config: host, changed: false, notes: [], refused: 'global wildcard deny requires manual permission merge' };

  const out = { ...host };

  // $schema is additive and purely an editor aid — only ever filled in when absent.
  if (!out.$schema && fragment.$schema) { out.$schema = fragment.$schema; notes.push('added $schema'); }

  if (Array.isArray(fragment.instructions) && fragment.instructions.length) {
    if (out.instructions !== undefined && !Array.isArray(out.instructions)) return { config: host, changed: false, notes: [], refused: 'instructions must be an array' };
    const merged = appendInstructions(out.instructions, fragment.instructions);
    const added = merged.filter((e) => !(out.instructions || []).includes(e));
    if (added.length) { out.instructions = merged; notes.push('instructions += ' + added.join(', ')); }
    else if (!out.instructions) { out.instructions = merged; }
  }

  if (isPlainObject(fragment.permission)) {
    const perm = { ...(out.permission || {}) };
    // Previously hardcoded to a `PATTERNED_TOOLS = ['bash', 'edit']` allowlist — now iterates
    // whatever tools the fragment itself names, a strict widening (any fragment that only ever used
    // bash/edit keys behaves identically; a fragment naming another patterned tool now merges too).
    for (const tool of Object.keys(fragment.permission)) {
      const value = fragment.permission[tool];
      if (FLAT_TOOLS.has(tool)) { perm[tool] = perm[tool] === 'deny' ? 'deny' : value; continue; }
      const factoryRules = typeof value === 'string' ? { '*': value } : value;
      if (!isPlainObject(factoryRules)) continue;
      // `permission.<tool>: "allow"` is documented shorthand for `{"*": "allow"}` — promoting it
      // is exactly equivalent (unlike the top-level bare string above), so it is safe here.
      let hostRules = perm[tool];
      if (typeof hostRules === 'string') { hostRules = { '*': hostRules }; notes.push(tool + ': expanded the "' + perm[tool] + '" shorthand to {"*": "' + perm[tool] + '"}'); }
      else if (hostRules === undefined) hostRules = {};
      else if (!isPlainObject(hostRules)) return { config: host, changed: false, notes: [], refused: 'invalid permission rules for ' + tool };
      const before = JSON.stringify(hostRules);
      const nextRules = appendRulesLast(hostRules, factoryRules);
      if (JSON.stringify(nextRules) !== before) {
        const fresh = Object.keys(factoryRules).filter((k) => !(k in hostRules));
        const moved = Object.keys(factoryRules).filter((k) => k in hostRules);
        if (fresh.length) notes.push(tool + ': +' + fresh.length + ' factory rule(s)');
        if (moved.length) notes.push(tool + ': re-appended ' + moved.length + ' existing factory rule(s) LAST (last match wins)');
      }
      perm[tool] = nextRules;
    }
    out.permission = perm;
    // A host `deny` on a wildcard/pattern tool key (`git-*`, `terr?form`) is re-appended last against
    // only its OWN deny entries — appendRulesLast above already handles the exact-key case; this
    // covers the pattern-key case a per-tool loop keyed on `fragment.permission`'s own tool names
    // cannot reach (the host's pattern key may not match any factory-named tool at all).
    for (const [tool, rules] of Object.entries(host.permission || {})) {
      if (!/[?*]/.test(tool) || !Object.values(ruleObject(rules)).includes('deny')) continue;
      delete perm[tool];
      perm[tool] = appendRulesLast(ruleObject(rules), Object.fromEntries(Object.entries(ruleObject(rules)).filter(([, effect]) => effect === 'deny')));
    }
  }

  if (fragment.agent) {
    if (host.agent !== undefined && !isPlainObject(host.agent)) return { config: host, changed: false, notes: [], refused: 'agent must be an object' };
    out.agent = { ...host.agent };
    for (const [id, defaults] of Object.entries(fragment.agent)) {
      const existing = out.agent[id] || {};
      if (!isPlainObject(existing) || typeof existing.permission === 'string') return { config: host, changed: false, notes: [], refused: 'agent ' + id + ' needs manual permission merge' };
      if (existing.tools && Object.values(existing.tools).includes(false)) return { config: host, changed: false, notes: [], refused: 'agent ' + id + ' has legacy disabled tools; migrate permissions explicitly' };
      const merged = mergeOpencodeConfig({ permission: existing.permission }, { permission: defaults.permission });
      if (merged.refused) return { config: host, changed: false, notes: [], refused: 'agent ' + id + ': ' + merged.refused };
      // A deny already in effect on the top-level `out.permission` (host- or factory-declared) must
      // also bind each worker agent — an agent-level permission object with no matching entry falls
      // back to the top-level config in opencode, but a WORKER PROFILE that positively re-declares
      // other rules for the same tool must not accidentally omit the deny by only inheriting it
      // implicitly.
      for (const [tool, rules] of Object.entries(out.permission || {})) {
        const denies = Object.fromEntries(Object.entries(ruleObject(rules)).filter(([, effect]) => effect === 'deny'));
        if (!Object.keys(denies).length) continue;
        if (FLAT_TOOLS.has(tool)) { delete merged.config.permission[tool]; merged.config.permission[tool] = 'deny'; }
        else {
          const next = appendRulesLast(ruleObject(merged.config.permission[tool]), denies);
          delete merged.config.permission[tool];
          merged.config.permission[tool] = next;
        }
      }
      out.agent[id] = { ...defaults, ...existing, permission: merged.config.permission };
    }
  }

  return { config: out, changed: JSON.stringify(out) !== JSON.stringify(host), notes, refused: null };
}

// The OpenCode config-schema major version (1 or 2) a given `opencode --version`-style string output
// implies, or null when unrecognized. Delegates entirely to `../opencode/compatibility.mjs` so the
// runtime-compatibility table and the config-merge major-version selection can never independently
// drift out of sync — one parser, two call sites.
export function opencodeMajor(version) {
  return parseOpenCodeVersion(version)?.configMajor ?? null;
}

// Resolve which config major to install with, given the detected executable `output` (may be empty/
// unavailable) and an operator-supplied `--opencode-version` `explicit` string ('1' | '2' | undefined).
// Throws rather than silently guessing on any disagreement or unrecognized input — an operator who
// gets this wrong installs a config shape the running opencode binary cannot read at all.
export function selectOpencodeMajor(output, explicit) {
  if (explicit !== undefined && !['1', '2'].includes(explicit)) throw new Error('--opencode-version must be 1 or 2');
  const detected = opencodeMajor(output);
  if (output && !detected) throw new Error('unsupported OpenCode executable version; explicit selection cannot override an unrecognized runtime');
  if (explicit && detected && Number(explicit) !== detected) throw new Error('selected OpenCode version disagrees with the executable');
  return explicit ? Number(explicit) : detected;
}

// v2's rule-array analogue of appendRulesLast: `host`/`factory` are `{action, resource, effect}[]`
// arrays (opencode v2's `permissions` shape) rather than v1's per-tool rule objects. Same ordering
// invariant — factory rules are appended after surviving host rules, then every host `deny` (on an
// action+resource pair) is re-appended last so it cannot be silently outranked by a factory rule on
// the SAME pair landing after it, exactly mirroring the v1 function's own final loop.
export function appendPermissionRules(host = [], factory = []) {
  const valid = (r) => isPlainObject(r) && typeof r.action === 'string' && typeof r.resource === 'string' && ['allow', 'ask', 'deny'].includes(r.effect);
  if (!Array.isArray(host) || !Array.isArray(factory) || !host.every(valid) || !factory.every(valid)) throw new Error('permissions must be action/resource/effect rule arrays');
  const keys = new Set(factory.map((r) => r.action + '\0' + r.resource));
  const out = host.filter((r) => !keys.has(r.action + '\0' + r.resource));
  for (const r of factory) out.push({ ...r, effect: host.some((h) => h.action === r.action && h.resource === r.resource && h.effect === 'deny') ? 'deny' : r.effect });
  for (const r of host.filter((r) => r.effect === 'deny')) {
    const i = out.findIndex((x) => x.action === r.action && x.resource === r.resource);
    if (i >= 0) out.splice(i, 1);
    out.push(r);
  }
  return out;
}

// The OpenCode v2 merge path: `permission` (per-tool rule object) -> `permissions` (flat
// action/resource/effect rule array), `agent` -> `agents`. Refuses a host config that still carries
// v1 keys (same "migrate explicitly, never guess" posture as the v1 path's own v2-key refusal).
function mergeOpencodeV2(hostCfg, fragment) {
  const host = hostCfg ?? {};
  const refuse = (refused) => ({ config: host, changed: false, notes: [], refused });
  if (!isPlainObject(host)) return refuse('host config must be an object');
  if (host.permission || host.agent) return refuse('v1 permission/agent keys require explicit migration before v2 installation');
  try {
    const out = { ...host, $schema: host.$schema || fragment.$schema, permissions: appendPermissionRules(host.permissions, fragment.permissions) };
    if (host.agents !== undefined && !isPlainObject(host.agents)) return refuse('agents must be an object');
    out.agents = { ...host.agents };
    for (const [id, defaults] of Object.entries(fragment.agents || {})) {
      const existing = out.agents[id] || {};
      if (!isPlainObject(existing)) return refuse('agent ' + id + ' must be an object');
      const permissions = appendPermissionRules(existing.permissions, defaults.permissions);
      out.agents[id] = { ...defaults, ...existing, permissions: appendPermissionRules(permissions, out.permissions.filter((r) => r.effect === 'deny')) };
    }
    return { config: out, changed: JSON.stringify(out) !== JSON.stringify(host), notes: ['merged v2 permissions and worker profiles'], refused: null };
  } catch (e) { return refuse(e.message); }
}

// Build the per-major OpenCode config fragment for the factory's worker subagent profiles: one
// `factory-{writer,reviewer,probe}-{tier}` entry per configured model tier, each with its own
// bash/edit permission narrowing (git subcommands denied outright; edit denied entirely for
// reviewer/probe roles, which must never write) — v1 emits an `agent`/`permission` shape, v2 emits
// the `agents`/`permissions` rule-array shape via the same `rules()` translation `mergeOpencodeV2`
// itself consumes.
export function opencodeFragment(base, profiles, major) {
  if (![1, 2].includes(major)) throw new Error('OpenCode major must be 1 or 2');
  const rules = (permission) => Object.entries(permission).flatMap(([tool, values]) => Object.entries(typeof values === 'string' ? { '*': values } : values).map(([resource, effect]) => ({ action: tool === 'bash' ? 'shell' : tool === 'task' ? 'subagent' : tool, resource, effect })));
  const workers = {};
  for (const [tier, model] of Object.entries(profiles.models)) {
    for (const kind of ['writer', 'reviewer', 'probe']) {
      const permission = { bash: { ...base.permission.bash }, task: 'deny' };
      for (const key of Object.keys(permission.bash)) if (/^git /.test(key)) permission.bash[key] = 'deny';
      permission.edit = kind === 'writer' ? base.permission.edit : { '*': 'deny' };
      const prompt = profiles.guidance[kind];
      workers[`factory-${kind}-${tier}`] = major === 1
        ? { description: `${kind} worker (${tier}) for a factory dispatch`, mode: 'subagent', model, prompt, permission }
        : { description: `${kind} worker (${tier}) for a factory dispatch`, mode: 'subagent', model, system: prompt, permissions: rules(permission) };
    }
  }
  return major === 1 ? { ...base, agent: workers } : { $schema: base.$schema, permissions: rules(base.permission), agents: workers };
}

// sha256 hex of an installed asset body — the identity `installManagedFile`/`installAgentsGuidance`
// track per managed file so a re-install can tell "unchanged since we wrote it" (safe to overwrite)
// apart from "the host edited this since we wrote it" (never clobber; write beside it instead).
export const installedHash = (body) => createHash('sha256').update(body).digest('hex');

// Write `body` to `path` atomically: write to a same-directory temp file, then rename over the
// target. A rename is atomic on the SAME filesystem, so a reader never observes a partially-written
// file. Windows can transiently refuse a rename over a file another process (an editor, a virus
// scanner) has open — retried with a short backoff up to 4 times before giving up, POSIX is
// retry-free since a same-directory rename there cannot fail on "target busy".
export function writeAssetAtomic(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp.' + process.pid;
  try {
    writeFileSync(tmp, body);
    for (let attempt = 0; ; attempt++) {
      try { renameSync(tmp, path); break; } catch (e) {
        if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } finally { rmSync(tmp, { force: true }); }
}

// Install (or update) one factory-owned whole file at `path`, tracking its identity in `hashes[key]`
// (the caller's persisted per-host installed-asset-hash map). Four outcomes:
//   'created'   — no file existed yet; written, hash recorded.
//   'updated'   — a file existed, its content still matched the LAST hash the factory installed
//                 (`hashes[key]`, or, on a first-run map with no recorded hash, a file whose content
//                 already matches the NEW body needs no separate branch — see 'unchanged' below);
//                 safe to overwrite because nothing but the factory has touched it since.
//   'unchanged' — the existing file's content already IS the new body; hash recorded, nothing written.
//   'preserved' — the existing file's content differs from BOTH the new body and the last-installed
//                 hash: the host edited it. Never clobbered — the new body is written to a
//                 `path + '.factory-new'` sibling instead, and the host's own file is left alone.
export function installManagedFile(path, body, hashes, key) {
  const current = existsSync(path) ? readFileSync(path) : null;
  const nextHash = installedHash(body);
  if (current && installedHash(current) === nextHash) {
    hashes[key] = nextHash;
    return 'unchanged';
  }
  if (current && installedHash(current) !== hashes[key]) {
    writeAssetAtomic(path + '.factory-new', body);
    return 'preserved';
  }
  writeAssetAtomic(path, body);
  hashes[key] = nextHash;
  return current ? 'updated' : 'created';
}

// installManagedFile's sibling for the ONE case a factory-owned whole file cannot cover: AGENTS.md,
// a file the HOST owns end to end, into which the factory installs a single delimited
// `<!-- ai-factory:begin -->...<!-- ai-factory:end -->` block rather than the whole file. Appends the
// block (with a leading blank line separating it from any existing host content) when no block
// exists yet; otherwise applies installManagedFile's exact same identity rule to the block's own
// content — unchanged/updated/preserved — rather than to the whole file, and a malformed marker pair
// (missing/reversed/duplicated) is ALSO treated as 'preserved' (never guessed at or auto-repaired).
export function installAgentsGuidance(path, guidance, hashes) {
  const start = '<!-- ai-factory:begin -->';
  const end = '<!-- ai-factory:end -->';
  const block = start + '\n' + guidance.trim() + '\n' + end;
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const key = 'AGENTS.md#ai-factory';
  const a = current.indexOf(start), b = current.indexOf(end);
  if (a < 0 && b < 0) {
    writeAssetAtomic(path, current + (current && !current.endsWith('\n') ? '\n' : '') + (current ? '\n' : '') + block + '\n');
  } else {
    const old = current.slice(a, b + end.length);
    if (a < 0 || b < a || current.indexOf(start, a + start.length) >= 0 || current.indexOf(end, b + end.length) >= 0 || (old !== block && installedHash(old) !== hashes[key])) {
      writeAssetAtomic(path + '.factory-new', block + '\n');
      return 'preserved';
    }
    if (old === block) { hashes[key] = installedHash(block); return 'unchanged'; }
    writeAssetAtomic(path, current.slice(0, a) + block + current.slice(b + end.length));
  }
  hashes[key] = installedHash(block);
  return 'updated';
}

// -3 / 0 / +1 style comparator over strict semver cores. Returns <0, 0, >0.
export function compareSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

// Highest strict `vX.Y.Z` tag in `git ls-remote --tags --refs` output. Anything else — a
// pre-release (`v1.0.0-rc1`), a date-like `v20250101`, a bare `1.2.3` — is ignored, so one
// hand-pushed experimental tag can never redirect every install and cron upgrade (KI-E52).
// Returns null when the output holds no strict release tag.
export function pickLatestReleaseTag(lsRemoteOutput) {
  const tags = String(lsRemoteOutput || '')
    .split('\n')
    .map((l) => (l.split('refs/tags/')[1] || '').trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  if (!tags.length) return null;
  return tags.sort(compareSemver)[tags.length - 1];
}
