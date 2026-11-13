// KI-E75 — research-phase gating. Pure, canonical copy of the eligibility check factory.js inlines
// byte-for-byte into routesFor() (KI-E2 — the Workflow runtime cannot import; the selftest pins the
// two shapes match). A doc-less target is the buildDocMap() (lib/promptpack.mjs) signal already used
// to populate the shared prompt prefix's DOC MAP: an empty map means none of doc/data-flows/<target>.md,
// <target>/CONTEXT.md, or <target>/AGENTS.md exist for this target — reused here as-is rather than
// inventing a second "does this repo have docs" detector.
export function shouldRunArchaeology({ policies, fixType, docMap }) {
  const archOn = !!(policies && policies.archaeology);
  const crit = fixType !== 'mechanical';
  const docLess = !(Array.isArray(docMap) && docMap.length);
  return archOn && crit && docLess;
}
