// Cross-session prior-attempt artifact reuse (KI-E69). A killed Workflow run's per-stage artifacts
// (plan.md, test.json, fix.json) are ALREADY durably written to state/items/<id>/ the moment each
// role completes (agents/{planner,test-author,fixer}.md each instruct "WRITE state/items/{id}/X" —
// independent of the KI-L40 end-of-item result.json checkpoint, which only fires if the item's
// WHOLE lifecycle resolves). Before this, the sanctioned relaunch ("relaunch the same run-script
// verbatim", SKILL.md § Recovery) re-ran plan -> test-author -> fixer from scratch for EVERY
// relaunch candidate regardless of how much of that already-expensive generative work was sitting
// on disk, complete and untouched, in the item's own worktree (witnessed live 2026-08-03: a
// 12-item stuck batch included items with 50/42/32 real changed files already in their worktrees).
//
// Scope, deliberately narrow: ONLY plan/test/fix are eligible for reuse. verify.json is NOT —
// investigated and found unsafe: its on-disk shape (a rich, audit-detail JSON the runner brief
// encourages) does not reliably match the plain-string shape runItem() reads (`verify.build`/
// `verify.targetedTest` are simple pass/fail strings in the schema the code depends on, but were
// found as nested {result,errors,...} objects in a real on-disk verify.json — String() coercion on
// that shape reads as "[object Object]", silently failing a genuinely-passing build). Re-running
// verify fresh is cheap (one build+test invocation) and is also the safety net that independently
// re-confirms the reused fix still builds/passes on THIS worktree. Everything from the editorial
// pass onward (editorial, edge-scan, acceptance-scan, the gate band, refute, reaudit, integrate)
// ALWAYS re-runs fresh, unconditionally — this preserves the existing, explicitly-stated design
// principle that gates re-adjudicate the worktree on every relaunch (SKILL.md § Recovery); this
// module never touches that.
//
// plan.md is prose, not JSON — there is no durable record of the planner's own structured fields.
// But if test.json ALSO exists (proving the run proceeded past planning — either flag would have
// short-circuited runItem() before ever reaching test-author), reusing recommendScopeStop/
// recommendEscalate as {false, false} is provably correct, not a guess: a relaunch only reaches
// this reuse path when neither flag fired the first time.
//
// Fix (multi-lens review, 2026-08-25, ported from the origin host-mount session): runItem() ALSO
// reads plan.approach/plan.blastRadius (the PLAN-COMMITMENT SCAN's input text) — a fact this module
// predates. The stub used to omit both fields entirely, so hasPlanCommitmentLanguage('' + '\n' + '')
// was always false and the scan silently, permanently never fired for ANY relaunched item, no
// matter what the real on-disk plan.md actually promised (the exact prior-item failure shape this
// feature exists to catch — just reachable through the relaunch path instead of the first-attempt
// path). Fix: `approach` below carries the raw plan.md TEXT (prose, not the planner's original
// structured field split) — hasPlanCommitmentLanguage's regex-based pre-filter doesn't care which
// field the text sits in, only that it can see the commitment language at all, so the whole
// document is a strictly better input than the two narrower fields a fresh planner call would have
// split it into.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { phantomManifest } from './verify.mjs'; // KI-E474 — content proof beats a clock
import { join } from 'node:path';

// KI-E474: `proven` is the CONTENT escape hatch on the time fence. The mtime rule alone made
// cross-claim resume impossible: `resume --reset-stale` + a fresh `group` stamps a NEW CLAIMED
// transition NOW, so every artifact the killed run left on disk is older than `sinceMs` and reads as
// stale — even though nothing touched the worktree and the work is demonstrably still sitting in it.
// Live case (2026-09-02 pause): 16 items were re-queued carrying real diffs (one item 12 changed
// files, another 7, a third 5) and every one of them would have re-run planner + test-author +
// fixer from scratch. A timestamp is a PROXY for "does this artifact still describe reality"; the
// worktree diff is the thing itself. When the caller can prove the described work is still present,
// that proof wins over the clock — it is strictly stronger, and it cannot resurrect work that is
// gone, because absence of the files IS the disproof.
// KI-E474: cap on reused plan prose inlined into the batch — see the slice below for why.
export const PLAN_REUSE_CAP = 6000;

function freshFile(dir, name, sinceMs, proven) {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    if (proven) return p;
    if (sinceMs && statSync(p).mtimeMs < sinceMs) return null; // stale — from a prior cycle's attempt, not this one
    return p;
  } catch { return null; }
}

// KI-E474 — is the work an artifact CLAIMS still present in the live worktree diff? `changed` is the
// worktree's real changed-file list (the caller reads it; this module stays fs-light). Reuses
// KI-E471's phantomManifest so "still there" is decided by exactly one rule everywhere. A claim of
// NO files proves nothing either way -> not proven (fall back to the clock).
export function workTreeProves(changed, claimedFiles) {
  if (!Array.isArray(changed) || !changed.length) return false;
  if (!Array.isArray(claimedFiles) || !claimedFiles.length) return false;
  return phantomManifest(changed, claimedFiles).length === 0;
}

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Pure-ish (one fs read pass, no writes): given an item's state/items/<id>/ dir and its CURRENT
// claim timestamp (ms since epoch — artifacts older than this are a stale prior attempt, never
// reused), return { plan, test, fix }, each either the reused object or null. Never throws.
// `isReFix` — see KI-E158(i) below.
export function loadPriorAttempt(itemDir, sinceMs, changed, isReFix) {
  const out = { plan: null, test: null, fix: null, provenBy: [] };
  // KI-E158(i) (2026-09-12, a prior item incident): a killed-run recovery and a REJECTED-attempt re-fix
  // are NOT the same situation, but this function used to treat them identically. `isReFix` is the
  // caller's `['FAILED','CONFLICT'].includes(ledger state)` test — the SAME flag that drives
  // factory.js's item.reFix / reFixNote ("read feedback.md, the prior fix was rejected, CORRECT it")
  // — and it means the LAST attempt reached a real, completed verdict and was REJECTED, not that the
  // run died mid-flight. Reusing test.json/fix.json in that case resurrects the EXACT artifacts
  // review just rejected, verbatim, and skips the fixer/test-author call entirely (KI-E69's whole
  // mechanism), so reFixNote's correction guidance never reaches any agent. Live cost: a prior item
  // (cycle 95) — review:testarch-test-review correctly HIGH/blocking-rejected 3 of 6 new tests as
  // vacuous — the very next attempt reused the IDENTICAL, untouched test.json (dated from attempt 1,
  // Sep 7) because KI-E474's own worktree-diff proof still found its claimed files present — the
  // rejected test was never rewritten, and a LATER independent review pass (review-edgecase.md)
  // rediscovered and widened the SAME finding, burning a full gate-battery twice for a defect nobody
  // ever got a chance to actually fix. Fix: when the caller tells us this is a reFix, test/fix reuse
  // is unconditionally disabled — the fixer/test-author MUST run fresh, with feedback.md in hand, so
  // the rejection has an actual chance of being corrected instead of replayed. Plan reuse needs no
  // separate carve-out: it falls out disabled too, via the existing `passedPlanning = !!(out.test ||
  // out.fix)` gate below, at the small, deliberate cost of one extra planner call per reFix item —
  // strictly safer than the alternative, never the reverse.
  if (isReFix) return out;
  try {
    // KI-E474: read each artifact's own claim FIRST, so the content proof can be evaluated per
    // artifact — a fix whose files are all still in the diff is reusable even across claims, while a
    // test whose files are gone is not, and the two are decided independently.
    const rawFix = readJsonSafe(join(itemDir, 'fix.json'));
    const rawTest = readJsonSafe(join(itemDir, 'test.json'));
    const fixProven = workTreeProves(changed, rawFix && rawFix.filesChanged);
    const testProven = workTreeProves(changed, rawTest && rawTest.testFiles);

    // KI-E158(ii) (a live item, cycle 95): a REPLAN — a fresh plan.md written after test.json/
    // fix.json already exist, e.g. this item's own cycle-96 redesign that explicitly deleted
    // TryGetOptionalDecimalFromJsonElement — supersedes whatever test/fix were authored against the
    // OLDER plan. `workTreeProves`'s content-proof only answers "are these exact claimed files still
    // in the diff", a different question from "do they still match the CURRENT plan's design": a
    // stale test/fix can pass the content-proof and still describe an approach the plan no longer
    // takes. A plan.md strictly newer than test.json/fix.json is a cheap, unambiguous, mechanical
    // signal that the design underneath them changed since they were written — neither the mtime
    // fence nor the content-proof bypass should let a pre-replan artifact through in that case.
    let planMs = null;
    try { planMs = statSync(join(itemDir, 'plan.md')).mtimeMs; } catch { /* no plan.md yet -> no fence */ }
    const predatesReplan = (name) => {
      if (planMs === null) return false;
      try { return statSync(join(itemDir, name)).mtimeMs < planMs; } catch { return false; }
    };
    const testPredatesReplan = predatesReplan('test.json');
    const fixPredatesReplan = predatesReplan('fix.json');

    // KI-E124 (live-caught, cycle 81): an artifact is only worth continuing from if it records its
    // own SUCCESS. Reuse used to accept any well-formed JSON, so a test.json with no `red: true` —
    // the shape a PRIOR FAILED attempt leaves behind — was carried forward into a run that then hit
    // factory.js's `if (!test.red && !verificationOnly) return finish('FAILED', 'no red proof')` and
    // died in seconds, having burned a claim to reproduce a known failure with zero new information.
    // Measured cost: 4 of 14 items in cycle 81 — every one had `red` ABSENT,
    // while every item that got past the red gate had `red: true`. Continuing must mean carrying
    // work FORWARD, never carrying a failure forward; an unusable artifact re-runs its stage fresh,
    // which is the outcome that at least has a chance of succeeding.
    const testUsable = (t) => !!t && typeof t === 'object' && (t.red === true || t.verificationOnly === true);
    const fixUsable = (f) => !!f && typeof f === 'object' && f.applied === true;

    const testPath = testPredatesReplan ? null : freshFile(itemDir, 'test.json', sinceMs, testProven);
    const test = testPath ? readJsonSafe(testPath) : null;
    if (testUsable(test)) { out.test = test; if (testProven) out.provenBy.push('test:worktree'); }

    const fixPath = fixPredatesReplan ? null : freshFile(itemDir, 'fix.json', sinceMs, fixProven);
    const fix = fixPath ? readJsonSafe(fixPath) : null;
    if (fixUsable(fix)) { out.fix = fix; if (fixProven) out.provenBy.push('fix:worktree'); }

    // KI-E476 (live-caught 2026-09-02, owner: "why is the replanning happening??? plan already
    // exists"): plan reuse used to require `out.test` — the test artifact being successfully REUSED.
    // That coupling is wrong twice over.
    //   (a) It is the wrong PROOF. The stub fills recommendScopeStop/recommendEscalate as
    //       {false,false}, and the thing that justifies it is "the run got PAST planning without
    //       either flag firing". test.json EXISTING proves that. So does fix.json — in fact more
    //       strongly, since a fixer cannot run before a planner. Requiring the test to be *reusable*
    //       conflated "did planning complete?" with "is the test still valid?", two unrelated facts.
    //   (b) It is the wrong FENCE. A plan is an artifact of THINKING, not of editing, so asking the
    //       worktree diff to prove it is a category error: KI-E474 correctly gates diff-describing
    //       artifacts (fix/test) on the diff, but a plan describes intent and has no files to find.
    // Live cost: three sibling items each had plan.md AND test.json AND
    // fix.json sitting on disk and re-ran the fable-5 planner anyway, because their TEST was not
    // diff-provable (a sibling item's testFiles points at state/items/<id>/regression-test.sh — an item-dir
    // path that can never appear in a worktree diff).
    // Safety is unchanged and comes from the CALLER: cmdGroup skips reuse entirely for an item whose
    // worktree holds no diff, so a plan from a genuinely stale cycle (worktree recreated/reset) is
    // never reachable here in the first place.
    // The proof must be a later-stage artifact that is ITSELF reusable, not merely present on disk.
    // A first pass at this used bare existence (`rawTest || rawFix`) and promptly broke the KI-E69
    // stale guard: a test.json from an OLD cycle proves THAT cycle's planning completed, which says
    // nothing about whether this plan still matches the work in the tree. Freshness stays required;
    // only the ARTIFACT SET widens, test -> test-or-fix. That is the whole defect: a fixer cannot run
    // before a planner, so a reusable fix is at least as good a proof as a reusable test.
    const passedPlanning = !!(out.test || out.fix);
    const planPath = freshFile(itemDir, 'plan.md', sinceMs, testProven || fixProven);
    if (passedPlanning && planPath) {
      let planText = '';
      try { planText = readFileSync(planPath, 'utf8'); } catch { /* best-effort — empty text still gates the plan-commitment probe off safely (fail-open) */ }
      // KI-E474 follow-up (live, 2026-09-02): plan.md is PROSE and can be large — 21-23KB each for
      // two sibling items. Inlining it verbatim for every reused item pushed the emitted launcher
      // script to 558KB, past the Workflow channel's 512KB cap, so the batch could not launch at
      // all: a reuse mechanism that makes the run un-launchable is worse than no reuse. Capped the
      // same way KI-E60 caps repo-profile text (PROFILE_CAP) — the reused plan feeds the
      // plan-commitment scan's `approach`/`blastRadius` text, which needs the planner's stated
      // intent, not its full prose. Head-biased: a plan states its approach up front.
      out.plan = { recommendScopeStop: false, recommendEscalate: false, approach: planText.slice(0, PLAN_REUSE_CAP) };
    }
  } catch { /* best-effort — a read failure just means no reuse, never a crash */ }
  return out;
}

// Summary for logging/telemetry — which stages a loaded prior attempt actually covers.
export function priorAttemptStages(pa) {
  const stages = [];
  if (pa && pa.plan) stages.push('plan');
  if (pa && pa.test) stages.push('test');
  if (pa && pa.fix) stages.push('fix');
  return stages;
}

// KI-E496 (2026-09-14) — stepwise partial-progress resume. `loadPriorAttempt` above only ever knows
// how to reuse a COMPLETE, consolidated fix.json — and unconditionally disables ALL reuse for a
// reFix item (KI-E158(i)), because that guard exists to stop a REVIEW-REJECTED fix.json/test.json
// from being resurrected verbatim. Neither of those facts is true for a stepwise fixer (KI-E470)
// that fails PARTWAY THROUGH its own per-step sequence: the per-step artifacts (fix-step-N.json) are
// never consolidated into fix.json at all when a later step halts, so loadPriorAttempt has nothing to
// find; and when the halt happens BEFORE the item ever reaches a real review gate, nothing has been
// "rejected" — the earlier steps are simply unreviewed, mechanically-verified-correct work sitting
// unused in the worktree. Live incident this closes: a real item (cycle 101 then 102) — steps 1-6 of
// a 7-step plan landed correctly both times, only the LAST step hit a KI-E493 write-isolation
// mismatch, and the sanctioned relaunch re-authored all 6 already-correct steps from scratch (plus a
// full re-plan, since plan reuse is coupled to test/fix reuse) purely because nothing distinguished
// "failed before review ever saw it" from "review rejected it".
//
// Content-proof only (no separate mtime fence, matching KI-E474's own established reasoning that a
// worktree-diff proof is STRONGER than a clock): a step counts as resumable when it (a) does not
// exist at all -> stop, the resume point is everything proven so far; (b) exists, is NOT a scopeStop,
// and claims applied:true; and (c) either claimed NO files (a legitimate "already satisfied by an
// earlier step" answer the stepwise prompt explicitly allows) or every claimed file is STILL present
// in the CURRENT worktree diff (workTreeProves, the same predicate KI-E474 already trusts). The ONE
// mtime check that DOES apply: a step whose own file predates the CURRENT plan.md is from a
// SUPERSEDED plan (KI-E158(ii)'s exact "a fresh replan invalidates older artifacts" reasoning) — its
// step semantics may no longer correspond to anything in the new plan, so it is never resumable
// either, even if its content-proof would otherwise pass.
//
// KI-E497 — a step's on-disk fix-step-N.json is written FREEHAND by the fixer agent as a prose-
// instructed side effect (factory.js has no filesystem access to write it deterministically from
// the schema-validated call result — see factory.js's own "no filesystem" constraint); nothing
// enforces the file actually mirrors FIX_SCHEMA. Live evidence, that same item's cycle 102 step 4/7:
// the agent wrote {"step":4,"action":"insert_standards_evolution_tag","file":"...","status":
// "completed"} instead of the instructed {applied,scopeStop,summary,filesChanged} shape — content
// independently confirmed CORRECT in the live worktree diff (the exact migration file, the exact
// line), but unreadable to a strict `step.applied !== true` check, which cost that run 3 wasted
// re-fixer calls (steps 4-6, ALL already correct, all re-authored from scratch on the next cycle).
// Recognizes the ONE synonym shape observed in the wild as an ADDITIONAL path to the SAME
// content-proof gate below — workTreeProves against the live diff remains the actual safety check
// for both paths; this only widens what is worth content-checking, never what is trusted without
// checking. Returns null (not resumable) for anything that satisfies neither shape.
function stepOutcome(step) {
  if (!step || step.scopeStop) return null;
  if (step.applied !== true && step.status !== 'completed') return null;
  const files = Array.isArray(step.filesChanged) ? step.filesChanged : (typeof step.file === 'string' ? [step.file] : []);
  return { files };
}

// Returns null when zero steps are provably resumable (the caller falls back to a cold stepwise
// start, unchanged from before this function existed) — never throws.
export function loadStepwiseResume(itemDir, changed) {
  let planMs = null;
  try { planMs = statSync(join(itemDir, 'plan.md')).mtimeMs; } catch { /* no plan.md yet -> no fence; a stepwise fixer never runs without one anyway */ }
  const touched = {};
  const done = [];
  let i = 0;
  try {
    for (; ; i++) {
      const p = join(itemDir, 'fix-step-' + (i + 1) + '.json');
      let stepMs = null;
      try { stepMs = statSync(p).mtimeMs; } catch { break; } // no such file -> stop here, this is the resume point
      if (planMs !== null && stepMs < planMs) break; // KI-E158(ii): predates the current plan -> superseded, do not resume past it
      const step = readJsonSafe(p);
      const outcome = stepOutcome(step);
      if (!outcome) break;
      const files = outcome.files;
      if (files.length && !workTreeProves(changed, files)) break;
      for (const f of files) touched[f] = true;
      done.push((i + 1) + '. ' + (step.summary || step.title || step.action || '(no summary)'));
    }
  } catch { return i > 0 ? { resumeFromIndex: i, touched, done } : null; } // best-effort — whatever was proven before the read failure is still valid
  return i > 0 ? { resumeFromIndex: i, touched, done } : null;
}

// KI-E496 — the safety gate on loadStepwiseResume: resuming per-step CONTENT is only safe when NO
// real adversarial review has ever weighed in on this item, across its entire history. `row.gates`
// accumulates every gate/review key this item has ever recorded (it is never reset between fold
// cycles); the pre-band probes this file's factory.js counterpart runs (probe:*) do not count — only
// an actual `gate:` role verdict or a `review:` BMAD-flow verdict means a real adversarial pass judged
// this item's content and could have rejected something a later step's "proven by the worktree diff"
// check would otherwise happily resume from (KI-E158(i)'s exact concern, one layer down).
export function neverGateReviewed(row) {
  const gates = (row && row.gates) || {};
  return !Object.keys(gates).some((k) => k.startsWith('gate:') || k.startsWith('review:'));
}
