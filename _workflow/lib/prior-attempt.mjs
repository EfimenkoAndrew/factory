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
// matter what the real on-disk plan.md actually promised (the exact EGS-2-2 failure shape this
// feature exists to catch — just reachable through the relaunch path instead of the first-attempt
// path). Fix: `approach` below carries the raw plan.md TEXT (prose, not the planner's original
// structured field split) — hasPlanCommitmentLanguage's regex-based pre-filter doesn't care which
// field the text sits in, only that it can see the commitment language at all, so the whole
// document is a strictly better input than the two narrower fields a fresh planner call would have
// split it into.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function freshFile(dir, name, sinceMs) {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    if (sinceMs && statSync(p).mtimeMs < sinceMs) return null; // stale — from a prior cycle's attempt, not this one
    return p;
  } catch { return null; }
}

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Pure-ish (one fs read pass, no writes): given an item's state/items/<id>/ dir and its CURRENT
// claim timestamp (ms since epoch — artifacts older than this are a stale prior attempt, never
// reused), return { plan, test, fix }, each either the reused object or null. Never throws.
export function loadPriorAttempt(itemDir, sinceMs) {
  const out = { plan: null, test: null, fix: null };
  try {
    const testPath = freshFile(itemDir, 'test.json', sinceMs);
    const test = testPath ? readJsonSafe(testPath) : null;
    if (test && typeof test === 'object') out.test = test;

    const fixPath = freshFile(itemDir, 'fix.json', sinceMs);
    const fix = fixPath ? readJsonSafe(fixPath) : null;
    if (fix && typeof fix === 'object') out.fix = fix;

    // plan reuse requires BOTH plan.md on disk AND test.json successfully reused (the proof that
    // the planner did not scope-stop/escalate) — never inferred from test.json alone without the
    // file itself also being present, so a missing plan.md still forces a fresh (cheap) plan call.
    const planPath = freshFile(itemDir, 'plan.md', sinceMs);
    if (out.test && planPath) {
      let planText = '';
      try { planText = readFileSync(planPath, 'utf8'); } catch { /* best-effort — empty text still gates the plan-commitment probe off safely (fail-open) */ }
      out.plan = { recommendScopeStop: false, recommendEscalate: false, approach: planText };
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
