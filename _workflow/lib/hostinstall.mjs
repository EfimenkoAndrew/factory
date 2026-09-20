// Host-install pure helpers (KI-O5 — controller-asset installation, SETUP.md § 3).
//
// Two concerns, both pure and injectable so `setup/init.mjs` and `setup/install.mjs` stay thin
// shells around selftest-covered logic (the pre-KI-O5 installers had ZERO behavioural coverage —
// only `bash -n` parse pins, see KI-E52's selftest block):
//
//   1. mergeOpencodeConfig  — deep-merges the factory's OpenCode controller policy (an
//      `instructions` entry + `permission` deny rules) into a HOST-OWNED `opencode.json`.
//      Claude/Copilot assets are whole FILES the factory owns end to end, so `copyTree`'s
//      byte-compare + `*.factory-new` no-clobber is enough for them. An OpenCode config is
//      different in kind: it is the host's own file, carrying the host's own model/provider/mcp
//      settings, so the factory has to merge INTO it rather than own it. Rule ORDER is load-
//      bearing — opencode evaluates the LAST matching permission pattern — so the factory's deny
//      rules are always re-appended at the END of each tool's rule object, never left wherever a
//      previous install happened to put them (a plain `{...host, ...factory}` spread keeps an
//      existing key in its ORIGINAL position, which would let a later broad host `git *` allow
//      silently outrank a factory deny; that is the whole reason this is a real function and not
//      an object spread at the call site).
//
//   2. pickLatestReleaseTag — the strict `vX.Y.Z` + semver-sort resolution `setup/install.sh`
//      does with `grep -E | sort -V`, ported so the Node installer cannot drift from it
//      (`sort -V` ranks `v1.0.0-rc1` ABOVE `v1.0.0` and a date-like `v20250101` above every real
//      release, which is why the bash side greps strict-semver FIRST — same posture here).
//
// Zero npm dependencies. Filesystem installation helpers use an explicit host root.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseOpenCodeVersion } from '../opencode/compatibility.mjs';

// The host paths an OpenCode project config can live at, in opencode's own resolution order.
// A `.jsonc` host file that does not parse as strict JSON is REFUSED by mergeOpencodeConfig
// rather than silently rewritten without its comments.
export const OPENCODE_CONFIG_CANDIDATES = ['.opencode/opencode.jsonc', '.opencode/opencode.json', 'opencode.jsonc', 'opencode.json'];

// Tools whose factory rules are patterned. `permission` also accepts a BARE string at the top
// level ("allow all"), which applies to EVERY tool — including ones the factory names no rules
// for (read/glob/grep/list/task/...). Promoting that to the per-tool object form would silently
// narrow the host's posture on those other tools, so mergeOpencodeConfig refuses it instead.
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
const ACTIONS = new Set(['allow', 'ask', 'deny']);
const FLAT_TOOLS = new Set(['todowrite', 'question', 'webfetch', 'websearch', 'doom_loop']);
const ruleObject = (value) => typeof value === 'string' ? { '*': value } : value || {};
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
//   fragment  opencode-assets/opencode.config.json (parsed)
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

export function opencodeMajor(version) {
  return parseOpenCodeVersion(version)?.configMajor ?? null;
}

export function selectOpencodeMajor(output, explicit) {
  if (explicit !== undefined && !['1', '2'].includes(explicit)) throw new Error('--opencode-version must be 1 or 2');
  const detected = opencodeMajor(output);
  if (output && !detected) throw new Error('unsupported OpenCode executable version; explicit selection cannot override an unrecognized runtime');
  if (explicit && detected && Number(explicit) !== detected) throw new Error('selected OpenCode version disagrees with the executable');
  return explicit ? Number(explicit) : detected;
}

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

export const installedHash = (body) => createHash('sha256').update(body).digest('hex');

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
