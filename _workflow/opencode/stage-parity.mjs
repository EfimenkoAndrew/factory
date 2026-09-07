// KI-E103 (2026-09-02) — the opencode/Copilot binding's STAGE-PARITY MANIFEST.
//
// This file is DATA, and it is load-bearing. `_workflow/lib/_selftest.mjs` cross-checks it against
// the real agent stages in `_workflow/factory.js` and the real dispatch sites in `runtime.mjs`
// (`lib/port-parity.mjs` does the extraction). Every canonical stage this port does not dispatch
// must appear below with a reason, or the selftest FAILS. Entries are also checked in reverse: an
// entry for a stage the port now dispatches, or for a stage factory.js no longer has, is reported
// as stale. The manifest therefore cannot rot into fiction the way `_workflow/opencode/README.md`'s
// prose gap-list did (it claimed a closed list of "documented fidelity gaps" that omitted ten real
// ones, and called two genuinely-drifted files "Verbatim" ports).
//
// Adding a stage to factory.js? You have exactly three options, and picking one is deliberate:
//   1. dispatch it in runtime.mjs's planNext/applyPhaseResults, or
//   2. implement it deterministically and record it in MECHANICAL below, or
//   3. record it in UNPORTED below with a real reason.
// There is no fourth option in which the suite stays green and the gap goes unrecorded.

// Stages canon runs as an AGENT that this port implements DETERMINISTICALLY instead. These are not
// deficiencies — a mechanical check reads the same disk the fold reads, with no agent self-report
// that can diverge from it (the exact divergence class KI-E10 and KI-E83 were both created to
// close). Where that makes the port strictly stronger than canon, the note says so.
export const MECHANICAL = {
  runner: 'cmdMech verify — runBuildTest() spawns the SAME unmodified verify/build-test.sh and parses it with lib/verify.mjs\'s own parsers (imported, not re-derived), then verdictFromParse gates build/targetedTest/suite. No runner agent can self-certify a verdict the transcript does not support.',
  'marker-probe': 'cmdMech verify — hasRealInfraMarker() greps the verify transcript for FACTORY::REALINFRA:: on disk and applies the same three outcomes as canon (BLOCKED when docker is absent, FAILED when a realInfra item has no marker, else proceed). KI-E10\'s guard is fully present; only its agent wrapper is not.',
  'comment-probe': 'cmdMech leftover — runCommentGate() calls lib/comment-scan.mjs findComments() directly. Canon routes the same deterministic linter through a haiku agent that reports counts verbatim with no judgment (KI-E59 explicitly has NO classify step), so removing the agent removes a relay, not a check.',
  'red-proof-probe': 'afterVerify (KI-E112) — parseRedRaw() re-reads verify-red-raw.txt from DISK through decodeTranscript, applying canon\'s exact contract including KI-L55\'s INVERTED verificationOnly polarity (a pinning test must PASS, exit 0). Canon routes the identical grep through a haiku relay; reading the file directly removes the relay, not the check, and cannot mis-transcribe it.',
  'rootcause-probe': 'afterVerify (KI-E112) — nonTestChanged(changedFiles(worktree)) applies the SAME lib/verify.mjs derivation the fold\'s P9 uses, gated identically (code items, never verificationOnly, only with a declared non-test touch-set). Canon uses a haiku relay over `build-test.sh rootcause`; this reads the same git state directly. Records mech:rootcause-touch, and announces SKIPPED on an unreadable worktree.',
};

// Stages that are GENUINELY ABSENT. Each one is a real guard canon applies and this port does not,
// so an item can pass here that canon would have failed. Listed with the evidence class it protects
// against so the cost of the gap is legible rather than implied.
export const UNPORTED = {
  'pack-hash-probe': 'KI-E139 (ported from a host-mount session) — canon can now SKIP re-running its expensive opus gate band on a relaunch, when a fresh content-hash of review-pack.md proves the reviewable diff is byte-identical to what a prior attempt already gated to a resolved GATED state (state/items/<id>/progress.json, KI-E137). This port has no equivalent: planNext/applyPhaseResults have no relaunch-reuse concept at all, so every relaunch here always re-pays the FULL gate band regardless of whether the diff changed. Cost of the gap: purely economic, not a correctness hole — a relaunched item here can never silently skip a review it should have gotten (the reuse only ever SKIPS an identical re-review, never substitutes for a real one), it just cannot avoid paying for one it already earned. Not ported because this runtime\'s phase-driven state machine has no notion of "prior attempt" progress to fast-forward from at all; adding one is a materially larger, separately-scoped change than adding a single stage.',
  'plan-feasibility-probe': 'KI-E142A (ported from a host-mount session) — canon inserts a whole new pre-implementation PLAN-REVIEW stage right after planning and before test-author: a mechanical feasibility check (does every file the plan names actually exist, or is it declared new?) that can hard-fail the item pre-band, before test-author/fixer/verify ever run, on a bounded-revision-and-still-broken plan. This port has no equivalent phase between its planning step and test-author dispatch. Cost of the gap: purely economic and a slightly later failure point, not a correctness hole — a plan built on a false premise here still gets caught downstream (plan-commitment-scan, or the gate band itself), just after paying for test-author + fixer + verify first, exactly the cost KI-E142A exists to avoid. Not ported because it is a materially larger, separately-scoped addition (a new stage with its own bounded-revision cycle, not an extension of an existing one — unlike KI-E142B, its sibling, which extends the ALREADY-present plan-commitment-scan and was ported in the same change for exactly that reason).',
  'plan-quality-probe': 'KI-E142A (ported from a host-mount session) — the second lens of the same new plan-review stage described under `plan-feasibility-probe` above (same entry, same reasoning): an LLM judgment call on plan coverage/edge-cases that only ever informs one bounded planner revision and NEVER hard-fails on its own even in canon (a deliberate asymmetry — see the KI-E142 KNOWN-ISSUES.md entry). Not ported for the same reason as its sibling lens.',
  'adjudicator:realinfra-override': 'KI-E143C (ported from a host-mount session) — canon routes a test-author-declared, reasoned realInfra-classification override (test.json.realInfraOverride) to the SAME already-ported adjudicator role used for gate-review dissent and plan-deviation ruling, instead of an automatic fail, when the graph\'s static needsRealInfra flag turns out wrong for the specific defect. This port\'s equivalent check (`afterVerify`\'s needsRealInfra block in runtime.mjs) is a SYNCHRONOUS deterministic check chained with several other guards immediately after it, not an async planNext/applyPhaseResults phase — routing to an agent call from inside it requires factoring the "rest of afterVerify" out into a resumable helper callable from both the normal fall-through AND a new adjudication-resumption phase, a materially more invasive restructuring than the plan-commitment-scan case (which was ALREADY phase-driven and only needed a new phase branch). Cost of the gap: purely economic — a reasoned, legitimate override here still just fails and requires a real Testcontainers test to be written, exactly the pre-KI-E143C behavior; it can never silently accept an override that should have been rejected, since it never accepts one at all. Not ported to avoid a rushed restructuring of a function with multiple chained deterministic guards.',
  'main-drift-probe': 'KI-E109/E144/E145 (ported from a host-mount session) — canon\'s ENTIRE main-tree-contamination-prevention mechanism (the KI-E50 mid-band `main-check` dispatch, host-policy-gated fail, and this probe that independently re-derives the verdict from the teed check output) has no equivalent anywhere in this port — `afterVerify`/`planNext` never call `driver.mjs main-check` at all (confirmed: zero matches for main-check/mainCheck in runtime.mjs), so a worktree that drifted mid-run is invisible to this runtime regardless of the `failLaneOnMainDrift` policy. This gap predates KI-E103\'s parity gate and was never previously named in this manifest — surfaced now only because the gate\'s own extractor now sees this role literal (added when KI-E145 replaced the KI-E144B self-report with this probe). Cost of the gap: the SAME class KI-E133/E136 already document (an agent write landing outside its worktree) goes undetected here until the driver\'s own fold-time KI-L65 check, one full band later than canon\'s pre-band catch. Not ported: a materially larger addition (needs the KI-E50 driver dispatch, the teed-file convention, AND this probe — not a single call site).',
};

export const STAGE_PARITY = { mechanical: MECHANICAL, unported: UNPORTED };

// Constants that MUST stay byte-identical between factory.js and this port's routing.mjs, because
// both runtimes make the same routing/gating decision from them and a divergence forks behaviour
// silently. This list is the direct remediation for KI-E97's drift going unnoticed: REALINFRA_SIGNAL
// had been narrowed in canon only, and for days both suites were green while the port demanded
// Testcontainers evidence for items whose text merely used the word "concurrent" in passing.
export const SHARED_CONSTANTS = ['REALINFRA_SIGNAL', 'BAND_FULL_THEMES'];
