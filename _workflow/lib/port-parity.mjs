// KI-E103 (2026-09-02) — RUNTIME-parity gate for the `_workflow/opencode/` binding (KI-O1/KI-O4).
//
// Why this exists. Before it, the ONLY mechanical cross-check between `factory.js` (canonical) and
// the port was SCHEMA parity (`opencode/_selftest.mjs`'s brace-scanning deep-equal). That gate is
// real, but it only fires when a change introduces a new `*_SCHEMA` const — and its own documented
// workaround is to export the schema with a `NOT yet ported` comment while omitting it from the
// `SCHEMAS` registry, which is exactly what happened three times (KI-E83, KI-E87, KI-E91). Anything
// with no schema surface was invisible: a new guard, a new `finish('FAILED')`, a re-ordered phase, a
// prompt-hint change, or a routing CONSTANT.
//
// The proof case is KI-E97. That entry narrowed `REALINFRA_SIGNAL`'s bare `concurren` catch-all after
// five live false-positive incidents and added hyphen-normalised separators — in `factory.js` only.
// The port kept the stale pattern for days with both suites fully green, because no gate anywhere
// compared the two copies. The stale copy made four real item shapes structurally UNCLOSABLE in the
// port (they demanded a Testcontainers marker their fix could not produce) while remaining closable
// in canon. That is a silent behavioural fork between two runtimes the README calls "the SAME
// contract" — precisely the silent-divergence failure mode KNOWN-ISSUES.md exists to prevent.
//
// The design follows the repo's own KI-E59 lesson (the owner's words: "MECHANISMS that prevent … not
// just more prompt rules"): this is a FORCING gate, not a reminder. Every agent stage in factory.js
// must be one of three things, and the third is a deliberate, reviewable act:
//   1. DISPATCHED by the port, or
//   2. declared MECHANICAL — replaced by a deterministic Node check (often STRONGER than the agent
//      it replaces, since a mechanical check has no self-report to diverge from disk), or
//   3. declared UNPORTED with a stated reason.
// Adding a stage to factory.js without doing one of those three FAILS the selftest. The gate also
// runs in reverse — a manifest entry naming a stage that is now dispatched, or that no longer exists
// in factory.js at all, is reported as stale, so the manifest cannot rot into fiction.
//
// Deliberately source-text based, mirroring `lib/routing-drift.mjs` (the KI-B1 gate this is modelled
// on): `factory.js` cannot be imported (KI-E2 — it is a Workflow script, not a module), so reading
// both files as text is the only mechanism available to compare them.

// Every agent stage in factory.js is invoked through the per-item `call(role, …)` closure. Role
// literals are extracted; dynamically-constructed roles (the gate band's `call(x.role, …)` and the
// review flows' `call(SKILL_ROLE[f.skill], …)`) are invisible to this scan BY DESIGN — the port
// constructs those the same dynamic way from the same shared tables, so there is no literal on
// either side to drift apart. What this catches is the class that actually bit: a NEW, explicitly
// named stage added to canon and silently never ported.
export function extractFactoryRoles(factorySrc) {
  const out = new Set();
  const re = /\bcall\(\s*'([a-z0-9][a-z0-9-]*)'/g;
  let m;
  while ((m = re.exec(String(factorySrc || ''))) !== null) out.add(m[1]);
  return out;
}

// The port names each dispatched role in its `planNext` step descriptors (`{ role: '<name>', … }`).
// `'gate-'` appears as a bare prefix literal because gate roles are built as `'gate-' + g`; it is
// filtered out here rather than in every caller, since it is a template fragment, not a role.
export function extractPortRoles(runtimeSrc) {
  const out = new Set();
  const re = /\brole:\s*'([a-z0-9][a-z0-9-]*)'/g;
  let m;
  while ((m = re.exec(String(runtimeSrc || ''))) !== null) { if (m[1] !== 'gate-') out.add(m[1]); }
  return out;
}

// Pull the single-line source of `const NAME = …` / `export const NAME = …`, normalised (the `export`
// prefix and a trailing `;` are style, not semantics — factory.js omits the semicolon, the port's
// modules use it). Returns null when absent or when the value spans multiple lines, so a caller can
// distinguish "drifted" from "not comparable this way" instead of silently reading a partial value.
export function namedConstantSource(src, name) {
  const m = String(src || '').match(new RegExp('^(?:export\\s+)?const\\s+' + name + '\\s*=\\s*(.+?);?\\s*$', 'm'));
  return m ? m[1].trim() : null;
}

// The forcing comparison. `manifest` is `{ mechanical: {role: why}, unported: {role: why} }`.
// Returns four independently-actionable buckets; an empty result in all four is parity.
export function parityGaps(factoryRoles, portRoles, manifest) {
  const mech = Object.keys((manifest && manifest.mechanical) || {});
  const unported = Object.keys((manifest && manifest.unported) || {});
  const declared = new Set([...mech, ...unported]);
  const fac = new Set(factoryRoles);
  const port = new Set(portRoles);
  return {
    // A canonical stage that is neither dispatched nor declared — the silent-fork class.
    undeclared: [...fac].filter((r) => !port.has(r) && !declared.has(r)).sort(),
    // Declared as not-dispatched, but the port DOES dispatch it — the manifest is lying (stale).
    staleDeclared: [...declared].filter((r) => port.has(r)).sort(),
    // Declared for a stage factory.js no longer has — dead manifest entry.
    deadDeclared: [...declared].filter((r) => !fac.has(r)).sort(),
    // Declared twice with contradictory meanings.
    doubleDeclared: mech.filter((r) => unported.includes(r)).sort(),
  };
}
