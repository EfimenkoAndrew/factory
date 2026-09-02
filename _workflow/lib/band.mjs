// KI-E88 (2026-08-24, ported from a host-mount session) — driver-side port of factory.js's
// bandFor(): LIGHT vs FULL review-band classification, needed by the PICKER/BATCHER (driver.mjs
// `suggest`) so batch composition can be COST-aware, not just item-count-aware. A FULL-band item
// runs the full 5-gate opus panel (architect/security/po + developer/qa) plus an opus-routed
// planner/testAuthor/fixer, a LIGHT item skips 3 of those 5 gates and the planner entirely.
//
// factory.js's `bandFor` is the CANONICAL definition (it drives the actual routing decision inside
// the Workflow runtime, which cannot import — see lib/README-equivalent KI-E2 note); this file is a
// byte-identical PORT for driver-side (Node, can import) DISPLAY/PICKING use only — it never drives
// an actual run, only informs what a human/controller sees before choosing a batch. Change both
// copies together; the selftest pins their parity.
export const BAND_FULL_THEMES = ['security-multitenancy', 'money-correctness', 'idempotency-dataflow', 'concurrency']

export function bandFor(item) {
  if (item.band === 'LIGHT' || item.band === 'FULL') return item.band
  // THEME DOMINATES fixType/severity (review P5): a security / money / concurrency / idempotency item ALWAYS
  // gets the full rigorous band (security + architect gates, multi-lens re-audit, adjudicator) — a "mechanical"
  // authz / HMAC / tenant-filter edit is still a security change whose load-bearing reviewer must NOT be dropped.
  if (BAND_FULL_THEMES.indexOf(item.theme) >= 0) return 'FULL'
  if (item.theme === 'doc-drift' || item.fixType === 'mechanical') return 'LIGHT'
  return 'LIGHT'
}
