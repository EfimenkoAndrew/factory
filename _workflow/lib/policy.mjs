// Host-policy loader (PR#9 review fix — "policy universalization").
//
// The no-new-comments rule (KI-E57/KI-E59) and the no-DB/schema-changes hard stop (KI-E58) are
// HOST-OWNER directives, not universal engine truths: one host's owner mandated both; another host's
// own engineering rules REQUIRE certain comments (divergence call-site tags, dependency-justification
// comments, Arrange/Act/Assert test markers) and treats CLI-generated migrations as the canonical
// change mechanism. Baking either rule into the shared briefs/gates as an absolute breaks every other
// host, so both are host-config now:
//
//   config/factory.config.json          -> "policies": { "noNewComments": false, "noSchemaChanges": false }
//   config/factory.config.local.json    -> per-host gitignored overlay (KI-E17 seam) flips them on
//
// Shipped engine default: BOTH OFF (a public engine must not default to one owner's house rules).
// A host that wants the gates enables them in its local overlay — one time, per host. The driver
// prints the effective policy state at every `group`/`sweep` so an unset overlay is visible, never
// silent. Every enforcement layer keys off this single loader: factory.js probe + prompt injection
// (via runArgs.policies), the opencode runtime's mechanical gate, and driver fold's WARN backstop.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULTS = Object.freeze({ noNewComments: false, noSchemaChanges: false });

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Merge order: defaults <- committed config .policies <- local overlay .policies. Never throws;
// unknown keys ignored; non-boolean values coerced with !! so a "true" string still enables.
export function loadPolicies(factoryRoot) {
  const out = { ...DEFAULTS };
  for (const f of ['factory.config.json', 'factory.config.local.json']) {
    const p = join(factoryRoot, 'config', f);
    if (!existsSync(p)) continue;
    const cfg = readJsonSafe(p);
    const pol = cfg && cfg.policies;
    if (!pol || typeof pol !== 'object') continue;
    for (const k of Object.keys(DEFAULTS)) if (k in pol) out[k] = !!pol[k];
  }
  return out;
}

// One-line render for driver status output ("noNewComments=on noSchemaChanges=off").
export function renderPolicies(policies) {
  const p = { ...DEFAULTS, ...(policies || {}) };
  return Object.keys(DEFAULTS).map((k) => `${k}=${p[k] ? 'on' : 'off'}`).join(' ');
}

// The canonical HOST POLICY prompt blocks. Single source for the driver's recover prompts and the
// opencode compose; factory.js (sandboxed — cannot import) inlines byte-identical copies, and the
// selftest pins factory.js's source against these strings so the copies cannot drift.
export const POLICY_TEXT = Object.freeze({
  noNewComments: 'HOST POLICY — NO NEW COMMENTS (binding): this host forbids ANY new or reworded comment in any file your diff touches — no new `//`, `/* */`, XML-doc, markup, `#`, `--`, or `@* *@` comment lines, no exceptions. An edited pre-existing comment must be reverted to its exact original text; a byte-identical MOVED/re-indented comment line is fine. Rationale belongs in your summary/commit message, never the file. A deterministic linter (`build-test.sh comments`) enforces this before the gate band.',
  noSchemaChanges: 'HOST POLICY — NO DB/SCHEMA CHANGES (binding): this host forbids migrations and ANY persisted-schema change (new/renamed/removed table or column, even an additive nullable column on a shared entity). Implement the best fix within the EXISTING schema and record the residual gap in your summary as an accepted, documented trade-off — an expected bound, not a scope-stop.',
});
