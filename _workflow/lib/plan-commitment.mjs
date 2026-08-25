// KI-E87 (2026-08-24, ported from a host-mount session) — PlanCommitmentScan: deterministic
// pre-filter for explicit self-imposed commitment language in a planner's free-text
// `approach`/`blastRadius` fields. Origin evidence (a host-mount session's own cycle-70 batch): an
// item burned a FULL band (editorial x2, gate:architect, gate:developer, gate:qa,
// review:code/adversarial/edgecase/testreview, refuter) before the re-auditor — the LAST stage in
// the pipeline — caught that `plan.md` explicitly said "**MUST include the brownfield note**" while
// the delivered diff never included it. Every earlier stage reviews the DIFF against the ITEM's
// acceptance criteria (KI-E18) or general code quality; none of them cross-checks the diff against
// the PLANNER's OWN stated commitments, so a plan/execution drift is invisible until the re-audit's
// holistic pass, at full band price.
//
// This is the deterministic half of the KI-E18/KI-D12 pattern applied to that failure class: detect
// whether the plan text contains a CHECKABLE hard commitment ("MUST", "must include/add/...",
// "required") at all — most plans are pure description with nothing to verify against the diff, so
// this gate exists to avoid spending a haiku probe call on the common case. When it fires, a cheap
// haiku probe in factory.js reads the commitment language + the diff and answers "is every commitment
// honored?" BEFORE the gate band. A malformed/unavailable probe never sinks an item (fail-open,
// mirroring AcceptanceScan/LeftoverScan).
//
// Deliberately NOT a full clause splitter like splitAcceptanceClauses — commitment language in free
// prose is sparse and irregular (unlike the acceptance field, which IS the clause list), so a coarse
// "does this text contain commitment language at all" gate is more robust than trying to mechanically
// extract each commitment; the haiku probe itself finds and judges the specific commitments once
// gated in, which suits an LLM's holistic reading better than a brittle regex extraction would.
//
// The factory.js copy is INLINED byte-for-byte (the Workflow runtime cannot import) — change both
// copies together; the selftest pins their parity.
//
// The `[\s-]+` separator (not bare `\s+`) is a same-origin-session refinement, already folded in
// here: a hyphenated title-case compound ("Must-cover checklist") defeats both the all-caps-only
// bare check and a whitespace-only "must + verb" pattern — proven live in the origin session against
// the exact specimen text before widening the separator.
//
// Fix (multi-lens review, 2026-08-25, ported from the origin host-mount session): the "must + verb"
// pattern was a CLOSED 14-word verb allowlist. Independently verified against 14 realistic
// commitment sentences a planner would actually write ("the fix must verify the tenant claim", "the
// handler must implement retry with backoff", "the diff must set the Status field to Approved", …)
// — 13 of 14 were silently missed, because none of their verbs happened to be on the list the two
// known incidents produced. Since this function is the SOLE gate deciding whether the probe runs at
// all, every miss meant zero plan-vs-diff cross-check — the exact EGS-2-2 failure class, one verb
// away. Widened to `\bmust[\s-]+\w+` (any word, not a fixed list): the pre-filter's job is only to
// decide "does this text contain SOME checkable commitment at all" — the haiku probe does the actual
// judgment — so a broader net costs at most one extra cheap, bounded probe call on a false-trigger,
// never a wrong FAILURE. "mustache"/"mustard" still correctly never match (zero separator between
// "must" and the following letters). "must-have widgets" now matches too (previously an explicit
// negative case) — accepted: a planner writing "must-have X" is unusual, and if it appears is far
// more likely to be a genuine borderline commitment worth one cheap look than a false alarm.
export function hasPlanCommitmentLanguage(text) {
  if (!text || typeof text !== 'string') return false
  if (/\bMUST\b/.test(text)) return true
  if (/\bmust[\s-]+\w+/i.test(text)) return true
  if (/\bis\s+required\s+to\b|\brequired\s+to\s+\w+/i.test(text)) return true
  return false
}
