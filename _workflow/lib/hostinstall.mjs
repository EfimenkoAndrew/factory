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
// Zero npm dependencies. No filesystem, no process, no git — every input is passed in.

// The host paths an OpenCode project config can live at, in opencode's own resolution order.
// A `.jsonc` host file that does not parse as strict JSON is REFUSED by mergeOpencodeConfig
// rather than silently rewritten without its comments.
export const OPENCODE_CONFIG_CANDIDATES = ['opencode.jsonc', 'opencode.json', '.opencode/opencode.json'];

// Tools whose factory rules are patterned. `permission` also accepts a BARE string at the top
// level ("allow all"), which applies to EVERY tool — including ones the factory names no rules
// for (read/glob/grep/list/task/...). Promoting that to the per-tool object form would silently
// narrow the host's posture on those other tools, so mergeOpencodeConfig refuses it instead.
const PATTERNED_TOOLS = ['bash', 'edit'];

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

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
  for (const [k, v] of Object.entries(factoryRules)) out[k] = v;
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
export function mergeOpencodeConfig(hostCfg, fragment) {
  const host = isPlainObject(hostCfg) ? hostCfg : {};
  const notes = [];

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
  if (host.permission !== undefined && !isPlainObject(host.permission)) {
    return { config: host, changed: false, notes: [], refused: 'host permission is neither an object nor a string' };
  }

  const out = { ...host };

  // $schema is additive and purely an editor aid — only ever filled in when absent.
  if (!out.$schema && fragment.$schema) { out.$schema = fragment.$schema; notes.push('added $schema'); }

  if (Array.isArray(fragment.instructions) && fragment.instructions.length) {
    const merged = appendInstructions(out.instructions, fragment.instructions);
    const added = merged.filter((e) => !(out.instructions || []).includes(e));
    if (added.length) { out.instructions = merged; notes.push('instructions += ' + added.join(', ')); }
    else if (!out.instructions) { out.instructions = merged; }
  }

  if (isPlainObject(fragment.permission)) {
    const perm = { ...(out.permission || {}) };
    for (const tool of PATTERNED_TOOLS) {
      const factoryRules = fragment.permission[tool];
      if (!isPlainObject(factoryRules)) continue;
      // `permission.<tool>: "allow"` is documented shorthand for `{"*": "allow"}` — promoting it
      // is exactly equivalent (unlike the top-level bare string above), so it is safe here.
      let hostRules = perm[tool];
      if (typeof hostRules === 'string') { hostRules = { '*': hostRules }; notes.push(tool + ': expanded the "' + perm[tool] + '" shorthand to {"*": "' + perm[tool] + '"}'); }
      else if (!isPlainObject(hostRules)) hostRules = {};
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
  }

  return { config: out, changed: JSON.stringify(out) !== JSON.stringify(host), notes, refused: null };
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
