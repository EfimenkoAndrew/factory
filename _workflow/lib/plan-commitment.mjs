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

// KI-E101 (2026-09-02) — STEP mode for the same probe. `hasPlanCommitmentLanguage` above is a
// COARSE prose gate: it decides only "does this plan contain SOME checkable promise at all", and the
// haiku probe then has to FIND the commitments in free text before it can judge them. That works
// (it caught the origin session's brownfield-note drift) but it is entirely dependent on the planner
// happening to phrase a commitment with "MUST"/"required to" — a plan that describes the same work
// as plain narrative prose is invisible to it, so the plan-vs-diff axis silently does not run at all.
//
// This function is the structured half: when the planner returns an explicit `steps[]` (the new
// optional PLAN_SCHEMA field), the work is ALREADY decomposed into individually checkable units and
// the probe can check coverage step-by-step — the same shape `splitAcceptanceClauses` gives the
// KI-E18 AcceptanceScan, which is the proven, in-production version of exactly this check on the
// acceptance axis. No prose parsing, no phrasing dependency, and each gap the probe reports names a
// specific step rather than a quoted prose fragment.
//
// Deliberately NOT a decomposition of EXECUTION: the fixer still implements the whole item in one
// call, with one whole-diff view. That is load-bearing, not incidental — `agents/fixer.md`'s
// SIBLING-PATTERN SWEEP (KI-E94), DEAD-CODE SELF-CHECK (KI-E94), ADJACENT-CLAIM RE-CHECK (KI-E95)
// and CANCELLATIONTOKEN CHAIN SELF-CHECK (KI-E96) are all whole-item, cross-file consistency checks
// that a worker holding only its own slice structurally cannot perform, and "fix-introduced defects"
// (KI-E51) is the #1 rejection class those checks exist to fight. Steps buy COVERAGE checking; they
// must never buy partitioned implementation.
//
// Normalization rules, and why each one:
//  - non-array / non-string entries are skipped, never thrown on (a malformed plan degrades to
//    PROSE mode, the pre-KI-E101 behaviour, rather than sinking the item — the same fail-open
//    posture as every sibling probe).
//  - a hand-written leading ordinal/bullet is stripped so the probe's own numbering does not render
//    as "1. 1. …"; planners write both shapes and neither should change what is checked.
//  - dedupe is case-insensitive: a repeated step would otherwise inflate the gap count and spend
//    probe budget re-judging the same unit.
//  - the length floor is 12, NOT splitAcceptanceClauses' 20. That splitter's floor discards
//    PUNCTUATION NOISE from mechanically splitting a sentence; an entry in this array is an
//    explicitly authored unit of work, so the same floor would silently drop a genuine short step
//    ("Update the dataflow doc" is 22, but "Wire the DI seam" is 16 and "Add the null guard" is 18 —
//    all real). 12 still discards a stub/placeholder entry. Dropping a step is a SILENT MISS, which
//    is the precise failure class this whole entry exists to close, so the floor errs low.
//  - the tail MERGES into the last kept step rather than being sliced away (mirroring
//    splitAcceptanceClauses exactly) — over the cap, every step still reaches the probe, because a
//    silently-unchecked step is worse than a slightly denser final line.
//
// The factory.js copy is INLINED byte-for-byte (the Workflow runtime cannot import) — change both
// copies together; the selftest pins their parity.
export function normalizePlanSteps(steps, cap) {
  if (cap === undefined) cap = 8
  if (!Array.isArray(steps)) return []
  const seen = new Set()
  const out = []
  for (let i = 0; i < steps.length; i++) {
    if (typeof steps[i] !== 'string') continue
    const s = steps[i].replace(/\s+/g, ' ').trim().replace(/^(?:[-*\u2022]|\(?\d{1,2}[.)])\s+/, '').trim()
    if (s.length < 12) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  if (out.length <= cap) return out
  return out.slice(0, cap - 1).concat(out.slice(cap - 1).join('; '))
}
