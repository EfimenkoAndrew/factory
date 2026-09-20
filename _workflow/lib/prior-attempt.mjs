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
// Planner control fields are reused only from structured progress checkpoints. Reaching test-author
// does NOT prove recommendEscalate=false: the human-signoff stop happens after re-audit.
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
// `isReFix` — see KI-E158(i) below.
export function loadPriorAttempt(itemDir, sinceMs, isReFix) {
  const out = { plan: null, test: null, fix: null };
  // KI-E158(i) (ported from a host-mount session) — a killed-run recovery and a REJECTED-attempt
  // re-fix are NOT the same situation, but this function used to treat them identically. `isReFix`
  // is the caller's reFix flag (a real, completed review verdict REJECTED the last attempt) — reusing
  // test.json/fix.json in that case resurrects the EXACT artifacts review just rejected, verbatim,
  // and skips the fixer/test-author call entirely, so the rejection's feedback never reaches any
  // agent. Reuse is unconditionally disabled for a reFix item — the fixer/test-author MUST run fresh,
  // with feedback.md in hand, so the rejection has an actual chance of being corrected instead of
  // replayed. Plan reuse needs no separate carve-out: it falls out disabled too, via the existing
  // `out.test && planPath` gate below.
  if (isReFix) return out;
  try {
    // KI-E158(ii) (ported from a host-mount session) — a REPLAN (a fresh plan.md written after
    // test.json/fix.json already exist) supersedes whatever test/fix were authored against the OLDER
    // plan; a test/fix predating the current plan.md can describe an approach the plan no longer
    // takes. A plan.md strictly newer than test.json/fix.json is a cheap, unambiguous, mechanical
    // signal that the design underneath them changed since they were written.
    let planMs = null;
    try { planMs = statSync(join(itemDir, 'plan.md')).mtimeMs; } catch { /* no plan.md yet -> no fence */ }
    const predatesReplan = (name) => {
      if (planMs === null) return false;
      try { return statSync(join(itemDir, name)).mtimeMs < planMs; } catch { return false; }
    };
    const testPredatesReplan = predatesReplan('test.json');
    const fixPredatesReplan = predatesReplan('fix.json');

    const testPath = testPredatesReplan ? null : freshFile(itemDir, 'test.json', sinceMs);
    const test = testPath ? readJsonSafe(testPath) : null;
    if (test && typeof test === 'object') out.test = test;

    const fixPath = fixPredatesReplan ? null : freshFile(itemDir, 'fix.json', sinceMs);
    const fix = fixPath ? readJsonSafe(fixPath) : null;
    if (fix && typeof fix === 'object') out.fix = fix;

    const progressPath = freshFile(itemDir, 'progress.json', sinceMs);
    const progress = progressPath ? readJsonSafe(progressPath) : null;
    const plan = progress && progress.planner;
    if (plan && typeof plan.rootCause === 'string' && typeof plan.approach === 'string'
        && typeof plan.recommendScopeStop === 'boolean' && typeof plan.recommendEscalate === 'boolean'
        && (plan.steps === undefined || (Array.isArray(plan.steps) && plan.steps.every(s => typeof s === 'string')))
        && (!planMs || statSync(progressPath).mtimeMs >= planMs)) out.plan = plan;
    // Prose cannot prove control fields. A fresh plan also invalidates downstream reuse.
    if (!out.plan && !(progress && progress.plannerRequired === false)) { out.test = null; out.fix = null; }
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
