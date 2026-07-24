// Self-test for the factory lib (run: node _bmad-output/ai-factory/_workflow/lib/_selftest.mjs).
// Exercises the state machine, deps/locks READY computation, fold, and atomic I/O —
// the Phase-0 acceptance surface that does not need the Workflow runtime.
import { mkdtempSync, writeFileSync as fsWrite, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyLedger, syncFromGraph, transition, foldResults, canTransition,
  countByState, writeJsonAtomic, readJson, unwrapResultEnvelope, FORWARD,
} from './ledger.mjs';
import { computeReady, waitingOnDeps } from './graph.mjs';
import { isFactoryWorktreePath } from './worktree.mjs';
import { makeLimiter, pool, retry } from './pool.mjs';
import { loadRouting, resolve } from './router.mjs';
import { conflictFor, lockedFiles } from './locks.mjs';
import { parseVerifyRaw, verdictFromParse, debrisFiles, parseRedRaw, hasRealInfraMarker, touchedRootCause } from './verify.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { checkRoutingDrift, buildFactoryRouting } from './routing-drift.mjs';
import { changedFiles } from './worktree.mjs';
import { classifyFilesEntry, buildBasenameIndex, acceptanceSurfaceGaps } from './graphaudit.mjs';
import { renderFeedback } from './feedback.mjs';
import { gateFindingsSummary, isStrictlyNarrower, applyConvergenceBonus, effectiveRetryBound } from './convergence.mjs';
import { sig, jaccard, similarSigs, clusterBySimilarity, batchPatternFor } from './similarity.mjs';
import { loadController, isStale as controllerStale, claimController, verifyController, releaseController } from './controller.mjs';
import { execSmoke, smokeBatch } from './_execsmoke.mjs';
import { classifyLine as loClassify, firstLexeme as loLexeme, findLeftovers } from './leftover-scan.mjs';
import { splitAcceptanceClauses } from './acceptance.mjs';
import { dissentersFrom, roleForGateKey, recoveryTransitions, recoveryFoldSkeleton, priorCycleOf } from './recover.mjs';
import { extractHeadings, buildDocMap, readRoleBriefs } from './promptpack.mjs';
import { githubIssueToItem, markdownChecklistToItems, extractSection, severityFromLabels, themeFromLabels, ingestReport } from './ingest.mjs';
import { costTelemetryReady } from './preflight.mjs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ')'); }

// --- synthetic graph: A mechanical no-dep; B non-trivial dep-on-A; C owner-blocked; D shares a file with A ---
const graph = { items: [
  { id: 'WI-A', target: 'X', severity: 'CRITICAL', fixType: 'mechanical', files: ['x/a.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' },
  { id: 'WI-B', target: 'X', severity: 'HIGH', fixType: 'non-trivial', files: ['x/b.cs'], dependsOn: ['WI-A'], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' },
  { id: 'WI-C', target: 'X', severity: 'HIGH', fixType: 'owner-decision', files: ['x/c.cs'], dependsOn: [], autonomyTier: 'blocked', ownerDecision: 'pick a vs b', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' },
  { id: 'WI-D', target: 'X', severity: 'LOW', fixType: 'mechanical', files: ['x/a.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' },
] };

const ledger = emptyLedger('synthetic');
syncFromGraph(ledger, graph);
eq(ledger.items['WI-A'].state, 'READY', 'A starts READY');
eq(ledger.items['WI-C'].state, 'BLOCKED', 'C (owner-decision) starts BLOCKED');

// KI-L59: an ownerDecision that RECORDS an already-made ruling (ownerDecisionResolved:true)
// is a mandate, not a pending question — it must sync READY, with the ruling kept on the note.
// An explicit autonomyTier:'blocked' still wins over the resolved flag.
{
  const g59 = { items: [
    { id: 'WI-E', target: 'X', severity: 'CRITICAL', fixType: 'mechanical', files: ['x/e.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', ownerDecision: 'owner ruled: remove the surface', ownerDecisionResolved: true, acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' },
    { id: 'WI-F', target: 'X', severity: 'HIGH', fixType: 'mechanical', files: ['x/f.cs'], dependsOn: [], autonomyTier: 'blocked', layer: 'service', ownerDecision: 'ruled but tier-blocked', ownerDecisionResolved: true, acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' },
  ] };
  const l59 = emptyLedger('syn59'); syncFromGraph(l59, g59);
  eq(l59.items['WI-E'].state, 'READY', 'KI-L59: resolved owner ruling syncs READY (mandate, not pending)');
  ok((l59.items['WI-E'].note || '').startsWith('owner-ruled:'), 'KI-L59: resolved ruling recorded on the row note');
  eq(l59.items['WI-F'].state, 'BLOCKED', 'KI-L59: explicit autonomyTier=blocked still wins over the resolved flag');
}

// computeReady: A and D are dep-free; C blocked; B waits on A. D shares a/a.cs with A but
// nothing is in-flight yet, so both A and D are schedulable now.
let ready = computeReady(graph, ledger, { maxItemRetries: 2 }).map((w) => w.id);
eq(ready, ['WI-A', 'WI-D'], 'ready = A,D (CRITICAL first); B waits on A; C blocked');

// Claim A -> its file a/a.cs is now locked, so D (same file) must NOT be schedulable.
transition(ledger, 'WI-A', 'CLAIMED', 't');
const locks = lockedFiles(graph, ledger);
ok(conflictFor(graph.items[3], locks) && conflictFor(graph.items[3], locks).heldBy === 'WI-A', 'D conflicts with in-flight A on x/a.cs');
ready = computeReady(graph, ledger, { maxItemRetries: 2 }).map((w) => w.id);
eq(ready, [], 'nothing schedulable while A in-flight (B dep-blocked, D file-locked, C blocked)');

// Drive A through the full forward chain; assert every step is a legal transition.
for (let i = 2; i < FORWARD.length; i++) {
  const okT = transition(ledger, 'WI-A', FORWARD[i], 'step');
  ok(okT, 'A ' + FORWARD[i - 1] + '->' + FORWARD[i] + ' legal');
}
eq(ledger.items['WI-A'].state, 'CLOSED', 'A reached CLOSED');

// Now B's dep is satisfied; D's lock is released -> both schedulable, CRITICAL/sev order.
ready = computeReady(graph, ledger, { maxItemRetries: 2 }).map((w) => w.id);
eq(ready, ['WI-B', 'WI-D'], 'after A CLOSED: B (HIGH) before D (LOW); lock released');
eq(waitingOnDeps(graph, ledger).map((w) => w.id), [], 'no items waiting on deps now');

// Illegal transitions rejected.
ok(!canTransition('RED', 'CLOSED'), 'RED->CLOSED illegal');
ok(canTransition('GATED', 'REFUTE_OK'), 'GATED->REFUTE_OK legal');
ok(canTransition('TESTED', 'FAILED'), 'active->FAILED legal');
ok(canTransition('FAILED', 'READY'), 'FAILED->READY (re-queue) legal');
ok(canTransition('ESCALATED', 'INTEGRATED'), 'ESCALATED->INTEGRATED (human signed off) legal');

// foldResults: good + bad in one batch, rejected surfaced not lost.
const fr = foldResults(ledger, [
  { id: 'WI-B', toState: 'CLAIMED', cost: { 'claude-opus-4-8': 1200 }, worktree: '.factory-worktrees/WI-B' },
  { id: 'WI-B', toState: 'CLOSED' },            // illegal jump -> rejected
  { id: 'NOPE', toState: 'READY' },             // unknown -> rejected
]);
eq(fr.applied, [{ id: 'WI-B', to: 'CLAIMED' }], 'fold applied B->CLAIMED');
eq(fr.rejected.length, 2, 'fold rejected the illegal jump + unknown id (not silently lost)');
eq(ledger.items['WI-B'].cost['claude-opus-4-8'], 1200, 'fold accumulated cost');
eq(ledger.items['WI-B'].worktree, '.factory-worktrees/WI-B', 'fold recorded worktree');

// Atomic round-trip.
const dir = mkdtempSync(join(tmpdir(), 'factory-selftest-'));
const p = join(dir, 'ledger.json');
writeJsonAtomic(p, ledger);
const back = readJson(p);
eq(back.items['WI-A'].state, 'CLOSED', 'atomic write/read round-trip preserves state');

// Router resolves mechanical vs critical + escalate.
const routing = loadRouting(join(import.meta.dirname, '..', '..', 'config', 'model-routing.json'));
eq(resolve(routing, 'fixer.mechanical').model, 'claude-sonnet-5', 'mechanical fixer -> sonnet');
eq(resolve(routing, 'fixer.critical').model, 'claude-opus-4-8', 'critical fixer -> opus');
eq(resolve(routing, 'fixer.critical', { escalate: true }).effort, 'xhigh', 'critical fixer escalate -> xhigh');
eq(resolve(routing, 'gate.security').model, 'claude-opus-4-8', 'security gate -> opus');
eq(resolve(routing, 'gate.developer').model, 'claude-sonnet-5', 'developer gate -> sonnet');
ok(!(routing.routes || {}).reporter && !(routing.routes || {}).triager, 'KI-B5/B9: dead reporter/triager routes removed from model-routing.json (no factory stage ever called them)');

// Pool/limiter/retry behave (pure async helpers).
const seen = [];
await pool([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); return n * 2; }).then((r) => eq(r, [2, 4, 6, 8, 10], 'pool maps in order'));
let calls = 0;
const r = await retry(async () => { calls++; return calls >= 2 ? 'ok' : null; }, 3);
ok(r === 'ok' && calls === 2, 'retry returns on 2nd attempt');
const lim = makeLimiter(1); let peak = 0, cur = 0;
await Promise.all([1, 2, 3].map(() => lim(async () => { cur++; peak = Math.max(peak, cur); await Promise.resolve(); cur--; })));
ok(peak === 1, 'limiter(1) serialises');

// --- factory-findings fixes (2026-06-26 self-review) ----------------------------------------------
// (HIGH#2) ANY active / stranded mid-state can re-queue to READY so reset/resume can recover it.
// Previously only CLAIMED->READY was legal, so ITEM-M8 sat unrecoverable in TESTED.
ok(canTransition('TESTED', 'READY'), 'TESTED->READY (recover a stranded mid-active item) legal');
ok(canTransition('GATED', 'READY'), 'GATED->READY (recover) legal');
ok(canTransition('RED', 'READY'), 'RED->READY (recover) legal');
ok(canTransition('CLAIMED', 'READY'), 'CLAIMED->READY (un-claim) still legal');

// (MEDIUM#7) foldResults auto-inserts CLAIMED when a verified run (starts at RED) is folded onto a
// still-READY row (the select+fold-without-claim footgun) — the costly run must NOT be silently lost.
{
  const g2 = { items: [{ id: 'WI-Z', target: 'X', severity: 'MEDIUM', fixType: 'mechanical', files: ['z.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' }] };
  const l2 = emptyLedger('syn2'); syncFromGraph(l2, g2);
  eq(l2.items['WI-Z'].state, 'READY', 'Z starts READY (never explicitly claimed)');
  const fr2 = foldResults(l2, [{ id: 'WI-Z', transitions: ['RED', 'GREEN', 'BUILT', 'TESTED'], attemptsDelta: 1 }]);
  eq(l2.items['WI-Z'].state, 'TESTED', 'fold auto-inserted CLAIMED then walked READY->...->TESTED (no silent loss)');
  ok(fr2.applied.some((a) => a.to === 'CLAIMED') && fr2.rejected.length === 0, 'CLAIMED auto-inserted; nothing rejected');
  eq(l2.items['WI-Z'].attempts, 1, 'attemptsDelta folded (attempts=1)');
}

// (HIGH#1) attemptsDelta increments every run so computeReady's maxItemRetries bound fires — without it
// a perpetually-FAILED item re-burns opus forever (ITEM-M6 sat attempts:0 across 3 cycles).
{
  const g3 = { items: [{ id: 'WI-R', target: 'X', severity: 'HIGH', fixType: 'non-trivial', files: ['r.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' }] };
  const l3 = emptyLedger('syn3'); syncFromGraph(l3, g3);
  const failRun = () => foldResults(l3, [{ id: 'WI-R', toState: 'FAILED', attemptsDelta: 1 }]);
  failRun();
  eq(l3.items['WI-R'].attempts, 1, 'attempts=1 after 1st FAILED run');
  ok(computeReady(g3, l3, { maxItemRetries: 2 }).map((w) => w.id).includes('WI-R'), 'still schedulable at attempts=1 (FAILED is re-queueable)');
  failRun(); failRun();
  eq(l3.items['WI-R'].attempts, 3, 'attempts=3 after 3 FAILED runs');
  ok(!computeReady(g3, l3, { maxItemRetries: 2 }).map((w) => w.id).includes('WI-R'), 'PARKED at attempts>2 — bounded, no infinite opus re-burn');
}

// --- Wave-1 deterministic guards + cleanups (2026-06-26) ------------------------------------------

// KI-D3: deterministic build/test verdict parsed from build-test.sh FACTORY:: markers (the authority).
{
  const green = 'FACTORY::BUILD::RESULT exit=0 errors=0\nPassed!  - Failed: 0, Passed: 12, Skipped: 1, Total: 13\nFACTORY::TEST::SUITE::RESULT exit=0';
  const pg = parseVerifyRaw(green);
  ok(pg.hasData && pg.build.errors === 0 && pg.suite.failed === 0, 'parseVerifyRaw reads a green transcript');
  eq(verdictFromParse(pg, 0).pass, true, 'verdict: green transcript -> PASS');
  eq(verdictFromParse(parseVerifyRaw('FACTORY::BUILD::RESULT exit=1 errors=3'), 0).pass, false, 'verdict: build errors -> FAIL (overrides a false agent pass)');
  const testFail = 'FACTORY::BUILD::RESULT exit=0 errors=0\nFailed!  - Failed: 2, Passed: 10, Skipped: 0, Total: 12\nFACTORY::TEST::SUITE::RESULT exit=1';
  eq(verdictFromParse(parseVerifyRaw(testFail), 0).pass, false, 'verdict: new suite failures -> FAIL');
  eq(verdictFromParse(parseVerifyRaw(testFail), 2).pass, true, 'verdict: failures within baseline -> PASS (deprived runner)');
  eq(verdictFromParse(parseVerifyRaw(''), 0).reason, 'no-machine-evidence', 'verdict: empty transcript -> agent fallback');
  // cycle-8 live bug: a wrong-path FILTER retry (exit=1) precedes the correct run (exit=0) — the parser
  // MUST use the LAST marker, else it false-fails a passing test.
  const retry = 'FACTORY::BUILD::RESULT exit=0 errors=0\nFACTORY::TEST::FILTER::RESULT exit=1\nFACTORY::TEST::FILTER::RESULT exit=0\nFACTORY::TEST::SUITE::RESULT exit=0';
  eq(parseVerifyRaw(retry).targetedFail, false, 'parseVerifyRaw uses the LAST filter marker (retry fail-then-pass -> not failed)');
  eq(verdictFromParse(parseVerifyRaw(retry), 0).pass, true, 'verdict: filter retry that ends green -> PASS (no false fail)');
}

// KI-D1: debris = OBVIOUS factory-artifact / scratch files only (conservative — gates review real edits).
eq(debrisFiles(['ServiceA/src/Foo.cs', 'ServiceA/test/FooTests.cs', 'scratch/Mock.cs'], ['ServiceA/src/Foo.cs']),
  ['scratch/Mock.cs'], 'debrisFiles flags scratch, allows files[] + the new test');
// flow-review (ITEM-H9) conservative-debris fixes:
eq(debrisFiles(['ServiceF/src/App/Deep/ExportAuditCsvQueryHandler.cs'], ['ExportAuditCsvQueryHandler.cs']),
  [], 'debrisFiles matches files[] by BASENAME (audit gives basenames, diff gives full paths)');
eq(debrisFiles(['ServiceF/src/App/App.csproj'], ['Handler.cs']),
  [], 'debrisFiles does NOT flag a legit .csproj edit (InternalsVisibleTo) — gates review it');
eq(debrisFiles(['ServiceA/src/NewHelper.cs'], ['Foo.cs']),
  [], 'debrisFiles does NOT flag a legit unpredicted source file — gates review it');
eq(debrisFiles(['verify.json', 'verify-raw.txt', 'Svc/src/Foo.cs'], ['Svc/src/Foo.cs']),
  ['verify.json', 'verify-raw.txt'], 'debrisFiles DOES flag a root-level factory artifact misplaced in the worktree');

// Flow-review P1/P2/P9: the machine-evidence parsers the driver re-checks for a CODE item.
{
  // P1 — RED proof: non-zero exit on old code = genuine red; zero = vacuous test (rejected).
  eq(parseRedRaw('FACTORY::RED::1').red, true, 'parseRedRaw: non-zero exit -> red (test fails on old code)');
  eq(parseRedRaw('FACTORY::RED::0').red, false, 'parseRedRaw: exit=0 -> NOT red (vacuous test, rejected at fold)');
  eq(parseRedRaw('no marker here').hasData, false, 'parseRedRaw: no marker -> hasData=false (driver FAILs a code item)');
  eq(parseRedRaw('FACTORY::RED::1\nFACTORY::RED::0').red, false, 'parseRedRaw: uses LAST marker (retry semantics)');
  // P2 — real-infra container marker: present only when a real container ran.
  ok(hasRealInfraMarker('Passed!\nFACTORY::REALINFRA::Testcontainers-postgres\n...'), 'hasRealInfraMarker: marker present -> true');
  ok(!hasRealInfraMarker('FACTORY::BUILD::RESULT exit=0 errors=0\nPassed!'), 'hasRealInfraMarker: in-memory green (no marker) -> false');
  // P9 — root-cause touch: a code item must change a non-test source file, not only the test.
  ok(touchedRootCause(['Svc/src/PaymentService.cs', 'Svc/test/PaymentTests.cs'], ['Svc/src/PaymentService.cs']),
    'touchedRootCause: diff includes a non-test source file -> ok');
  ok(!touchedRootCause(['Svc/test/PaymentTests.cs'], ['Svc/src/PaymentService.cs']),
    'touchedRootCause: diff touched ONLY tests -> FAIL (greened the test, not the bug)');
  ok(touchedRootCause(['anything'], []), 'touchedRootCause: no rootCauseFiles (config/doc) -> nothing to assert');
  // KI-L24 — a deployability/config fix legitimately changes only config (.yaml/.env) + a .cs test; it has no
  // non-test .cs to touch, yet it is NOT "test-only". The old "non-test .cs required" rule false-failed it
  // (ITEM-C2: correct k8s-secret fix, 6 gates APPROVED, P9-overridden to FAILED). Must now pass.
  ok(touchedRootCause(['k8s/base/services/marketing-service.yaml', 'ServiceE/src/ServiceE.Tests/Infrastructure/DeploymentSecretCompletenessTests.cs'],
    ['ServiceE/src/ServiceE.Infrastructure/Promo/PromoCodeHasher.cs']),
    'touchedRootCause: config fix (.yaml changed) + only a .cs test -> ok (not test-only) [KI-L24]');
}

// KI-C6: FAILED -> ESCALATED legal (retry-bound exhausted surfaces to the human queue).
ok(canTransition('FAILED', 'ESCALATED'), 'FAILED->ESCALATED (retry exhausted) legal');

// KI-B4: fold idempotency — re-folding the same resultId is a no-op (no double cost/attempts).
{
  const g4 = { items: [{ id: 'WI-F', target: 'X', severity: 'HIGH', fixType: 'non-trivial', files: ['f.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' }] };
  const l4 = emptyLedger('syn4'); syncFromGraph(l4, g4);
  const res = [{ id: 'WI-F', resultId: 'WI-F#1', toState: 'FAILED', attemptsDelta: 1, cost: { 'claude-opus-4-8': 5 } }];
  foldResults(l4, res);
  eq(l4.items['WI-F'].attempts, 1, 'fold idempotency: first fold attempts=1');
  const second = foldResults(l4, res);
  eq(second.skipped.length, 1, 'fold idempotency: second fold of same resultId is skipped');
  eq(l4.items['WI-F'].attempts, 1, 'fold idempotency: attempts NOT double-counted');
  eq(l4.items['WI-F'].cost['claude-opus-4-8'], 5, 'fold idempotency: cost NOT double-counted');
}

// KI-L47: reject-atomic on an illegal ENTRY hop — a result whose first transition is not legal from
// the row's current state applies NO side effects and does NOT consume its resultId, so the corrected
// retry (same id, legal entry hop) folds cleanly. Mid-path partial-apply semantics are unchanged.
// (The illegal-entry example is GREEN-onto-FAILED: since KI-L62, a RED-onto-FAILED entry is the LEGAL
// direct-recovery shape — fold auto-inserts the CLAIMED re-entry for it; see the KI-L62 lane below.)
{
  const g5 = { items: [{ id: 'WI-DR', target: 'X', severity: 'HIGH', fixType: 'non-trivial', files: ['f.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' }] };
  const l5 = emptyLedger('syn5'); syncFromGraph(l5, g5);
  foldResults(l5, [{ id: 'WI-DR', resultId: 'WI-DR#1', transitions: ['CLAIMED', 'RED', 'FAILED'], attemptsDelta: 1 }]);
  eq(l5.items['WI-DR'].state, 'FAILED', 'KI-L47 setup: row parked FAILED');
  const bad = foldResults(l5, [{ id: 'WI-DR', resultId: 'WI-DR#2', transitions: ['GREEN', 'BUILT'], attemptsDelta: 1, cost: { 'claude-opus-4-8': 3 } }]);
  eq(bad.applied.length, 0, 'KI-L47: illegal-entry fold applies nothing');
  eq(bad.rejected.length, 2, 'KI-L47: illegal-entry fold rejects every hop');
  eq(l5.items['WI-DR'].attempts, 1, 'KI-L47: attemptsDelta NOT merged on unit-reject');
  ok(!(l5.items['WI-DR'].cost || {})['claude-opus-4-8'], 'KI-L47: cost NOT merged on unit-reject');
  ok(!l5.folded['WI-DR#2'], 'KI-L47: resultId NOT consumed on unit-reject');
  const good = foldResults(l5, [{ id: 'WI-DR', resultId: 'WI-DR#2', transitions: ['CLAIMED', 'RED', 'GREEN'], attemptsDelta: 1 }]);
  eq(good.applied.length, 3, 'KI-L47: corrected retry with the SAME resultId folds cleanly');
  ok(!!l5.folded['WI-DR#2'], 'KI-L47: resultId consumed on the applied retry');
}

// KI-B1: routing-drift guard — the inline RT/FLOW_RT table matches model-routing.json.
{
  const drift = checkRoutingDrift(join(import.meta.dirname, '..', 'factory.js'), routing);
  ok(drift.length === 0, 'routing-drift: inline RT == model-routing.json' + (drift.length ? ' (' + drift.join('; ') + ')' : ''));
}

// KI-B1 (closed 2026-07-12): buildFactoryRouting — the driver-injected, config-authoritative routing.
// Pins the factory-format shape (RT keys + FLOW_RT keys with {model, effort} only) and the routes
// whose provenance matters most (KI-L49 sonnet-pinned reauditor; KI-D11 fable-5 planner + adjudicator).
{
  const bfr = buildFactoryRouting(routing);
  eq(bfr.RT.reauditor, { model: 'claude-sonnet-5', effort: 'medium' }, 'buildFactoryRouting: reauditor pinned sonnet (KI-L49)');
  // KI-D11 (2026-07-19): adjudicator + planner route fable-5 with an opus fallback (KI-D10). Pin BOTH the
  // primary and the fallback so the experiment's shape — and the fallback plumbing — is regression-guarded.
  eq(bfr.RT.adjudicator.model, 'claude-fable-5', 'buildFactoryRouting: adjudicator -> fable-5 (KI-D11)');
  eq(bfr.RT.adjudicator.effort, 'max', 'buildFactoryRouting: adjudicator effort max');
  eq(bfr.RT.adjudicator.fallback, { model: 'claude-opus-4-8', effort: 'max' }, 'buildFactoryRouting: adjudicator opus/max fallback (KI-D10)');
  eq(bfr.RT.planner.model, 'claude-fable-5', 'buildFactoryRouting: planner -> fable-5 (KI-D11)');
  eq(bfr.RT.planner.fallback, { model: 'claude-opus-4-8', effort: 'high' }, 'buildFactoryRouting: planner opus/high fallback (KI-D10)');
  ok(Object.keys(bfr.RT).length >= 19, 'buildFactoryRouting: every RT_MAP route present in config (' + Object.keys(bfr.RT).length + ')');
  eq(bfr.FLOW_RT['review.editorial_prose'].model, 'claude-sonnet-5', 'buildFactoryRouting: editorial prose -> sonnet (KI-L58 — haiku 200k ceiling died on doc-heavy items)');
  ok(Object.keys(bfr.FLOW_RT).length === 6, 'buildFactoryRouting: all 6 review flows present');
}

// KI-B2/B3: advisory ledger lock — acquire, block a 2nd live acquire, release, re-acquire.
{
  const lockPath = join(dir, 'ledger.json.lock');
  const a = acquireLock(lockPath, new Date().toISOString());
  ok(a.ok, 'lock: first acquire succeeds');
  const b = acquireLock(lockPath, new Date().toISOString());
  ok(!b.ok && b.heldBy === process.pid, 'lock: second acquire blocked by live holder');
  releaseLock(lockPath);
  const c = acquireLock(lockPath, new Date().toISOString());
  ok(c.ok, 'lock: re-acquire after release succeeds');
  releaseLock(lockPath);
}

// changedFiles must NOT corrupt the first modified path (cycle-6 live bug: git().trim() stripped the
// leading space of an unstaged-modified porcelain line " M path", shifting slice(3) to eat the first
// char — "k8s/..." became "8s/..." → false debris). Real git in a temp repo locks the trimEnd fix.
try {
  const tdir = mkdtempSync(join(tmpdir(), 'factory-git-'));
  const g = (...a) => execFileSync('git', ['-C', tdir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q');
  fsWrite(join(tdir, 'kfile.cs'), 'original\n');
  g('add', 'kfile.cs'); g('commit', '-qm', 'base');
  fsWrite(join(tdir, 'kfile.cs'), 'modified\n'); // -> unstaged-modified, porcelain " M kfile.cs"
  eq(changedFiles(tdir), ['kfile.cs'], 'changedFiles preserves the leading char of an unstaged-modified path (trim-bug guard)');
} catch (e) {
  console.log('  SKIP changedFiles git-integration test (git unavailable: ' + (e && e.message) + ')');
}

// KI-L27: graph files[] path classifier — ok / creation-target / stale(rewrite) / ambiguous.
// Stale paths defeat the within-batch file-lock (KI-L23's root cause class); only a UNIQUE
// basename match (target-dir-unique preferred) may be auto-rewritten.
{
  const idx = buildBasenameIndex([
    'ServiceD/src/ServiceD.Infrastructure/ExceptionHandling/AlreadyExistsException.cs',
    'ServiceB/src/ServiceB.Api/Program.cs',
    'ServiceC/src/ServiceC.Api/Program.cs',
  ]);
  const exists = (p) => p === 'deploy-k8s.sh' || p === 'doc/runbooks';
  const o = { existsOnDisk: exists, byBasename: idx, targetDir: null };
  eq(classifyFilesEntry('deploy-k8s.sh', o).status, 'ok', 'graph-audit: existing path is ok');
  eq(classifyFilesEntry('doc/runbooks/', o).status, 'ok', 'graph-audit: existing dir (trailing slash) is ok');
  eq(classifyFilesEntry('BUILD-NEW-THING.md', o).status, 'creation-target', 'graph-audit: unknown basename = creation-target');
  const stale = classifyFilesEntry('ServiceD/src/ServiceD.Infrastructure/Common/AlreadyExistsException.cs', o);
  eq(stale.status, 'stale', 'graph-audit: unique-basename wrong path = stale');
  eq(stale.rewrite, 'ServiceD/src/ServiceD.Infrastructure/ExceptionHandling/AlreadyExistsException.cs', 'graph-audit: stale rewrite proposes the real path');
  eq(classifyFilesEntry('Program.cs', o).status, 'ambiguous', 'graph-audit: multi-candidate basename without target dir = ambiguous (never auto-rewritten)');
  const inTgt = classifyFilesEntry('src/Api/Program.cs', { ...o, targetDir: 'ServiceB' });
  eq(inTgt.status, 'stale', 'graph-audit: target-dir-unique candidate resolves a multi-candidate basename');
  eq(inTgt.rewrite, 'ServiceB/src/ServiceB.Api/Program.cs', 'graph-audit: target-dir rewrite is the in-target path');
  // Plausible-as-written: a pathed entry whose PARENT exists is a creation target even when the
  // basename collides globally (every service has a Dockerfile) — never auto-rewritten.
  const idx2 = buildBasenameIndex(['WebPortal/Dockerfile', 'AuthPortal/Dockerfile']);
  const exists2 = (p) => p === 'BulkOperationsService';
  eq(classifyFilesEntry('BulkOperationsService/Dockerfile', { existsOnDisk: exists2, byBasename: idx2, targetDir: 'BulkOperationsService' }).status,
    'creation-target', 'graph-audit: pathed entry with existing parent + no in-target match = creation-target (not ambiguous)');
  // ...but an in-target-unique match still wins over a plausible parent (renamed-dir case).
  const idx3 = buildBasenameIndex(['ServiceD/src/ServiceD.Tests/Integration/TestWebApplicationFactory.cs', 'OtherSvc/TestWebApplicationFactory.cs']);
  const exists3 = (p) => p === 'ServiceD/src/ServiceD.Tests';
  const won = classifyFilesEntry('ServiceD/src/ServiceD.Tests/TestWebApplicationFactory.cs', { existsOnDisk: exists3, byBasename: idx3, targetDir: 'ServiceD' });
  eq(won.status, 'stale', 'graph-audit: in-target-unique match beats the plausible-parent creation guess');
  eq(won.rewrite, 'ServiceD/src/ServiceD.Tests/Integration/TestWebApplicationFactory.cs', 'graph-audit: renamed-dir rewrite lands on the real in-target file');
}

// KI-L31: feedback.md projection — the authoritative reFix feedback derived from structured
// verdicts, independent of reviewer file-writes.
{
  eq(renderFeedback({ id: 'X', toState: 'FAILED' }), null, 'feedback: no gateDetails -> null (pre-gate failures use last-failure.md)');
  eq(renderFeedback({ id: 'X', gateDetails: {} }), null, 'feedback: empty gateDetails -> null');
  const fb = renderFeedback({
    id: 'WI-Z', resultId: 'WI-Z#21', toState: 'FAILED', note: 'review(s) not APPROVED: review:x',
    transitions: ['RED', 'GREEN', 'FAILED'],
    gateDetails: {
      'gate:developer': { verdict: 'APPROVED', headline: 'clean', findings: [] },
      'review:x': { verdict: 'CHANGES_REQUIRED', headline: 'netpol gap', acceptanceMet: false, findings: [{ severity: 'CRITICAL', title: 'ports not allowed', file: 'k8s/np.yaml:9', fix: 'add 5221' }] },
      'gate:qa': null,
    },
  });
  ok(fb && fb.includes('AUTHORITATIVE'), 'feedback: renders the authority banner');
  ok(fb.includes('review:x — CHANGES_REQUIRED') && fb.includes('netpol gap'), 'feedback: renders verdict + headline');
  ok(fb.includes('**CRITICAL** — ports not allowed') && fb.includes('add 5221'), 'feedback: renders findings with fix');
  ok(fb.includes('acceptanceMet: **false**'), 'feedback: surfaces acceptanceMet=false');
  ok(fb.includes('gate:qa — NULL'), 'feedback: a null (agent-returned-nothing) verdict is visible, fail-closed');
}

// KI-L39: pure-coverage exemption — the factory source must gate the P2 text floor AND P9
// rootCauseFiles on `theme === 'test-coverage' && !item.realInfra` (ITEM-C7 false-fail class:
// a coverage item's acceptance text names the guards the NEW TEST covers, and its files[] names the
// SUBJECT under test — neither is a defect-shape signal for an already-correct code path).
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(src.includes("const pureCoverage = item.theme === 'test-coverage' && !item.realInfra"),
    'KI-L39: factory derives the pureCoverage exemption predicate');
  ok(src.includes('const realInfraLikely = !!item.realInfra || (!pureCoverage && REALINFRA_SIGNAL.test(realInfraText))'),
    'KI-L39: P2 keyword floor is pureCoverage-gated (normalizer realInfra=true still binds)');
  ok(src.includes('res.rootCauseFiles = pureCoverage ? [] :'),
    'KI-L39: P9 rootCauseFiles is empty for pure coverage (test-only diff is the correct fix)');
}

// KI-L44 / KI-L45 (cycle 26 false-fail pair): (a) the in-run realInfra check must NOT hard-FAIL on the
// runner's returned realInfraExercised field — the sandboxed factory cannot read verify-raw.txt, and the
// returned field diverged from the on-disk artifact (ITEM-CR-5: disk true + marker present, returned
// !== true). Docker-absent still parks; otherwise the driver's fold-time marker grep is the authority.
// (b) needsRealInfra keys on the FIX surface (filesHaveCs), not codeChange — a .cs regression TEST on a
// doc/config item (ITEM-C3: Dockerfile) must not create a Postgres/Redis container demand.
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(!src.includes("return finish('FAILED', 'realInfra item: regression test did not exercise real infra"),
    'KI-L44: in-run realInfra self-report mismatch no longer hard-FAILs (deferred to driver fold grep)');
  ok(src.includes('close/fail deferred to the driver fold-time FACTORY::REALINFRA:: marker grep'),
    'KI-L44: deferral note is set so the fold context shows why the in-run check passed through');
  ok(src.includes("finish('BLOCKED', 'realInfra item needs Docker/Testcontainers"),
    'KI-L44: Docker-absent still PARKS (BLOCKED) — never a silent in-memory close');
  ok(src.includes('const needsRealInfra = filesHaveCs && realInfraLikely'),
    'KI-L45: needsRealInfra keys on filesHaveCs (fix surface), not codeChange (test language)');
}

// KI-L41: convergence-bonus round — deterministic narrower-trajectory detection from gateDetails.
{
  eq(gateFindingsSummary({ id: 'X' }), null, 'convergence: no gateDetails -> null (pre-gate failure, not comparable)');
  const wide = gateFindingsSummary({ gateDetails: {
    'gate:architect': { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'CRITICAL', title: 'a' }, { severity: 'HIGH', title: 'b' }] },
    'gate:qa': { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH', title: 'c' }] },
    'gate:developer': { verdict: 'APPROVED', findings: [] },
  } });
  eq(wide, { blockingGates: 2, findings: 3, maxRank: 0 }, 'convergence: summary counts blocking verdicts + findings, max sev CRITICAL');
  const narrow = gateFindingsSummary({ gateDetails: {
    'gate:architect': { verdict: 'APPROVED', findings: [] },
    'gate:qa': { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH', title: 'c residual' }] },
  } });
  eq(narrow, { blockingGates: 1, findings: 1, maxRank: 1 }, 'convergence: narrower round summarises smaller');
  const nullGate = gateFindingsSummary({ gateDetails: { 'gate:qa': null } });
  eq(nullGate, { blockingGates: 1, findings: 1, maxRank: 1 }, 'convergence: NULL verdict counts as an unknown HIGH-grade blocker (fail-closed)');
  const zeroFind = gateFindingsSummary({ gateDetails: { 'gate:po': { verdict: 'CHANGES_REQUIRED', findings: [] } } });
  eq(zeroFind, { blockingGates: 1, findings: 1, maxRank: 2 }, 'convergence: a blocking verdict with zero findings still counts as 1 finding-equivalent (MEDIUM)');
  ok(isStrictlyNarrower(narrow, wide), 'convergence: fewer findings + severity not worse -> narrower');
  ok(!isStrictlyNarrower(wide, narrow), 'convergence: widening is NOT narrower');
  ok(!isStrictlyNarrower(narrow, narrow), 'convergence: equal counts are NOT narrower (oscillation guard)');
  ok(!isStrictlyNarrower({ blockingGates: 1, findings: 1, maxRank: 0 }, { blockingGates: 2, findings: 3, maxRank: 1 }), 'convergence: fewer findings but WORSE max severity -> not narrower');
  ok(!isStrictlyNarrower(narrow, null), 'convergence: no prior round -> not narrower');
  // fold-time application on a mini-ledger
  const L = { items: { 'WI-K': { id: 'WI-K', state: 'FAILED', attempts: 3, history: [] } } };
  const cfgB = { retryBonusOnConvergence: true, maxItemRetries: 2, maxBonusRounds: 1 };
  const r1 = { id: 'WI-K', resultId: 'WI-K#7', toState: 'FAILED', gateDetails: { 'gate:qa': { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'CRITICAL', title: 'a' }, { severity: 'HIGH', title: 'b' }, { severity: 'HIGH', title: 'c' }] } } };
  eq(applyConvergenceBonus(L, cfgB, [r1]).length, 0, 'convergence: first FAILED round grants nothing (no prior) but persists the summary');
  eq(L.items['WI-K'].convergence.findings, 3, 'convergence: row.convergence persisted from round 1');
  L.items['WI-K'].attempts = 3; // past bound 2
  const r2 = { id: 'WI-K', resultId: 'WI-K#8', toState: 'FAILED', gateDetails: { 'gate:qa': { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH', title: 'c residual' }] } } };
  const g2 = applyConvergenceBonus(L, cfgB, [r2]);
  eq(g2.length, 1, 'convergence: strictly-narrower second round past the bound grants +1');
  eq(L.items['WI-K'].retryBonus, 1, 'convergence: bonus recorded on the row');
  const r3 = { id: 'WI-K', resultId: 'WI-K#9', toState: 'FAILED', gateDetails: { 'gate:qa': { verdict: 'CHANGES_REQUIRED', findings: [] } } };
  L.items['WI-K'].attempts = 4;
  eq(applyConvergenceBonus(L, cfgB, [r3]).length, 0, 'convergence: maxBonusRounds=1 caps the lifetime grants (no second bonus)');
  eq(effectiveRetryBound(2, L.items['WI-K']), 3, 'convergence: effective bound = base + earned bonus');
  eq(effectiveRetryBound(2, { attempts: 0 }), 2, 'convergence: no bonus -> base bound');
  // scheduling honours the bonus: attempts=3 > maxItemRetries=2 excludes, +1 bonus re-includes
  const bg = { items: [{ id: 'WI-K', target: 'X', severity: 'HIGH', fixType: 'mechanical', files: ['k/a.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', theme: 't', source: 's', acceptance: '', regressionTest: '', gateSet: [] }] };
  const bl = { items: { 'WI-K': { id: 'WI-K', state: 'FAILED', attempts: 3, retryBonus: 0, history: [] } } };
  eq(computeReady(bg, bl, { maxItemRetries: 2 }).map((w) => w.id), [], 'computeReady: attempts past flat bound -> excluded');
  bl.items['WI-K'].retryBonus = 1;
  eq(computeReady(bg, bl, { maxItemRetries: 2 }).map((w) => w.id), ['WI-K'], 'computeReady: convergence bonus re-admits the row (KI-L41)');
}

// Similarity batching (owner directive 2026-07-04: "plan similar work in one batch so that the
// changes are identical / similar") — lib/similarity.mjs is the ONE definition of "same pattern"
// shared by cluster.mjs (triage report), `driver suggest` (batch planning), and the `group`
// batch-pattern stamp that factory.js turns into a keep-the-diffs-identical brief line.
{
  const A = { id: 'S-A', target: 'SvcA', theme: 'deploy', severity: 'HIGH', title: 'deploy-k8s.sh missing build_images entry for the admin service' };
  const B = { id: 'S-B', target: 'SvcB', theme: 'deploy', severity: 'HIGH', title: 'deploy-k8s.sh missing build_images entry for the payments service' };
  const C = { id: 'S-C', target: 'SvcC', theme: 'deploy', severity: 'HIGH', title: 'liveness probe timeout too aggressive on startup' };
  const D = { id: 'S-D', target: 'SvcD', theme: 'crypto', severity: 'HIGH', title: 'deploy-k8s.sh missing build_images entry for the media service' };
  const sa = sig(A);
  ok(!sa.has('the') && !sa.has('missing') && !sa.has('admin') && !sa.has('service'), 'similarity: sig drops stop-words + service-noise tokens');
  ok(sa.has('deploy-k8s') && sa.has('entry'), 'similarity: sig keeps the distinctive pattern tokens');
  eq(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1, 'similarity: jaccard identical -> 1');
  eq(jaccard(new Set(['a']), new Set(['b'])), 0, 'similarity: jaccard disjoint -> 0');
  ok(similarSigs(sig(A), sig(B)), 'similarity: same change-shape titles ARE similar (>=2 shared keywords)');
  ok(!similarSigs(sig(A), sig(C)), 'similarity: unrelated titles are NOT similar');
  const clusters = clusterBySimilarity([A, B, C, D]).map((c) => c.map((w) => w.id).sort());
  ok(clusters.some((c) => JSON.stringify(c) === JSON.stringify(['S-A', 'S-B'])), 'similarity: same-theme same-pattern items cluster together');
  ok(clusters.some((c) => JSON.stringify(c) === JSON.stringify(['S-D'])), 'similarity: same pattern in a DIFFERENT theme never merges (theme-scoped)');
  ok(clusters.some((c) => JSON.stringify(c) === JSON.stringify(['S-C'])), 'similarity: dissimilar item stays a singleton');
  const pat = batchPatternFor([A, B]);
  ok(!!pat && pat.includes('theme=deploy') && pat.includes('SvcA') && pat.includes('SvcB'), 'similarity: homogeneous batch -> pattern text with theme + targets');
  eq(batchPatternFor([A, C]), null, 'similarity: mixed-shape batch -> NO pattern stamp (strict all-pairs rule)');
  eq(batchPatternFor([A, B, D]), null, 'similarity: cross-theme batch -> NO pattern stamp');
  eq(batchPatternFor([A]), null, 'similarity: singleton -> NO pattern stamp');
  // wiring pins: driver stamps + forwards, factory briefs, cluster.mjs consumes the shared rule
  const drv = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(drv.includes('batchPatternFor(picked)'), 'similarity: group auto-stamps the pattern from the picked batch');
  ok(drv.includes('batchPattern: batchPattern || undefined'), 'similarity: group forwards batchPattern on every item entry');
  ok(drv.includes("case 'suggest': return cmdSuggest(flags);"), 'similarity: suggest command is dispatched');
  const fsrc = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(fsrc.includes('BATCH PATTERN — SIMILARITY BATCH: ') && fsrc.includes('structurally IDENTICAL'), 'similarity: factory briefs agents to keep sibling changes structurally identical');
  const csrc = readFileSync(join(import.meta.dirname, '..', 'cluster.mjs'), 'utf8');
  ok(csrc.includes("from './lib/similarity.mjs'"), 'similarity: cluster.mjs imports the shared rule (single source of truth)');
}

// KI-C11: session-controller lease — the campaign-level single-owner guard. Two control-plane
// sessions interleaving group/fold on ONE ledger was witnessed live 2026-07-04; the lease makes
// the accidental second controller REFUSE loudly instead of silently racing (advisory, like lock.mjs).
{
  const cdir = mkdtempSync(join(tmpdir(), 'factory-ctl-'));
  const cp = join(cdir, 'controller.json');
  const T0 = '2026-07-09T10:00:00.000Z';           // claim
  const T1 = '2026-07-09T10:05:00.000Z';           // +5 min (fresh)
  const T2 = '2026-07-09T15:00:00.000Z';           // +295 min from T1 (past the 240-min TTL)
  eq(loadController(cp), null, 'controller: no file -> no lease');
  const c1 = claimController(cp, { token: null, label: 'sess-A', nowIso: T0, ttlMinutes: 240 });
  ok(c1.ok && c1.controller.token && c1.controller.token.length >= 8, 'controller: fresh claim succeeds + mints a token');
  const tokA = c1.controller.token;
  const vMatch = verifyController(cp, tokA, T1, 240);
  ok(vMatch.ok && vMatch.reason === 'match', 'controller: holder token verifies');
  eq(loadController(cp).heartbeatAt, T1, 'controller: verify refreshes heartbeatAt');
  eq(loadController(cp).acquiredAt, T0, 'controller: refresh preserves acquiredAt');
  const vForeign = verifyController(cp, 'deadbeef0000', T1, 240);
  ok(!vForeign.ok && vForeign.reason === 'foreign', 'controller: fresh lease REFUSES a mismatched token (KI-C11)');
  const vBare = verifyController(cp, null, T1, 240);
  ok(!vBare.ok && vBare.reason === 'foreign', 'controller: fresh lease refuses a bare (token-less) mutating command');
  const c2 = claimController(cp, { label: 'sess-B', nowIso: T1, ttlMinutes: 240 });
  ok(!c2.ok && c2.holder.label === 'sess-A', 'controller: second session claim vs a fresh lease is REFUSED');
  const c3 = claimController(cp, { label: 'sess-B', nowIso: T1, ttlMinutes: 240, force: true });
  ok(c3.ok && c3.takeover, 'controller: --force takeover succeeds (post-zombie-kill recovery)');
  const vStale = verifyController(cp, null, T2, 240);
  ok(!vStale.ok && vStale.reason === 'stale', 'controller: lease past the TTL reports stale');
  const c4 = claimController(cp, { label: 'sess-C', nowIso: T2, ttlMinutes: 240 });
  ok(c4.ok && c4.wasStale, 'controller: a stale lease is claimable WITHOUT force (crashed-session recovery)');
  ok(controllerStale({ heartbeatAt: 'garbage' }, T2, 240), 'controller: corrupt heartbeat counts as stale (claimable, lock.mjs posture)');
  ok(!releaseController(cp, 'wrong-token'), 'controller: release with a mismatched token is a refused no-op');
  ok(releaseController(cp, c4.controller.token), 'controller: holder release removes the lease');
  ok(!existsSync(cp) && !loadController(cp), 'controller: released lease is gone (factory FREE)');
  // wiring pins — the driver gates every mutating command behind the lease + dispatches the manager
  const cdrv = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(cdrv.includes('requireController(cmd, flags)'), 'controller: driver defines the requireController gate');
  ok(cdrv.includes("needsLock && cmd !== 'controller' && !requireController"), 'controller: every mutating command (except the lease manager) is gated');
  ok(cdrv.includes("case 'controller': return cmdController(flags, rest);"), 'controller: lease-manager command dispatched');
  ok(cdrv.includes('FACTORY_CONTROLLER'), 'controller: env-var token channel wired');
}

// KI-L50: infra-retry fold semantics — a FAILED result with attemptsDelta:0 records the FAILED state
// but does NOT count the attempt, so a credit/connection outage never exhausts the retry budget. Pins
// the foldResults contract the driver's --infra-retry relies on (it zeroes attemptsDelta pre-fold).
{
  const g2 = { items: [{ id: 'WI-INFRA', target: 'X', severity: 'HIGH', fixType: 'mechanical', files: ['x/i.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' }] };
  const l2 = emptyLedger('synthetic'); syncFromGraph(l2, g2);
  transition(l2, 'WI-INFRA', 'CLAIMED', 't');
  const before = l2.items['WI-INFRA'].attempts;
  foldResults(l2, [{ id: 'WI-INFRA', resultId: 'WI-INFRA#1', transitions: ['FAILED'], toState: 'FAILED', attemptsDelta: 0, note: 'INFRA-FAILURE (KI-L50)' }]);
  eq(l2.items['WI-INFRA'].state, 'FAILED', 'KI-L50: infra-retry result records FAILED');
  eq(l2.items['WI-INFRA'].attempts, before, 'KI-L50: infra-retry (attemptsDelta:0) does NOT count the attempt');
  const drv2 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(drv2.includes("flags['infra-retry']") && drv2.includes('r.attemptsDelta = 0'), 'KI-L50: cmdFold zeroes attemptsDelta for --infra-retry ids');
  ok(drv2.includes("case 'fold': return cmdFold(rest[0], flags);"), 'KI-L50: fold command forwards flags');
  ok(drv2.includes('const labelPath =') && drv2.includes('flags.label'), 'parallel-instances: group emits uniquely-labeled run-args/run-script per --label');
  const fsrc2 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(fsrc2.includes('infraSuspect') && fsrc2.includes('re-auditor agent UNAVAILABLE'), 'KI-L50: factory flags a null re-auditor as infra-suspect, distinct from non-convergence');
  ok(/reauditor:\s*\{\s*model:\s*'claude-sonnet-5'/.test(fsrc2), 'KI-L49: re-auditor pinned to an explicit model (not session-inherit)');
  // KI-L68: the harness-throw flavour of the infra class — agent({schema}) exhausting its
  // StructuredOutput retry cap (N consecutive calls with no valid output) must be auto-detected
  // at BOTH layers: factory.js marks the crashed-item result infraSuspect at the source, and the
  // fold's AUTO_INFRA_RE net matches the note shape (live shape from cycle 37: ITEM-C1 /
  // ITEM-H-YUBIKEY-PROVISION died at test-author under 6-lane spawn saturation, attempts counted).
  ok(/StructuredOutput retry cap \\\(\\d\+\\\) exceeded/.test(fsrc2) || fsrc2.includes('StructuredOutput retry cap'), 'KI-L68: factory catch marks StructuredOutput-cap crashes infraSuspect');
  const autoRe = drv2.match(/AUTO_INFRA_RE = (\/[^;\n]+\/)/);
  ok(!!autoRe, 'KI-L68: driver defines AUTO_INFRA_RE');
  const liveNote = 'runItem threw: agent({schema}): StructuredOutput retry cap (5) exceeded — 5 failed calls with no valid output';
  ok(autoRe && new RegExp(autoRe[1].slice(1, autoRe[1].lastIndexOf('/'))).test(liveNote), 'KI-L68: AUTO_INFRA_RE matches the live cycle-37 StructuredOutput-cap note shape');
  // Graceful-stop drain guard: `group` refuses while state/STOP_REQUESTED.md exists (deterministic
  // "prevent new lanes"); fold/reconstruct stay unguarded so in-flight lanes still drain.
  ok(drv2.includes('STOP_REQUESTED.md') && /refusing 'group': graceful-stop drain/.test(drv2),
    'stop-drain: cmdGroup refuses while the STOP_REQUESTED.md marker exists');
  ok(drv2.includes("flags['stop-override']"), 'stop-drain: --stop-override single-bypass hatch wired');
  ok(!/function cmdFold[\s\S]{0,400}STOP_REQUESTED/.test(drv2), 'stop-drain: fold is NOT guarded (draining must still complete)');
}

// KI-L40: checkpoint wiring — source pins (the Workflow runtime is not executable here, but the
// exec-smoke below RUNS the wiring; these pins keep the contract grep-visible).
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(src.includes('const CHECKPOINT_SCHEMA'), 'KI-L40: factory declares CHECKPOINT_SCHEMA');
  ok(src.includes("itemsDir(r.id) + '/result.json'"), 'KI-L40: checkpoint targets state/items/<id>/result.json');
  ok(src.includes('.then(checkpointResult)'), 'KI-L40: every item result (resolved AND crashed) is checkpointed');
}

// KI-L43: EXECUTION smoke — run the real factory.js body with stubbed agents over the 4-lane
// synthetic batch (doc/editorial lane = the KI-L36 TDZ site; FULL code lane; dispute→adjudicate→
// re-gate lane; verification-only reFix lane). The assertion IS: no orchestration-path crash.
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  let disputeBlocked = false; // stateful: block the FIRST SMOKE-DISPUTE:gate-qa call only, so the re-gate APPROVES (full adjudicate lane)
  const { result, calls } = await execSmoke(src, smokeBatch(), {
    blockedGate: (label) => {
      if (label === 'SMOKE-DISPUTE:gate-qa' && !disputeBlocked) { disputeBlocked = true; return true; }
      return false;
    },
    agentOverride: (prompt, opts) => {
      // the verification-only reFix lane (KI-L37): its test-author attests nothing is still broken
      if ((opts && opts.label) === 'SMOKE-VONLY:test-author') return { red: false, verificationOnly: true, testFiles: [], runCmd: '', evidence: 'stub reverification', note: 'stub' };
      // KI-L57 pair: an APPROVED gate with a stray scopeViolation flag (self-contradictory) vs a
      // CHANGES_REQUIRED gate with a genuine scopeViolation (must still hard-stop).
      if ((opts && opts.label) === 'SMOKE-SCOPEFLAG:gate-developer') return { gate: 'gate-developer', verdict: 'APPROVED', findings: [], scopeViolation: true, acceptanceMet: true, redGreenConfirmed: true, headline: 'stub ok — stray scope flag' };
      if ((opts && opts.label) === 'SMOKE-SCOPESTOP:gate-developer') return { gate: 'gate-developer', verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'CRITICAL', title: 'adds a purchase-fee surface', file: 'doc/runbooks/y.md', fix: 'scope-stop' }], scopeViolation: true, acceptanceMet: false, redGreenConfirmed: true, headline: 'stub genuine red-line' };
      return undefined;
    },
  });
  eq(result && result.mode, 'run', 'exec-smoke: factory returns mode=run');
  eq((result.results || []).length, 6, 'exec-smoke: 6 item results returned');
  const by = Object.fromEntries((result.results || []).map((r) => [r.id, r]));
  ok(!(result.results || []).some((r) => String(r.note || '').startsWith('runItem threw')), 'exec-smoke: NO runItem crash on any lane (KI-L36 class)');
  eq(by['SMOKE-DOC'] && by['SMOKE-DOC'].toState, 'CLOSED', 'exec-smoke: doc/editorial lane completes (the KI-L36 TDZ site executes)');
  eq(by['SMOKE-CODE'] && by['SMOKE-CODE'].toState, 'CLOSED', 'exec-smoke: FULL code lane completes to CLOSED');
  eq(by['SMOKE-DISPUTE'] && by['SMOKE-DISPUTE'].gates && by['SMOKE-DISPUTE'].gates.adjudicator, 'OVERRULED', 'exec-smoke: dispute lane reached the adjudicator');
  eq(by['SMOKE-DISPUTE'] && by['SMOKE-DISPUTE'].toState, 'CLOSED', 'exec-smoke: OVERRULED + re-gate APPROVED proceeds past the gate band (P8)');
  eq(by['SMOKE-VONLY'] && by['SMOKE-VONLY'].toState, 'CLOSED', 'exec-smoke: verification-only reFix lane completes (KI-L37)');
  ok(!calls.some((c) => c.label === 'SMOKE-VONLY:fixer'), 'exec-smoke: verification-only lane SKIPS the fixer');
  eq(by['SMOKE-SCOPEFLAG'] && by['SMOKE-SCOPEFLAG'].toState, 'CLOSED', 'KI-L57: an APPROVED gate with a stray scopeViolation flag does NOT hard-stop the item');
  ok(by['SMOKE-SCOPEFLAG'] && by['SMOKE-SCOPEFLAG'].gateDetails && by['SMOKE-SCOPEFLAG'].gateDetails['gate:developer'] && by['SMOKE-SCOPEFLAG'].gateDetails['gate:developer'].scopeViolationIgnored === true, 'KI-L57: the inconsistent flag is preserved on gateDetails for the audit trail');
  eq(by['SMOKE-SCOPESTOP'] && by['SMOKE-SCOPESTOP'].toState, 'BLOCKED', 'KI-L57: a CHANGES_REQUIRED gate with scopeViolation still hard-stops (genuine scope-stop path intact)');
  eq(calls.filter((c) => c.label.endsWith(':checkpoint')).length, 6, 'exec-smoke: every item result checkpointed via a haiku write agent (KI-L40)');
}

// KI-C2 (closed 2026-07-12): the budget-ACTIVE lane — a launch-turn token budget whose remaining()
// is already inside the reserve must stop every item BEFORE its first agent call: id-less CLAIMED
// no-op (attempt NOT burned), NOT checkpointed (reconstruct must ignore it; resume must list it as
// a relaunch candidate), and ZERO agents spent.
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  const { result, calls } = await execSmoke(src, smokeBatch(), {
    budget: { total: 100000, spent: () => 99000, remaining: () => 1000 }, // 1000 < the 50k default reserve
  });
  eq((result.results || []).length, 6, 'budget-stop: all 6 items still return a result');
  ok((result.results || []).every((r) => r.budgetStopped === true), 'budget-stop: every item is budgetStopped');
  ok((result.results || []).every((r) => r.toState === 'CLAIMED' && r.attemptsDelta === 0), 'budget-stop: CLAIMED no-op, attempt NOT burned');
  ok((result.results || []).every((r) => !r.resultId), 'budget-stop: id-less (reconstruct ignores it; fold-idempotency warning exempts it)');
  eq(calls.length, 0, 'budget-stop: ZERO agent calls — not even the checkpoint writer');
}

// KI-L62: direct-recovery fold onto a FAILED row — transitions start at RED; fold must auto-insert
// the CLAIMED re-entry (the run protocol §4 documented shape [RED,…,CLOSED]) instead of rejecting the
// whole result (live: ITEM-CR-5#34r was 9/9-rejected pre-fix).
{
  const g62 = { items: [{ id: 'WI-DR', target: 'X', severity: 'CRITICAL', fixType: 'mechanical', files: ['dr.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' }] };
  const l62 = emptyLedger('syn62'); syncFromGraph(l62, g62);
  transition(l62, 'WI-DR', 'CLAIMED', 't'); transition(l62, 'WI-DR', 'RED', 't'); transition(l62, 'WI-DR', 'FAILED', 't');
  const fr62 = foldResults(l62, [{ id: 'WI-DR', resultId: 'WI-DR#1r', transitions: ['RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED', 'INTEGRATED', 'CLOSED'], toState: 'CLOSED', attemptsDelta: 0 }]);
  eq(l62.items['WI-DR'].state, 'CLOSED', 'KI-L62: direct-recovery RED..CLOSED onto a FAILED row auto-claims and closes');
  ok(fr62.applied.some((a) => a.to === 'CLAIMED') && fr62.rejected.length === 0, 'KI-L62: CLAIMED auto-inserted from FAILED; nothing rejected');
}

// KI-L60: shadow-driver detection — a factory ITEM WORKTREE path is flagged; the primary checkout
// (and unrelated paths that merely mention worktrees) are not.
ok(isFactoryWorktreePath('/repo/_bmad-output/ai-factory/state/worktrees/ITEM-CR-5/_bmad-output/ai-factory/_workflow'), 'KI-L60: worktree shadow driver path detected');
ok(isFactoryWorktreePath('C:\\repo\\_bmad-output\\ai-factory\\state\\worktrees\\WI-X\\sub'), 'KI-L60: windows-separator worktree path detected');
ok(!isFactoryWorktreePath('/repo/_bmad-output/ai-factory/_workflow'), 'KI-L60: primary checkout path not flagged');
ok(!isFactoryWorktreePath('/repo/state/worktrees'), 'KI-L60: bare dir without an item segment not flagged');

// KI-L65: main-tree contamination guard — group snapshots the item's files[] in MAIN; fold re-hashes
// and reports drift (agent wrote outside its worktree — witnessed twice, cycle 35). Absent files
// snapshot as null; creation, mutation, and deletion all drift; an untouched tree does not.
{
  const { snapshotMainFiles, driftAgainstSnapshot } = await import('./mainguard.mjs');
  const { mkdtempSync, writeFileSync: wf65, rmSync: rm65, unlinkSync: ul65 } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j65 } = await import('node:path');
  const root65 = mkdtempSync(j65(tmpdir(), 'mainguard-'));
  wf65(j65(root65, 'a.cs'), 'original');
  const snap65 = snapshotMainFiles(root65, ['a.cs', 'missing.yaml']);
  ok(typeof snap65['a.cs'] === 'string' && snap65['missing.yaml'] === null, 'KI-L65: snapshot hashes present files, null for absent');
  eq(driftAgainstSnapshot(root65, snap65).length, 0, 'KI-L65: untouched tree reports zero drift');
  wf65(j65(root65, 'a.cs'), 'MUTATED BY A ROGUE AGENT');
  wf65(j65(root65, 'missing.yaml'), 'created outside the worktree');
  let d65 = driftAgainstSnapshot(root65, snap65);
  eq(d65.length, 2, 'KI-L65: mutation of a present file AND creation of an absent file both drift');
  ul65(j65(root65, 'a.cs'));
  d65 = driftAgainstSnapshot(root65, snap65);
  ok(d65.some((x) => x.file === 'a.cs' && x.now === 'absent'), 'KI-L65: deletion of a snapshotted file drifts as absent');
  rm65(root65, { recursive: true, force: true });
}

// KI-E14 (2026-07-20): group's pre-claim dirty-main-overlap guard — an item whose files[] intersect
// uncommitted main-tree changes is excluded (worktrees snapshot HEAD; apply-back would clobber the
// pending fix). dirtyMainPaths reads porcelain (modified + untracked-dir + rename); filesOverlapDirty
// is the pure overlap predicate group uses (exact file OR under a dirty untracked dir).
{
  const { dirtyMainPaths, filesOverlapDirty } = await import('./mainguard.mjs');
  const { mkdtempSync: mkE, writeFileSync: wfE, mkdirSync: mdE, rmSync: rmE } = await import('node:fs');
  const { tmpdir: tdE } = await import('node:os');
  const { join: jE } = await import('node:path');
  const { execFileSync: exE } = await import('node:child_process');
  // pure predicate first (no git needed)
  const dirtyFix = { paths: ['Svc/src/Options.cs', 'Svc/doc.md'], dirs: ['Svc/tests/NewSuite/'] };
  eq(filesOverlapDirty(['Svc/src/Options.cs'], dirtyFix).length, 1, 'KI-E14: exact dirty-file overlap detected');
  eq(filesOverlapDirty(['Svc/tests/NewSuite/ATests.cs'], dirtyFix).length, 1, 'KI-E14: file under a dirty untracked dir overlaps (prefix match)');
  eq(filesOverlapDirty(['Svc/src/Other.cs', 'Elsewhere/B.cs'], dirtyFix).length, 0, 'KI-E14: disjoint files in the same service do NOT overlap (file-level precision)');
  eq(filesOverlapDirty([], dirtyFix).length + filesOverlapDirty(null, dirtyFix).length, 0, 'KI-E14: empty/null files[] never overlap');
  // porcelain reader against a real throwaway repo: one committed-then-modified file + one untracked dir
  const rootE = mkE(jE(tdE(), 'dirtymain-'));
  exE('git', ['-C', rootE, 'init', '-q']);
  wfE(jE(rootE, 'tracked.cs'), 'original');
  exE('git', ['-C', rootE, 'add', '.']);
  exE('git', ['-C', rootE, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x', '--no-gpg-sign', '--no-verify']);
  wfE(jE(rootE, 'tracked.cs'), 'MODIFIED');
  mdE(jE(rootE, 'newdir'), { recursive: true });
  wfE(jE(rootE, 'newdir', 'new.cs'), 'new');
  const dE = dirtyMainPaths(rootE);
  ok(dE.paths.includes('tracked.cs'), 'KI-E14: modified tracked file appears in dirty paths');
  ok(dE.dirs.includes('newdir/'), 'KI-E14: untracked dir appears in dirty dirs (trailing slash)');
  eq(filesOverlapDirty(['newdir/new.cs', 'clean.cs'], dE).length, 1, 'KI-E14: live-repo overlap resolves through the untracked dir');
  rmE(rootE, { recursive: true, force: true });
  // driver wiring pin: group carries the guard + the escape flag
  const dsrc = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc.includes('force-dirty-overlap') && dsrc.includes('dirtyMainPaths(REPO_ROOT)'), 'KI-E14: cmdGroup wires the dirty-overlap guard with a --force-dirty-overlap escape');
}

// KI-D12 refinement (2026-07-20): `placeholder`-lexeme hits are pruned from files whose OWN added
// lines carry the sanctioned secret-template markers (REPLACE_WITH_/CHANGE_ME) — those files
// implement/test the loud-placeholder convention (the 9/9 ITEM-M2 WARN-noise class). Other
// lexemes in the same file still fire; placeholder punts in marker-free files still fire.
{
  const { pruneConventionPlaceholderHits } = await import('./leftover-scan.mjs');
  const hits = [
    { file: 'X/Options.cs', lexeme: 'placeholder', line: '/// This placeholder is an' },
    { file: 'X/Options.cs', lexeme: 'TODO', line: '// TODO: wire the real thing' },
    { file: 'X/Tests.cs', lexeme: 'placeholder', line: '"to apply with placeholder values)");' },
    { file: 'Y/Svc.cs', lexeme: 'placeholder', line: '// placeholder logic goes here' },
  ];
  const added = {
    'X/Options.cs': 'public string P = "REPLACE_WITH_32_PLUS_RANDOM_CHARS";\n/// This placeholder is an\n',
    'X/Tests.cs': 'Assert.Contains("CHANGE_ME", v);\n"to apply with placeholder values)");\n',
    'Y/Svc.cs': '// placeholder logic goes here\n',
  };
  const pruned = pruneConventionPlaceholderHits(hits, added);
  ok(!pruned.some((h) => h.lexeme === 'placeholder' && h.file.startsWith('X/')), 'KI-D12b: placeholder prose/string hits pruned in convention files (added lines carry the literal markers)');
  ok(pruned.some((h) => h.file === 'X/Options.cs' && h.lexeme === 'TODO'), 'KI-D12b: a TODO in the same convention file STILL fires (prune is lexeme-scoped)');
  ok(pruned.some((h) => h.file === 'Y/Svc.cs' && h.lexeme === 'placeholder'), 'KI-D12b: a placeholder punt in a marker-free file STILL fires');
}

// KI-E15 (2026-07-20): a split on ANY CRITICAL/HIGH item adjudicates — LIGHT band included. Cycle 46
// ran two genuine LIGHT-band HIGH splits (ITEM-H17 5-vs-1, ITEM-H-A6 6-vs-1) that failed straight
// past the adjudicator; the operator had to convene one manually and BOTH dissents were upheld with
// exact bounded remedies. SMOKE-DOC is HIGH + doc-drift => LIGHT band: force one gate to dissent and
// pin that the adjudicator now runs (UPHELD keeps the FAIL but attaches the authoritative remedy).
{
  const fsrc15 = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  ok(!/band === 'FULL' && heavy && failedBlk/.test(fsrc15), 'KI-E15: the disputed condition no longer requires band === FULL');
  ok(fsrc15.includes('KI-E15'), 'KI-E15: the drop is documented at the decision site');
  let docBlocked15 = false;
  const smoke15 = await execSmoke(fsrc15, smokeBatch(), {
    blockedGate: (label) => { if (label === 'SMOKE-DOC:gate-qa' && !docBlocked15) { docBlocked15 = true; return true; } return false; },
    agentOverride: (prompt, opts) => ((opts && opts.label) === 'SMOKE-DOC:adjudicator')
      ? { verdict: 'UPHELD', reasons: ['stub dissent is real'], headline: 'stub upheld' }
      : undefined,
  });
  ok(smoke15.calls.some((c) => c.label === 'SMOKE-DOC:adjudicator'), 'KI-E15: a LIGHT-band HIGH split now reaches the adjudicator');
  const by15 = Object.fromEntries(((smoke15.result && smoke15.result.results) || []).map((r) => [r.id, r]));
  eq(by15['SMOKE-DOC'] && by15['SMOKE-DOC'].gates && by15['SMOKE-DOC'].gates.adjudicator, 'UPHELD', 'KI-E15: the adjudicator verdict is recorded in the gates map');
  eq(by15['SMOKE-DOC'] && by15['SMOKE-DOC'].toState, 'FAILED', 'KI-E15: UPHELD still FAILs the item — but with the authoritative remedy attached');
}

// KI-E16 (2026-07-20): graph-audit's shared-file acceptance lint — an open item whose acceptance
// names the standards-divergence ledger while files[] lacks the ledger path is flagged, so the
// operator hand-appends it and the batch file-lock can serialize sibling items (the ITEM-H-A6
// staged-not-appended class: the clusterer paired it with ITEM-H17 ON the ledger change-shape while
// the lock saw disjoint files[]).
{
  const dsrc16 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc16.includes('sharedFileGap') && dsrc16.includes('SHARED-FILE-GAP'), 'KI-E16: graph-audit carries the shared-file gap lint + loud console line');
  ok(/ledger entr\(\?\:y\|ies\)|ledger anchor/.test(dsrc16), 'KI-E16: the lint matches acceptance prose naming a ledger entry/anchor');
}

// KI-E7 / ai-factory-observability spine AD-1..3, AD-11, AD-12: telemetry is a single append-only
// JSONL stream; emission never throws, kill-switched, line-size-bounded; ONE canonical stage
// vocabulary; deterministic mtime stage-timeline backfill; pure aggregation for the report.
{
  const T = await import('./telemetry.mjs');
  const { mkdtempSync: mkT, writeFileSync: wfT, mkdirSync: mkdT, utimesSync: utT, readFileSync: rfT } = await import('node:fs');
  const { tmpdir: tmpT } = await import('node:os');
  const { join: jT } = await import('node:path');
  // envelope + serialization (pure)
  const b = T.buildEvent({ event: 'stage_end', item: 'X-1', stage: 'fix', durMs: 12, attrs: { a: 1 } });
  ok(b.v === 1 && typeof b.ts === 'string' && b.source === 'driver' && b.item === 'X-1' && b.durMs === 12 && b.attrs.a === 1, 'telemetry: buildEvent fills the v1 envelope');
  const small = T.serializeEvent(b);
  ok(small.length < T.MAX_LINE && JSON.parse(small).item === 'X-1', 'telemetry: small event serializes verbatim');
  const big = T.serializeEvent(T.buildEvent({ event: 'x', item: 'X-2', attrs: { blob: 'y'.repeat(20000) } }));
  ok(big.length <= T.MAX_LINE && JSON.parse(big).truncated === true && JSON.parse(big).item === 'X-2', 'telemetry: oversize event truncates to a parseable line under MAX_LINE (AD-3 O_APPEND bound)');
  // emit round-trip + kill-switch (temp stream dir)
  const tdir = mkT(jT(tmpT(), 'telemetry-'));
  const envSave = { dir: process.env.FACTORY_TELEMETRY_DIR, sw: process.env.FACTORY_TELEMETRY };
  process.env.FACTORY_TELEMETRY_DIR = tdir;
  delete process.env.FACTORY_TELEMETRY;
  ok(T.emit({ event: 'unit_test', item: 'T-1' }) === true, 'telemetry: emit appends when enabled');
  process.env.FACTORY_TELEMETRY = '0';
  ok(T.emit({ event: 'suppressed' }) === false, 'telemetry: FACTORY_TELEMETRY=0 kill-switch suppresses');
  delete process.env.FACTORY_TELEMETRY;
  let evs = T.readEvents(T.telemetryFile());
  ok(evs.length === 1 && evs[0].event === 'unit_test' && evs[0].v === 1, 'telemetry: JSONL round-trip reads back exactly the enabled event');
  // agent CLI: always exit 0; role->stage derivation; free-typed --stage normalized (AD-12)
  const cli = new URL('../telemetry-emit.mjs', import.meta.url).pathname;
  execFileSync('node', [cli], { env: { ...process.env } }); // no --event: still exit 0 (never blocks an agent)
  execFileSync('node', [cli, '--event', 'stage_start', '--item', 'T-2', '--role', 'fixer'], { env: { ...process.env } });
  execFileSync('node', [cli, '--event', 'stage_end', '--item', 'T-2', '--stage', 'RED', '--durMs', '42'], { env: { ...process.env } });
  evs = T.readEvents(T.telemetryFile());
  eq(evs.length, 3, 'telemetry CLI: bad-args call writes nothing, good calls append (always exit 0)');
  ok(evs[1].source === 'agent' && evs[1].stage === 'fix' && evs[1].role === 'fixer', 'telemetry CLI: stage derives from --role via roleToStage (AD-12)');
  ok(evs[2].stage === 'test' && evs[2].durMs === 42, 'telemetry CLI: free-typed --stage RED normalizes onto the canonical enum');
  // canonical vocabulary (AD-12)
  eq(T.roleToStage('gate-security'), 'gates', 'telemetry: roleToStage maps gate-* to gates');
  eq(T.roleToStage('re-auditor'), 'reaudit', 'telemetry: roleToStage maps re-auditor to reaudit');
  eq(T.normalizeStage('Refute+Re-audit'), 'refute', 'telemetry: normalizeStage maps phase titles');
  eq(T.normalizeStage('GATED'), 'gates', 'telemetry: normalizeStage maps ledger states');
  ok(T.normalizeStage('nonsense-vocab') === null, 'telemetry: unmappable stage drops to null (never a fourth vocabulary)');
  eq(T.stageForArtifact('gate-architect.md'), 'gates', 'telemetry: artifact pattern maps gate-*.md to gates');
  // deterministic mtime timeline (AD-11)
  const idir = jT(tdir, 'items', 'T-3');
  mkdT(idir, { recursive: true });
  const t0 = Date.now() - 60000;
  wfT(jT(idir, 'plan.md'), 'p'); utT(jT(idir, 'plan.md'), new Date(t0), new Date(t0));
  wfT(jT(idir, 'test.json'), '{}'); utT(jT(idir, 'test.json'), new Date(t0 + 10000), new Date(t0 + 10000));
  wfT(jT(idir, 'gate-qa.md'), 'g'); utT(jT(idir, 'gate-qa.md'), new Date(t0 + 20000), new Date(t0 + 20000));
  wfT(jT(idir, 'notes.txt'), 'ignored'); // unmapped artifact never enters the timeline
  const tl = T.deriveStageTimeline(idir);
  eq(tl.map((s) => s.stage), ['plan', 'test', 'gates'], 'telemetry: mtime timeline is stage-mapped and mtime-ordered');
  eq(T.deriveStageTimeline(idir, { sinceMs: t0 + 5000 }).map((s) => s.stage), ['test', 'gates'], 'telemetry: sinceMs drops prior-attempt artifacts (reFix dirs)');
  // F3: same-stage artifacts collapse into ONE row spanning first..last (parallel review band)
  wfT(jT(idir, 'gate-developer.md'), 'g2'); utT(jT(idir, 'gate-developer.md'), new Date(t0 + 25000), new Date(t0 + 25000));
  const tl3 = T.deriveStageTimeline(idir);
  const gatesRow = tl3.find((s) => s.stage === 'gates');
  const near = (a, b) => Math.abs(a - b) < 10; // fs mtimeMs carries float jitter on some filesystems
  ok(tl3.filter((s) => s.stage === 'gates').length === 1 && gatesRow.files.length === 2 && near(gatesRow.bandSpanMs, 5000) && near(gatesRow.mtimeMs, t0 + 25000), 'telemetry F3: parallel-band artifacts collapse to one stage row (files=2, bandSpanMs=first..last, ts=last)');
  // aggregation (AD-9/AD-12: derived-only durations; agent events in a separate bucket)
  const agg = T.aggregateEvents([
    { event: 'item_folded', source: 'driver', item: 'A', cycle: 38, outcome: 'CLOSED', attrs: { toState: 'CLOSED', gates: { 'gate:qa': 'APPROVED', 'gate:security': 'CHANGES_REQUIRED' }, cost: { 'claude-sonnet-5': 3 }, infraSuspect: false } },
    { event: 'item_folded', source: 'driver', item: 'B', cycle: 38, outcome: 'FAILED', attrs: { toState: 'FAILED', infraSuspect: true } },
    { event: 'stage_end', source: 'derived', item: 'A', stage: 'fix', durMs: 1000 },
    { event: 'stage_end', source: 'derived', item: 'B', stage: 'fix', durMs: 3000 },
    { event: 'stage_end', source: 'agent', item: 'A', stage: 'fix', durMs: 999999 },
  ]);
  eq(agg.outcomes, { CLOSED: 1, FAILED: 1 }, 'telemetry: aggregate counts fold outcomes');
  eq(agg.cycles['38'], { folded: 2, closed: 1 }, 'telemetry: aggregate rolls per-cycle folds');
  eq(agg.gates['gate:security'], { CHANGES_REQUIRED: 1 }, 'telemetry: aggregate tallies gate verdicts');
  eq(agg.models['claude-sonnet-5'], 3, 'telemetry: aggregate sums model call volume from fold cost');
  ok(agg.infraSuspect === 1, 'telemetry: aggregate counts infra-suspect results');
  eq(agg.stages.fix, [1000, 3000], 'telemetry: derived durations are the ONLY duration authority (AD-12)');
  eq(agg.agentStages.fix, [999999], 'telemetry: agent durations stay in the separate factory_agent bucket (AD-12)');
  eq(T.quantile([], 0.5), 0, 'telemetry: quantile of empty is 0');
  eq(T.quantile([1000, 3000], 0.5), 1000, 'telemetry: p50 of two samples is the lower');
  const md = T.renderTelemetryReport(agg, { generatedAt: 'T', file: 'f' });
  ok(md.includes('## Stage durations — derived') && md.includes('## Gate verdicts') && md.includes('gate:security'), 'telemetry: report renders the evaluation sections');
  // worker-plane wiring (AD-10): compose() briefs every stage agent with the absolute emit CLI
  const fsrc = rfT(new URL('../factory.js', import.meta.url), 'utf8');
  ok(fsrc.includes("telemetry-emit.mjs --event stage_start") && fsrc.includes('--outcome <ok|fail|blocked>'), 'telemetry: factory.js compose() carries the TELEMETRY brief (AD-10)');
  // review finding #2: the agent CLI must NOT accept --source (authority forgery) — a forged
  // value rides into attrs and the event stays source:agent.
  execFileSync('node', [cli, '--event', 'stage_end', '--item', 'T-9', '--role', 'fixer', '--source', 'derived', '--durMs', '5'], { env: { ...process.env } });
  const forged = T.readEvents(T.telemetryFile()).pop();
  ok(forged.source === 'agent' && (!forged.attrs || forged.attrs.source === 'derived'), 'telemetry CLI: --source is rejected — source:agent hard-pinned (AD-2)');
  const aggF = T.aggregateEvents([{ event: 'stage_end', source: 'orchestrator', stage: 'fix', durMs: 7 }]);
  ok(!aggF.stages.fix && aggF.agentStages.fix, 'telemetry: non-derived sources NEVER feed the duration authority (AD-12 whitelist)');
  // restore env
  if (envSave.dir === undefined) delete process.env.FACTORY_TELEMETRY_DIR; else process.env.FACTORY_TELEMETRY_DIR = envSave.dir;
  if (envSave.sw === undefined) delete process.env.FACTORY_TELEMETRY; else process.env.FACTORY_TELEMETRY = envSave.sw;
}

// F2 (analysis 2026-07-17) — doc path-claim linter: phantom-path extraction + suffix resolution.
// The cycle-39 witness: a fabricated `Api/Controllers/Support/` in new doc prose cost a full
// review round; the linter flags exactly that class deterministically at fold (WARN-only).
{
  const D = await import('./doclint.mjs');
  eq(D.extractPathClaims('Three controllers under `Api/Controllers/Support/`: see https://x.y/a/b and v1.2.3'), ['Api/Controllers/Support/'], 'doclint: extracts path claims, skips URLs + versions');
  eq(D.extractPathClaims('run scripts/services.json and {placeholder}/x plus k8s/base/*.yaml'), ['scripts/services.json'], 'doclint: skips placeholders + globs');
  eq(D.extractPathClaims('mute/unmute analytics/CRM Conversations/Messages/Notifications drill-down/requeue/soft-drop ../Rel/Path'), [], 'doclint: prose slash-alternations + relative parents are NOT path claims (live-tuned precision)');
  eq(D.extractPathClaims('see doc/runbooks/marketplace-admin.md and Controllers/Admin/AdminController.cs'), ['doc/runbooks/marketplace-admin.md', 'Controllers/Admin/AdminController.cs'], 'doclint: extension-bearing file claims are kept');
  eq(D.extractPathClaims('backoff 500ms/1s/1.5s and 2s/4s/8s windows'), [], 'doclint: all-numeric timing lists are not path claims (cycle-40 live false positive)');
  eq(D.extractPathClaims('pull hub.docker.com/v2/repositories/prom/tags/v1.2.3 or raw.githubusercontent.com/nodejs/Release/main/schedule.json'), [], 'doclint: scheme-less URLs (bare hostname first segment) are web claims, not tree paths (KI-E11 live false positive)');
  eq(D.extractPathClaims('see Svc.Api/Controllers/Admin/AdminController.cs'), ['Svc.Api/Controllers/Admin/AdminController.cs'], 'doclint: .NET Dotted.Names first segments survive the hostname skip');
  eq(D.extractPathClaims('stream lives at ./data/events.jsonl on the host'), ['data/events.jsonl'], 'doclint: leading ./ normalizes off so relative claims suffix-match tracked entries (KI-E11)');
  const entries = new Set([
    'Svc/src/Svc.Api/Controllers/Admin/AdminController.cs',
    'Svc/src/Svc.Api/Controllers/Admin/', 'Svc/src/Svc.Api/Controllers/Admin',
    'Svc/src/Svc.Api/Controllers/', 'Svc/src/Svc.Api/Controllers',
    'Svc/src/Svc.Api/', 'Svc/src/Svc.Api', 'Svc/src/', 'Svc/src', 'Svc/', 'Svc',
    'scripts/services.json', 'scripts/', 'scripts',
  ]);
  ok(D.claimResolves('Api/Controllers/Admin/', entries), 'doclint: service-relative dir claim resolves via suffix match');
  ok(D.claimResolves('scripts/services.json', entries), 'doclint: repo-root file claim resolves exactly');
  ok(!D.claimResolves('Api/Controllers/Support/', entries), 'doclint: phantom dir claim does NOT resolve (the ITEM-HI-11 witness)');
  eq(D.findMissingClaims(['under `Api/Controllers/Support/` and `Api/Controllers/Admin/`'], entries), ['Api/Controllers/Support/'], 'doclint: findMissingClaims surfaces only the phantom, deduped');
  eq(D.findMissingClaims([], entries), [], 'doclint: no added lines -> no findings');
}

// Exporter pure core (telemetry/exporter/lib/aggregate.mjs — spine AD-5/AD-12/AD-13 + review
// findings #3/#6/#11): ingest reducer, derived-only histograms, nested label maps (space-safe),
// one-span-per-stage assembly with buffer consumption, valid Prometheus exposition.
{
  const X = await import('../../telemetry/exporter/lib/aggregate.mjs');
  const st = X.createState();
  const feed = [
    { event: 'item_claimed', source: 'driver', item: 'A', cycle: 39 },
    { event: 'stage_end', source: 'derived', item: 'A', cycle: 39, stage: 'test', durMs: 10000, ts: '2026-07-17T10:00:10.000Z' },
    { event: 'stage_end', source: 'derived', item: 'A', cycle: 39, stage: 'verify', durMs: 5000, ts: '2026-07-17T10:00:20.000Z' },
    { event: 'stage_end', source: 'derived', item: 'A', cycle: 39, stage: 'verify', durMs: 3000, ts: '2026-07-17T10:00:25.000Z' }, // 2nd verify ARTIFACT — must merge into ONE span
    { event: 'stage_end', source: 'agent', item: 'A', cycle: 39, stage: 'verify', durMs: 999999, ts: '2026-07-17T10:00:26.000Z' }, // agent — never the histogram
    { event: 'item_folded', source: 'driver', item: 'A', cycle: 39, outcome: 'CLOSED', ts: '2026-07-17T10:00:30.000Z', attrs: { toState: 'CLOSED', gates: { 'gate:qa re-run': 'APPROVED' }, cost: { 'claude-opus-4-8': 2 }, infraSuspect: false } },
  ];
  let folded = null;
  for (const e of feed) { const r = X.ingestLine(st, JSON.stringify(e)); if (r.folded) folded = r; }
  ok(!!folded, 'exporter core: item_folded surfaces from the reducer');
  eq(st.itemState.get('A'), 'CLOSED', 'exporter core: item gauge state follows the fold');
  eq(st.stageHist.get('verify').count, 2, 'exporter core: only the 2 derived verify events hit the histogram (agent excluded — AD-12)');
  X.ingestLine(st, 'not json at all');
  ok(st.parseErrors === 1, 'exporter core: bad line counts a parse error, never throws');
  const trace = X.assembleTrace(st, folded.folded, folded.foldTsMs);
  const spans = trace.resourceSpans[0].scopeSpans[0].spans;
  eq(spans.length, 3, 'exporter core: root + test + ONE merged verify span (finding #3 — no duplicate spanIds)');
  const verifySpan = spans.find((s) => s.name === 'verify');
  ok(verifySpan.startTimeUnixNano === '1784282415000000000' && verifySpan.endTimeUnixNano === '1784282425000000000', 'exporter core: merged span spans min-start..max-end as stringified unix nanos');
  ok(spans.every((s) => /^[0-9a-f]{32}$/.test(s.traceId) && /^[0-9a-f]{16}$/.test(s.spanId)), 'exporter core: deterministic hex ids (AD-13)');
  eq(X.assembleTrace(st, folded.folded, folded.foldTsMs).resourceSpans[0].scopeSpans[0].spans.length, 1, 'exporter core: buffer consumed on first assembly (finding #6 — re-assembly has only the root)');
  ok(st.stageBuffer.size === 0, 'exporter core: stageBuffer empty after assembly (no leak)');
  const text = X.renderMetrics(st);
  ok(text.includes('factory_gate_verdicts_total{gate="gate:qa re-run",verdict="APPROVED"} 1'), 'exporter core: space-bearing gate names render intact (finding #11 — nested maps)');
  ok(text.includes('factory_stage_duration_seconds_bucket{stage="verify",le="+Inf"} 2') && text.includes('factory_items{state="CLOSED"} 1'), 'exporter core: histogram cumulative buckets + item gauge render');
  const trunc = JSON.stringify({ event: 'stage_end', source: 'derived', stage: 'fix' }); // no durMs
  X.ingestLine(st, trunc);
  ok(!st.stageHist.get('fix'), 'exporter core: stage_end without durMs never observes a bucket');
}

// --- cache-strategic prompts (2026-07-18): promptpack helpers + factory/brief/pack invariants ---
{
  // extractHeadings: ##/### with 1-based line numbers; #### excluded; cap honoured.
  const doc = '# t\n\n## Alpha\nbody\n### Beta sub\n#### too deep\n## Gamma\n';
  eq(extractHeadings(doc), ['§ Alpha @L3', '§ Beta sub @L5', '§ Gamma @L7'], 'promptpack: extractHeadings levels + line numbers');
  eq(extractHeadings(doc, 2).length, 2, 'promptpack: extractHeadings cap');
  // buildDocMap: injected io — existing docs map to heading lines; missing docs skipped; no target -> [].
  const fakeFs = {
    existsSync: (p) => p.endsWith('doc/data-flows/Svc.md') || p.endsWith('Svc/CONTEXT.md'),
    readFileSync: (p) => p.endsWith('CONTEXT.md') ? '## Deps\n' : '## API\nx\n## Events\n',
  };
  const dm = buildDocMap('/repo', 'Svc', fakeFs);
  eq(dm.length, 2, 'promptpack: buildDocMap maps only existing docs');
  ok(dm[0] === 'doc/data-flows/Svc.md :: § API @L1 · § Events @L3', 'promptpack: buildDocMap data-flow entry shape (got ' + dm[0] + ')');
  ok(dm[1] === 'Svc/CONTEXT.md :: § Deps @L1', 'promptpack: buildDocMap CONTEXT entry shape');
  eq(buildDocMap('/repo', '', fakeFs), [], 'promptpack: buildDocMap empty target -> []');
  eq(buildDocMap('/repo', 'Svc', { existsSync: () => { throw new Error('io'); }, readFileSync: () => '' }), [], 'promptpack: buildDocMap io failure is best-effort []');
  // readRoleBriefs: injected io — .md only, role keyed, capped; dir failure -> {}.
  const fakeDir = { readdirSync: () => ['fixer.md', 'notes.txt', 'gate-qa.md'], readFileSync: (p) => 'BRIEF:' + basenameOf(p) };
  function basenameOf(p) { return String(p).split('/').pop(); }
  const briefs = readRoleBriefs('/agents', fakeDir);
  eq(Object.keys(briefs).sort(), ['fixer', 'gate-qa'], 'promptpack: readRoleBriefs .md-only role keys');
  ok(briefs.fixer === 'BRIEF:fixer.md', 'promptpack: readRoleBriefs content');
  eq(readRoleBriefs('/agents', { readdirSync: () => { throw new Error('io'); } }), {}, 'promptpack: readRoleBriefs dir failure -> {} (compose falls back to pointer)');

  // factory.js invariants: shared prefix order (GUARDRAILS before every role-conditional block),
  // pack seams, inline-brief branch, docMap block, telemetry verdict split.
  const LIBDIR = dirname2(fileURLToPath(import.meta.url));
  const fsrc = readFileSync(join(LIBDIR, '..', 'factory.js'), 'utf8');
  function dirname2(p) { return p.replace(/\/[^/]+$/, ''); }
  const iGuard = fsrc.indexOf("'GUARDRAILS (.claude/rules");
  const iPack = fsrc.indexOf("'REVIEW PACK: Read '");
  const iD7 = fsrc.indexOf('PARALLEL REVIEW STAGE — LIVE-PROBE');
  ok(iGuard > 0 && iPack > iGuard && iD7 > iPack, 'factory: cache-strategic order — GUARDRAILS < REVIEW PACK < KI-D7 (role tail after shared prefix)');
  ok(fsrc.includes('A.briefs && A.briefs[role]'), 'factory: inline-brief branch present (batch briefs win, pointer fallback)');
  ok(fsrc.includes('DOC MAP (section index'), 'factory: docMap block present in shared prefix');
  ok(fsrc.includes("--verdict <APPROVED|CHANGES_REQUIRED>"), 'factory: telemetry verdict split for review roles');
  ok(fsrc.includes("' pack ' + wtPath"), 'factory: runner PACKCMD seam present');
  ok(fsrc.includes('REGENERATE the review pack'), 'factory: editorial pass regenerates the pack (KI-L34 final-diff invariant)');
  // build-test.sh: pack subcommand present + untracked-file capture + observability marker.
  const bts = readFileSync(join(LIBDIR, '..', '..', 'verify', 'build-test.sh'), 'utf8');
  ok(bts.includes('pack)') && bts.includes('ls-files --others --exclude-standard') && bts.includes('FACTORY::PACK::'), 'build-test.sh: pack subcommand + untracked capture + marker');
  // briefs: the 6 method cards are HEADLESS (no interactive-skill invocation remains).
  const AG = join(LIBDIR, '..', '..', 'agents');
  const cards = ['review-code', 'review-adversarial', 'review-edgecase', 'review-testreview', 'review-editorial-structure', 'review-editorial-prose'];
  let headless = 0, invokes = 0;
  for (const c of cards) {
    const t = readFileSync(join(AG, c + '.md'), 'utf8');
    if (t.includes('HEADLESS METHOD CARD')) headless++;
    if (/Invoke the \*\*`bmad-/.test(t)) invokes++;
  }
  eq(headless, 6, 'briefs: all 6 method cards carry the HEADLESS METHOD CARD contract');
  eq(invokes, 0, 'briefs: no method card still instructs invoking the interactive bmad skill');
  ok(readFileSync(join(AG, 'review-adversarial.md'), 'utf8').includes('NO quota'), 'briefs: adversarial card replaces the ten-findings quota with gate calibration');
}

// KI-E10/E11/E12/E13 + KI-D8 4th mitigation (2026-07-19, session 20 — telemetry-driven quality wave):
// early edge-scan for every code item, group-time realInfra Docker guard + in-run marker probe,
// early claims-lint, telemetry gap-fence + KPIs + failure concentration + unmatched agent starts.
{
  const T = await import('./telemetry.mjs');
  const agg = T.aggregateEvents([
    { event: 'item_folded', source: 'driver', item: 'A', cycle: 39, attrs: { toState: 'FAILED', gates: { 'gate:qa': 'CHANGES_REQUIRED' } } },
    { event: 'item_folded', source: 'driver', item: 'A', cycle: 40, attrs: { toState: 'CLOSED', gates: { 'direct-recovery': 'converged-remedy (x)' } } },
    { event: 'item_folded', source: 'driver', item: 'B', cycle: 39, attrs: { toState: 'CLOSED', gates: { 'gate:qa': 'APPROVED' } } },
    { event: 'stage_end', source: 'derived', item: 'A', stage: 'plan', durMs: 59379000 },
    { event: 'stage_end', source: 'derived', item: 'A', stage: 'fix', durMs: 1000, attrs: { gapSuspect: true } },
    { event: 'stage_end', source: 'derived', item: 'A', stage: 'gates', durMs: 2000, attrs: { final: 'FAILED' } },
    { event: 'stage_start', source: 'agent', item: 'A', role: 'fixer' },
    { event: 'stage_end', source: 'agent', item: 'A', role: 'fixer', stage: 'fix', durMs: 5 },
    { event: 'stage_start', source: 'agent', item: 'A', role: 'checkpoint-writer' },
  ]);
  ok(!agg.stages.plan && !agg.stages.fix, 'KI-E13: over-fence + gapSuspect derived durations are excluded from the duration pool');
  eq(agg.gapOutliers.length, 2, 'KI-E13: gap-fenced outliers are collected for the report');
  eq(agg.stages.gates, [2000], 'KI-E13: in-fence derived durations still feed the pool');
  eq(agg.failedAt.gates, 1, 'KI-E13: attrs.final=FAILED concentrates failures by the item\'s last stage');
  eq(agg.itemFolds['A'].map((f) => f.st), ['FAILED', 'CLOSED'], 'KI-E13: per-item fold sequence is stream-ordered');
  ok(agg.itemFolds['A'][1].direct === true && agg.itemFolds['B'][0].direct === false, 'KI-E13: direct-recovery signature detected from the fold gates map');
  ok(agg.agentPairs['A :: fixer'].starts === 1 && agg.agentPairs['A :: fixer'].ends === 1, 'KI-E13: agent start/end pairs tally per item+role');
  ok(agg.agentPairs['A :: checkpoint-writer'].starts === 1 && agg.agentPairs['A :: checkpoint-writer'].ends === 0, 'KI-E13: an unmatched start (agent died mid-stage, KI-D8 class) is visible');
  const md = T.renderTelemetryReport(agg, { generatedAt: 'T', file: 'f' });
  ok(md.includes('## KPIs') && md.includes('First-pass close rate') && md.includes('1/2 = 50%'), 'KI-E13: report renders the KPI section (first-pass 1/2)');
  ok(md.includes('Direct-recovery rate') && md.includes('Gap-fenced duration outliers') && md.includes('Unmatched agent stage_starts') && md.includes('A :: checkpoint-writer'), 'KI-E13: report renders recovery rate + gap outliers + unmatched starts');
  eq(T.roleToStage('marker-probe'), 'verify', 'KI-E10: marker-probe role maps onto the verify stage');
  // factory.js source contracts
  const fsrc2 = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  ok(fsrc2.includes('EARLY EDGE SCAN (KI-E12'), 'KI-E12: factory runs the early edge-scan stage (pre-band)');
  ok(!fsrc2.includes('code && heavy'), 'KI-E12: edge-case hunter is no longer CRITICAL/HIGH-gated in flowsFor');
  ok(fsrc2.includes("!(edgeFinal && f.routeKey === 'review.edgecase')"), 'KI-E12: late band drops edge-case ONLY when the early scan produced a verdict (null falls back to the band)');
  ok(fsrc2.includes("blocking.push({ key: 'review:review-edge-case-hunter'"), 'KI-E12: the early verdict joins the band verdict set (fold/adjudication/re-gate unchanged)');
  ok(fsrc2.includes("call('marker-probe'"), 'KI-E10: in-run disk-authoritative marker probe present');
  ok(fsrc2.includes('realInfra marker probe (KI-E10)'), 'KI-E10: probe fail-fast is named and fires pre-band');
  ok(fsrc2.includes('GREP-ANCHORED SELF-REPORT (KI-E10)'), 'KI-E10: runner realInfra self-report is grep-anchored');
  ok(fsrc2.includes('DOC-CLAIM SELF-CHECK (KI-E11)'), 'KI-E11: fixer briefed with the claims self-check');
  ok(fsrc2.includes('DOC-CLAIM LINT (KI-E11)'), 'KI-E11: runner tees the claims lint for doc-touching items');
  ok(fsrc2.includes('routine machine-state bookkeeping'), 'KI-D8: checkpoint preamble opens with the bookkeeping framing (4th mitigation)');
  // driver.mjs source contracts
  const dsrc = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(!dsrc.includes('if (!heavy && /edge-case/i.test(f.skill)) continue'), 'KI-E12: driver applicableReviewFlows agreement updated (edge-case for every code item)');
  ok(dsrc.includes('KI-E10: Docker ABSENT'), 'KI-E10: group hard-excludes realInfra items when Docker is absent');
  ok(dsrc.includes("flags['force-realinfra']"), 'KI-E10: --force-realinfra escape hatch present');
  ok(dsrc.includes('at.gapSuspect = true') && dsrc.includes('at.final = r.toState'), 'KI-E13: fold stamps gapSuspect + final on derived stage events');
  // build-test.sh claims mode + the CLI (single source of truth with lib/doclint.mjs)
  const bts2 = readFileSync(new URL('../../verify/build-test.sh', import.meta.url), 'utf8');
  ok(bts2.includes('claims)') && bts2.includes('claims-lint.mjs'), 'KI-E11: build-test.sh claims subcommand wired to the CLI');
  const clisrc = readFileSync(new URL('../claims-lint.mjs', import.meta.url), 'utf8');
  ok(clisrc.includes('FACTORY::CLAIMS::') && clisrc.includes('lintWorktreeDocClaims'), 'KI-E11: claims CLI emits the machine marker from the SAME doclint lib the fold F2 uses');
  // briefs
  ok(readFileSync(new URL('../../agents/review-edgecase.md', import.meta.url), 'utf8').includes('EARLY POSITION (KI-E12'), 'KI-E12: edge-case brief carries the early-position contract');
  ok(readFileSync(new URL('../../agents/marker-probe.md', import.meta.url), 'utf8').includes('marker-probe (KI-E10)'), 'KI-E10: marker-probe brief exists');
  ok(readFileSync(new URL('../../agents/fixer.md', import.meta.url), 'utf8').includes('DOC-CLAIM SELF-CHECK (KI-E11)'), 'KI-E11: fixer card carries the claims self-check');
}

// KI-D12: LeftoverScan — the deterministic detector + the factory-side probe wiring.
{
  // detector: genuine deferrals HIT, sanctioned mechanisms + excluded paths + legit code do NOT.
  ok(loClassify('X/src/Foo.cs', '    // TODO: wire the real consumer later'), 'KI-D12: a TODO comment is a leftover candidate');
  ok(loClassify('X/src/Foo.cs', '    throw new NotImplementedException();'), 'KI-D12: NotImplementedException is a candidate');
  ok(loClassify('X/src/Foo.cs', '    // for now we short-circuit this path'), 'KI-D12: a "for now" deferral is a candidate');
  ok(!loClassify('X/src/Foo.cs', '    var total = price * qty; // sum the line'), 'KI-D12: ordinary code is NOT a candidate');
  ok(!loClassify('X/src/Foo.cs', '    // standards-evolution: legacy of RuleX — see ledger'), 'KI-D12: a ledgered standards-evolution tag is exempt (sanctioned)');
  ok(!loClassify('.claude/rules/security.md', '- Never ship a TODO in production'), 'KI-D12: the rule files that DEFINE the lexicon are exempt');
  ok(!loClassify('_bmad-output/notes.md', 'deferred to a follow-up sweep'), 'KI-D12: the factory\'s own _bmad-output docs are exempt');
  ok(!loClassify('k8s/secret.yaml', '  KEY: REPLACE_WITH_32_PLUS_RANDOM_CHARS'), 'KI-D12: REPLACE_WITH_ secret-template placeholders are exempt (own guard)');
  eq(loLexeme('a FIXME here'), 'FIXME', 'KI-D12: firstLexeme returns the matched token');
  // factory wiring contract (grep-visible; exec-smoke below RUNS the FAIL path)
  const fsrc = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(fsrc.includes('const LEFTOVER_SCHEMA') && fsrc.includes("call('leftover-probe'"), 'KI-D12: factory declares LEFTOVER_SCHEMA + runs the haiku leftover-probe');
  ok(fsrc.includes("' leftovers ' + wtPath") || fsrc.includes('leftovers ') , 'KI-D12: the probe invokes build-test.sh leftovers on the worktree');
  ok(fsrc.includes('typeof lo.clean') , 'KI-D12: only an EXPLICIT boolean verdict acts (a malformed/unavailable probe never sinks an item)');
}

// KI-D12: build-test.sh leftovers subcommand -> CLI; CLI emits the marker from the SAME lib the probe reads.
{
  const bts = readFileSync(new URL('../../verify/build-test.sh', import.meta.url), 'utf8');
  ok(bts.includes('leftovers)') && bts.includes('leftover-lint.mjs'), 'KI-D12: build-test.sh leftovers subcommand wired to the CLI');
  const lcli = readFileSync(new URL('../leftover-lint.mjs', import.meta.url), 'utf8');
  ok(lcli.includes('FACTORY::LEFTOVER::') && lcli.includes('findLeftovers'), 'KI-D12: leftover CLI emits the machine marker from the SAME leftover-scan lib the probe + fold read');
}

// KI-D12: exec-smoke — a leftover-probe genuine-punt verdict FAILS the code lane PRE-BAND (cheap),
// and a clean verdict lets it proceed to CLOSED with the gate recorded.
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  const punt = await execSmoke(src, smokeBatch(), {
    agentOverride: (prompt, opts) => ((opts && opts.label) === 'SMOKE-CODE:leftover-probe')
      ? { clean: false, punts: [{ file: 'X/src/Some.cs', line: '// TODO later', why: 'deferred the real fix' }] } : undefined,
  });
  const puntBy = Object.fromEntries((punt.result.results || []).map((r) => [r.id, r]));
  eq(puntBy['SMOKE-CODE'] && puntBy['SMOKE-CODE'].toState, 'FAILED', 'KI-D12: a genuine-punt leftover verdict FAILS the code lane');
  ok(String(puntBy['SMOKE-CODE'] && puntBy['SMOKE-CODE'].note || '').includes('leftover-scan'), 'KI-D12: the FAIL note cites leftover-scan');
  ok(!punt.calls.some((c) => c.label === 'SMOKE-CODE:gate-architect'), 'KI-D12: the leftover FAIL is PRE-BAND (no opus gate spent)');
  const cleanRun = await execSmoke(src, smokeBatch(), {
    agentOverride: (prompt, opts) => ((opts && opts.label) === 'SMOKE-CODE:leftover-probe') ? { clean: true, punts: [] } : undefined,
  });
  const cleanBy = Object.fromEntries((cleanRun.result.results || []).map((r) => [r.id, r]));
  eq(cleanBy['SMOKE-CODE'] && cleanBy['SMOKE-CODE'].toState, 'CLOSED', 'KI-D12: a clean leftover verdict lets the code lane proceed to CLOSED');
  eq(cleanBy['SMOKE-CODE'] && cleanBy['SMOKE-CODE'].gates && cleanBy['SMOKE-CODE'].gates['probe:leftover-scan'], 'APPROVED', 'KI-D12: a clean verdict records probe:leftover-scan APPROVED in the gates map');
}

// KI-E17: portable mounts — host-repo-root walk-up + stock-prefix config rewrite.
{
  const { findRepoRoot, resolveRepoRoot, swapMountPrefix, STOCK_MOUNT } = await import('./rootfind.mjs');
  // walk-up starts at the mount's PARENT: the factory's own .git (submodule gitfile at the
  // mount root) must never win; the first ancestor holding .git does.
  const fakeFs = (present) => ({ existsSync: (p) => present.includes(p) });
  eq(findRepoRoot('/host/_bmad-output/ai-factory', fakeFs(['/host/.git', '/host/_bmad-output/ai-factory/.git'])), '/host',
    'KI-E17: walk-up finds the HOST .git, never the factory submodule gitfile');
  eq(findRepoRoot('/host/tools/factory', fakeFs(['/host/.git'])), '/host', 'KI-E17: any mount depth resolves to the enclosing repo');
  eq(findRepoRoot('/nowhere/factory', fakeFs([])), null, 'KI-E17: no enclosing repo -> null (standalone checkout)');
  eq(resolveRepoRoot('/x/factory', { FACTORY_REPO_ROOT: '/override' }, fakeFs([])), '/override', 'KI-E17: FACTORY_REPO_ROOT env wins');
  eq(resolveRepoRoot('/a/b/factory', {}, fakeFs([])), '/a', 'KI-E17: git-less fallback stays the legacy ../..');
  // config rewrite: identity at the stock mount; prefix-swap (root + every paths entry) elsewhere.
  const mk = () => ({ root: STOCK_MOUNT, auditRoot: '_bmad-output/YOUR-AUDIT', paths: { ledger: STOCK_MOUNT + '/state/ledger.json', agents: STOCK_MOUNT + '/agents' } });
  eq(swapMountPrefix(mk(), STOCK_MOUNT, STOCK_MOUNT).paths.ledger, STOCK_MOUNT + '/state/ledger.json', 'KI-E17: stock mount is untouched (the host project layout identical)');
  const moved = swapMountPrefix(mk(), STOCK_MOUNT, 'tools/factory');
  eq(moved.root, 'tools/factory', 'KI-E17: root rewritten onto the real mount');
  eq(moved.paths.agents, 'tools/factory/agents', 'KI-E17: every paths entry rewritten');
  eq(moved.auditRoot, '_bmad-output/YOUR-AUDIT', 'KI-E17: non-stock-prefixed paths (auditRoot) are untouched');
  // driver source contract: detection + overlay + rewrite are wired in.
  const dsrc17 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc17.includes('resolveRepoRoot(FACTORY_ROOT, process.env)') && dsrc17.includes('swapMountPrefix(cfg, STOCK_MOUNT, MOUNT_REL)')
    && dsrc17.includes('factory.config.local.json'), 'KI-E17: driver wires root detection + local overlay + mount rewrite');
}

// KI-E18: AcceptanceScan clause splitter — semicolons, sentence boundaries, abbreviation guard,
// fragment filter, cap-merge; plus the factory.js inline-copy parity pin.
{
  eq(splitAcceptanceClauses('page/pageSize are clamped before Skip/Take; skip arithmetic is computed in a wider type; hostile page=2147483647 returns 200 with an empty page, never a 500.').length, 3, 'KI-E18: semicolon acceptance splits into 3 clauses');
  eq(splitAcceptanceClauses('Clamped before Skip/Take. Hostile page=2147483647 returns 200 with an empty page.').length, 2, 'KI-E18: sentence boundary splits (path dots do not)');
  eq(splitAcceptanceClauses('Use the pattern e.g. HMACSHA256 for the token hash. The guard throws on a placeholder value.').length, 2, 'KI-E18: e.g. does not split; a real boundary does');
  ok(splitAcceptanceClauses('Use the pattern e.g. HMACSHA256 for the token hash. The guard throws on a placeholder value.')[0].includes('e.g. HMACSHA256'), 'KI-E18: abbreviation guard restores the space');
  eq(splitAcceptanceClauses('a; b; tiny').length, 0, 'KI-E18: sub-20-char fragments are dropped');
  eq(splitAcceptanceClauses(''), [], 'KI-E18: empty acceptance -> no clauses');
  const many = Array.from({ length: 12 }, (_, i) => `Clause number ${i} is long enough to count here`).join('; ');
  const capped = splitAcceptanceClauses(many, 8);
  eq(capped.length, 8, 'KI-E18: cap bounds the clause count');
  ok(capped[7].includes('Clause number 11'), 'KI-E18: the tail merges into the last clause (never dropped)');
  // Inline parity: factory.js carries a byte-identical copy (the Workflow runtime cannot import).
  const fsrcAcc = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  const asrcAcc = readFileSync(join(import.meta.dirname, 'acceptance.mjs'), 'utf8');
  const bodyOf = (s) => { const m = s.match(/function splitAcceptanceClauses[\s\S]*?\n\}/); return m ? m[0] : null; };
  eq(bodyOf(fsrcAcc), bodyOf(asrcAcc.replace('export function splitAcceptanceClauses', 'function splitAcceptanceClauses')), 'KI-E18: factory.js inline splitter is byte-identical to lib/acceptance.mjs');
  ok(fsrcAcc.includes('const ACCEPT_SCHEMA') && fsrcAcc.includes("'probe:acceptance-scan'") && fsrcAcc.includes('acceptance-probe'), 'KI-E18: factory wires ACCEPT_SCHEMA + the acceptance-probe stage + the gates key');
}

// KI-E19: evidence-manifest markers — keyed FACTORY::SUMMARY lines override the heuristic parses;
// the suite's counts survive a later filter append (the recovery-transcript near-miss); legacy
// transcripts parse exactly as before.
{
  const legacy = 'FACTORY::BUILD::RESULT exit=0 errors=0\nPassed!  - Failed: 0, Passed: 10, Skipped: 1, Total: 11\nFACTORY::TEST::SUITE::RESULT exit=0\n';
  eq(parseVerifyRaw(legacy).suite, { failed: 0, passed: 10, skipped: 1 }, 'KI-E19: legacy transcript (no SUMMARY markers) parses as before');
  const manifest = 'FACTORY::BUILD::RESULT exit=0 errors=0\nFACTORY::SUMMARY::build exit=0 errors=0\n'
    + 'Failed!  - Failed: 2, Passed: 8, Skipped: 0, Total: 10\nFACTORY::TEST::SUITE::RESULT exit=1\nFACTORY::SUMMARY::suite exit=1 failed=2 passed=8 skipped=0\n'
    + 'Passed!  - Failed: 0, Passed: 1, Skipped: 0, Total: 1\nFACTORY::TEST::FILTER::RESULT exit=0\nFACTORY::SUMMARY::filter exit=0\n';
  const pm = parseVerifyRaw(manifest);
  eq(pm.suite, { failed: 2, passed: 8, skipped: 0 }, 'KI-E19: suite counts come from the KEYED marker — a later filter append cannot shadow them');
  eq(pm.suiteExit, 1, 'KI-E19: suite exit from the keyed marker');
  ok(pm.build && pm.build.exit === 0 && pm.targetedFail === false, 'KI-E19: build + filter keyed markers parsed');
  ok(!verdictFromParse(pm, 0).pass, 'KI-E19: the manifest-parsed suite failure FAILS the verdict (the ambient last dotnet line would have passed it)');
  const noCounts = parseVerifyRaw('FACTORY::SUMMARY::suite exit=1 failed=-1 passed=-1 skipped=-1\n');
  ok(noCounts.suiteExit === 1 && noCounts.suite === null, 'KI-E19: failed=-1 (no dotnet summary line) sets exit only, never fake counts');
  const dsrc19 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc19.includes('KI-E19') && dsrc19.includes('build+suite green PAIR'), 'KI-E19: driver enforces the FULL-band build+suite pair rule');
  ok(dsrc19.includes("event: 'usage'") && dsrc19.includes('band: r.band || undefined'), 'KI-E23: fold emits the usage event + stamps band on item_folded');
  const bt19 = readFileSync(join(import.meta.dirname, '..', '..', 'verify', 'build-test.sh'), 'utf8');
  ok(bt19.includes('FACTORY::SUMMARY::build') && bt19.includes('FACTORY::SUMMARY::filter') && bt19.includes('FACTORY::SUMMARY::suite') && bt19.includes('FACTORY::SUMMARY::red'), 'KI-E19: build-test.sh trails every subcommand with a keyed SUMMARY marker');
}

// KI-E20: recover scaffold — pure helpers (dissent digest, role mapping, transition shapes, skeleton).
{
  const gd = {
    'gate:qa': { verdict: 'CHANGES_REQUIRED', headline: 'h', findings: [{ severity: 'HIGH', title: 't' }] },
    'gate:po': { verdict: 'APPROVED', headline: 'ok', findings: [] },
    'gate:qa:re-gate': { verdict: 'CHANGES_REQUIRED', headline: 'dup', findings: [] },
    'probe:acceptance-scan': { verdict: 'CHANGES_REQUIRED', headline: 'probe', findings: [] },
    'review:review-adversarial-general': { verdict: 'CHANGES_REQUIRED', headline: 'adv', findings: [] },
    'adjudicator': { verdict: 'UPHELD', headline: 'a' },
  };
  eq(dissentersFrom(gd).map((d) => d.key), ['gate:qa', 'review:review-adversarial-general'], 'KI-E20: dissenters = CHANGES_REQUIRED only; re-gate + probe rows excluded');
  eq(roleForGateKey('gate:security'), 'gate-security', 'KI-E20: gate key -> role');
  eq(roleForGateKey('review:review-adversarial-general'), 'review-adversarial', 'KI-E20: adversarial review key -> brief role');
  eq(roleForGateKey('review:code-review'), 'review-code', 'KI-E20: code-review key -> brief role');
  eq(roleForGateKey('probe:leftover-scan'), null, 'KI-E20: probe keys have no re-gate role');
  eq(recoveryTransitions('FAILED')[0], 'CLAIMED', 'KI-E20: FAILED recovery walks the full chain from CLAIMED');
  eq(recoveryTransitions('ESCALATED'), ['CLOSED'], 'KI-E20: ESCALATED recovery is the single CLOSED hop (KI-L62)');
  eq(priorCycleOf({ resultId: 'X-1#46' }, 9), 46, 'KI-E20: recovery cycle parsed from the prior checkpoint');
  eq(priorCycleOf(null, 9), 9, 'KI-E20: no checkpoint -> fallback cycle');
  const sk = recoveryFoldSkeleton('X-1', { state: 'FAILED', worktree: 'wt', branch: 'b' }, { codeChange: true, needsRealInfra: false, rootCauseFiles: ['a.cs'], integrateRaw: true, resultId: 'X-1#46' }, 46);
  eq(sk.resultId, 'X-1#46r', 'KI-E20: skeleton resultId is #<cycle>r');
  eq(sk.attemptsDelta, 0, 'KI-E20: a recovery consumes no retry budget');
  ok(sk.codeChange === true && sk.integrateRaw === true && sk.transitions.length === 10, 'KI-E20: machine-evidence flags carry over; the FAILED chain has 10 hops');
  const dsrc20 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc20.includes("case 'recover'") && dsrc20.includes('recovery_prepared') && dsrc20.includes('mutation-proof.txt'), 'KI-E20: driver wires recover + telemetry + the evidence contract');
  ok(dsrc20.includes("case 'decisions-digest'") && dsrc20.includes('Rule-together bundles'), 'KI-E24: driver wires the ranked owner-decision digest');
}

// KI-E22: acceptance-surface lint (the KI-E16 generalization) — pure heuristic over injected IO.
{
  const idx22 = buildBasenameIndex(['SvcA/src/Api/ItemsController.cs', 'SvcA/src/Api/OrdersController.cs', 'SvcB/src/Api/OrdersController.cs', 'doc/data-flows/SvcA.md']);
  const io22 = { existsOnDisk: (p) => ['doc/data-flows/SvcA.md', 'SvcA'].includes(p), byBasename: idx22, targetDir: 'SvcA' };
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ItemsController clamps page and pageSize before querying.', files: ['SvcA/src/Clients/ItemsClient.cs'] }, io22).map((g) => g.resolved), ['SvcA/src/Api/ItemsController.cs'], 'KI-E22: uniquely-resolving PascalCase type -> gap when files[] lacks it');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ItemsController clamps input.', files: ['SvcA/src/Api/ItemsController.cs'] }, io22).length, 0, 'KI-E22: no gap when files[] carries the surface');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ItemsController clamps input.', files: ['x/ItemsController.cs'] }, io22).length, 0, 'KI-E22: a basename match in files[] suffices');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'OrdersController clamps as well.', files: [] }, io22).map((g) => g.resolved), ['SvcA/src/Api/OrdersController.cs'], 'KI-E22: target-dir-unique wins over a cross-service basename collision');
  eq(acceptanceSurfaceGaps({ target: null, acceptance: 'OrdersController clamps.', files: [] }, { ...io22, targetDir: null }).length, 0, 'KI-E22: a globally-ambiguous token is silently skipped (advisory lint, no noise)');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'doc/data-flows/SvcA.md documents the mapped route.', files: ['SvcA/README.md'] }, io22).map((g) => g.resolved), ['doc/data-flows/SvcA.md'], 'KI-E22: an existing path-like token -> gap');
  const dsrc22 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc22.includes('ACCEPT-SURFACE') && dsrc22.includes('KI-E22 WARN'), 'KI-E22: graph-audit reports + group-time advisory warn wired');
  ok(dsrc22.includes('ledger-path append(s) (KI-E16)'), 'KI-E16: graph-audit --fix appends the ledger path for shared-file gaps');
  ok(dsrc22.includes('SWEEP CANDIDATE (KI-E21)'), 'KI-E21: suggest recommends the sweep channel for large homogeneous clusters');

  // KI-E32: a token in a reference / citation / exclusion context is NOT flagged as a missing edit target
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'A new endpoint modeled on the existing ItemsController for parity.', files: [] }, io22).length, 0, 'KI-E32: "modeled on X" is a reference, not a gap');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'Uses the same chain OrdersController uses today.', files: [] }, io22).length, 0, 'KI-E32: trailing "X uses" reads as a reference, not a gap');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ResolveThing at doc/data-flows/SvcA.md:42 explains it.', files: ['SvcA/README.md'] }, io22).length, 0, 'KI-E32: a File:line citation is a reference, not a gap');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'Do NOT touch OrdersController; leave it alone.', files: [] }, io22).length, 0, 'KI-E32: "do NOT touch X" exclusion is not a gap');
  // …but an ACTIVELY-named edit target still surfaces (the heuristic stays conservative)
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ItemsController clamps page before querying.', files: [] }, io22).map((g) => g.resolved), ['SvcA/src/Api/ItemsController.cs'], 'KI-E32: an actively-named surface is still a gap (no over-suppression)');
}

// KI-E31: the fold path accepts the Workflow harness envelope directly
{
  const payload = { mode: 'run', cycle: 3, results: [{ id: 'WI-A', toState: 'CLOSED' }] };
  eq(unwrapResultEnvelope({ summary: 's', agentCount: 4, logs: [], result: payload }), payload, 'KI-E31: {…,result:{…}} envelope unwraps to the fold payload');
  eq(unwrapResultEnvelope(payload), payload, 'KI-E31: a direct results object passes through unchanged');
  const arr = [{ id: 'WI-A', toState: 'CLOSED' }];
  eq(unwrapResultEnvelope(arr), arr, 'KI-E31: a bare results array passes through unchanged');
  // a business object that merely has a `.result` field (not the Workflow envelope) is NOT unwrapped
  const notEnv = { result: { verdict: 'ok' }, results: [{ id: 'X' }] };
  eq(unwrapResultEnvelope(notEnv), notEnv, 'KI-E31: an object already carrying .results is not unwrapped (backward-compatible)');
}

// KI-E18/KI-E23 exec-smoke: the acceptance-scan stage runs pre-band — a gap triggers ONE bounded
// amend + re-probe (lane closes); a persistent gap FAILS pre-band with clause-level feedback;
// editorial verdicts land in the gates map; the run returns a usage counter.
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  const twoClause = 'The README documents the actual mapped route for the probe; the probe example curls the mapped route successfully.';
  const b1 = smokeBatch(); b1.items = b1.items.filter((it) => it.id === 'SMOKE-DOC'); b1.items[0].acceptance = twoClause;
  let probeCalls = 0;
  const r1 = await execSmoke(src, b1, {
    agentOverride: (prompt, opts) => {
      if ((opts && opts.label) === 'SMOKE-DOC:acceptance-probe') {
        probeCalls++;
        return probeCalls === 1 ? { covered: false, gaps: [{ clause: 'the probe example curls the mapped route successfully', why: 'no curl evidence in the diff' }] } : { covered: true, gaps: [] };
      }
      return undefined;
    },
  });
  const d1 = (r1.result.results || [])[0];
  eq(probeCalls, 2, 'KI-E18 smoke: gap -> amend -> re-probe (exactly two probe calls)');
  eq(d1 && d1.toState, 'CLOSED', 'KI-E18 smoke: the amended item proceeds to CLOSED');
  eq(d1 && d1.gates && d1.gates['probe:acceptance-scan'], 'APPROVED', 'KI-E18 smoke: the final probe verdict is recorded');
  ok(r1.calls.filter((c) => c.label === 'SMOKE-DOC:fixer').length >= 2, 'KI-E18 smoke: the bounded amend ran the fixer');
  eq(d1 && d1.gates && d1.gates['editorial:structure'], 'APPROVED', 'KI-E23 smoke: the advisory editorial verdict is recorded in the gates map');
  eq(d1 && d1.band, 'LIGHT', 'KI-E23 smoke: the result carries its band');
  ok(r1.result && r1.result.usage && typeof r1.result.usage.outputTokens === 'number', 'KI-E23 smoke: the run returns a usage counter');
  const b2 = smokeBatch(); b2.items = b2.items.filter((it) => it.id === 'SMOKE-DOC'); b2.items[0].acceptance = twoClause;
  const r2 = await execSmoke(src, b2, {
    agentOverride: (prompt, opts) => {
      if ((opts && opts.label) === 'SMOKE-DOC:acceptance-probe') return { covered: false, gaps: [{ clause: 'the probe example curls the mapped route successfully', why: 'still no evidence' }] };
      return undefined;
    },
  });
  const d2 = (r2.result.results || [])[0];
  eq(d2 && d2.toState, 'FAILED', 'KI-E18 smoke: a persistent gap FAILS pre-band');
  ok(String((d2 && d2.note) || '').startsWith('acceptance-scan (KI-E18)'), 'KI-E18 smoke: the fail note carries the clause-level feedback');
  ok(d2 && d2.gateDetails && d2.gateDetails['probe:acceptance-scan'] && d2.gateDetails['probe:acceptance-scan'].findings.length === 1, 'KI-E18 smoke: gateDetails carry the gap findings for feedback.md');
}

// ---- KI-E27: multi-source ingestion mappers -------------------------------------------------
{
  // severity + theme from labels
  eq(severityFromLabels([{ name: 'bug' }, { name: 'P1' }]), 'HIGH', 'ingest: P1 label -> HIGH');
  eq(severityFromLabels(['critical']), 'CRITICAL', 'ingest: critical label -> CRITICAL');
  eq(severityFromLabels([], 'LOW'), 'LOW', 'ingest: no label -> fallback severity');
  eq(severityFromLabels([]), 'MEDIUM', 'ingest: no label, no fallback -> MEDIUM');
  eq(themeFromLabels([{ name: 'security' }]), 'security', 'ingest: security label -> security theme (escalate routing)');
  eq(themeFromLabels([{ name: 'CRM' }]), 'crm-link-integrity', 'ingest: CRM label -> crm-link-integrity theme');
  eq(themeFromLabels([]), 'triage', 'ingest: unmatched label -> triage theme');

  // extractSection pulls a markdown section, stops at the next same-or-shallower heading
  const body = '## Summary\nx\n## Expected behavior\nClicking opens the record.\nSecond line.\n## Impact\ny';
  eq(extractSection(body, ['expected behaviou?r']), 'Clicking opens the record.\nSecond line.', 'ingest: extractSection lifts the section body and stops at the next heading');
  eq(extractSection(body, ['nonexistent']), null, 'ingest: extractSection returns null when the heading is absent');

  // an issue WITH an acceptance section -> escalate/non-trivial, files[] empty, source stamped, never auto
  const withAcc = githubIssueToItem(
    { number: 1716, title: 'Open in CRM opens the activity', body, labels: [{ name: 'bug' }, { name: 'CRM' }] },
    { repo: 'jooooel/seqaro', idPrefix: 'GH' });
  eq(withAcc.id, 'GH-1716', 'ingest: github id is prefix + issue number');
  eq(withAcc.autonomyTier, 'escalate', 'ingest: acceptance section found -> escalate (human confirms), never auto');
  eq(withAcc.fixType, 'non-trivial', 'ingest: acceptance section found -> non-trivial');
  eq(withAcc.theme, 'crm-link-integrity', 'ingest: theme routed from labels');
  eq(withAcc.source, 'jooooel/seqaro#1716', 'ingest: source stamps repo#number');
  eq(withAcc.files, [], 'ingest: files[] starts empty — the human authors the lock set');
  ok(/^[A-Z0-9]+(-[A-Z0-9]+)+$/.test(withAcc.id), 'ingest: generated id is schema-valid');

  // an issue WITHOUT an acceptance section -> blocked triage / owner-decision, with a triage ownerDecision
  const noAcc = githubIssueToItem({ number: 42, title: 'Vague thing', body: 'no structure here', labels: [] }, { repo: 'o/r' });
  eq(noAcc.autonomyTier, 'blocked', 'ingest: no acceptance section -> blocked triage (never auto-runs)');
  eq(noAcc.fixType, 'owner-decision', 'ingest: no acceptance section -> owner-decision');
  ok(!!noAcc.ownerDecision, 'ingest: triage item carries an ownerDecision prompt');
  ok(!!noAcc.acceptance && !!noAcc.regressionTest, 'ingest: triage item still fills acceptance/regressionTest so merge-graph validation passes (as triage text)');

  // markdown checklist -> one blocked item per unchecked box
  const items = markdownChecklistToItems('- [ ] First task\n- [x] done already\nnot a task\n* [ ] Second task', { idPrefix: 'BL' });
  eq(items.length, 3, 'ingest: markdown picks up every checklist line (checked or not)');
  eq(items[0].id, 'BL-1', 'ingest: markdown id is prefix + 1-based index');
  eq(items.every((i) => i.autonomyTier === 'blocked'), true, 'ingest: markdown items are all blocked triage');

  // report split
  const rep = ingestReport([withAcc, noAcc, ...items]);
  eq(rep.total, 5, 'ingest: report totals every item');
  eq(rep.escalate, 1, 'ingest: report counts the one escalate item');
  eq(rep.blocked, 4, 'ingest: report counts the blocked-triage items');
}

// KI-E33: cost-telemetry readiness probe (pure over injected env)
{
  eq(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }).ready, true, 'KI-E33: enable=1 + endpoint set -> ready');
  eq(costTelemetryReady({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }).ready, false, 'KI-E33: no CLAUDE_CODE_ENABLE_TELEMETRY -> not gathered');
  eq(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: '1' }).ready, false, 'KI-E33: no OTLP endpoint -> not gathered');
  eq(costTelemetryReady({ FACTORY_TELEMETRY: '0', CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'x' }).ready, false, 'KI-E33: FACTORY_TELEMETRY=0 disables regardless');
  ok(/telemetry\/claude-code-telemetry\.env\.example|CLAUDE_CODE_ENABLE_TELEMETRY/.test(readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8')), 'KI-E33: driver preflight surfaces the cost-telemetry cue');
}

console.log(`\nself-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
