// Self-test for the factory lib (run: node _bmad-output/ai-factory/_workflow/lib/_selftest.mjs).
// Exercises the state machine, deps/locks READY computation, fold, and atomic I/O —
// the Phase-0 acceptance surface that does not need the Workflow runtime.
import { mkdtempSync, mkdirSync, writeFileSync as fsWrite, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve as resolvePath, sep } from 'node:path';
import {
  emptyLedger, syncFromGraph, transition, foldResults, canTransition,
  countByState, writeJsonAtomic, readJson, unwrapResultEnvelope, FORWARD,
  reconcileToStateAndTransitions, deriveUnfoldedCycle,
} from './ledger.mjs';
import { computeReady, waitingOnDeps } from './graph.mjs';
import { isFactoryWorktreePath } from './worktree.mjs';
import { makeLimiter, pool, retry } from './pool.mjs';
import { loadRouting, resolve } from './router.mjs';
import { conflictFor, lockedFiles } from './locks.mjs';
import { parseVerifyRaw, verdictFromParse, debrisFiles, parseRedRaw, hasRealInfraMarker, touchedRootCause, effectiveBaseline, decodeTranscript } from './verify.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { checkRoutingDrift, buildFactoryRouting } from './routing-drift.mjs';
import { changedFiles } from './worktree.mjs';
import { classifyFilesEntry, buildBasenameIndex, acceptanceSurfaceGaps } from './graphaudit.mjs';
import { renderFeedback } from './feedback.mjs';
import { gateFindingsSummary, isStrictlyNarrower, applyConvergenceBonus, effectiveRetryBound } from './convergence.mjs';
import { sig, jaccard, similarSigs, clusterBySimilarity, batchPatternFor, perCliqueBatchPatterns, bestClosedPrecedent } from './similarity.mjs';
import { loadController, isStale as controllerStale, claimController, verifyController, releaseController } from './controller.mjs';
import { execSmoke, smokeBatch } from './_execsmoke.mjs';
import { classifyLine as loClassify, firstLexeme as loLexeme, findLeftovers } from './leftover-scan.mjs';
import { classifyCommentLine as csClassify, findComments } from './comment-scan.mjs';
import { splitAcceptanceClauses } from './acceptance.mjs';
import { dissentersFrom, roleForGateKey, recoveryTransitions, recoveryFoldSkeleton, priorCycleOf } from './recover.mjs';
import { extractHeadings, buildDocMap, readRoleBriefs, readRepoProfiles, PROFILE_CAP } from './promptpack.mjs';
import { loadPolicies, renderPolicies, POLICY_TEXT } from './policy.mjs'; // PR#9 review — host-policy seam
import { githubIssueToItem, markdownChecklistToItems, extractSection, severityFromLabels, themeFromLabels, ingestReport, enforceIngestTier, countCheckedBoxes } from './ingest.mjs';
import { costTelemetryReady, shimAvailable, dotnetAvailable } from './preflight.mjs';
import { shouldRunArchaeology } from './archaeology.mjs'; // KI-E75
import { chmodSync } from 'node:fs';
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

  // KI-E70 — ITEM-H1 live shape (2026-08-07): a runner filters SEVERAL DISTINCT test classes in one
  // verify pass (not a same-class retry); the LAST class's failure must be attributed BY NAME, not
  // reported as a vague singular "the targeted regression test".
  const multiClass = 'FACTORY::BUILD::RESULT exit=0 errors=0\n'
    + 'FACTORY::TEST::FILTER::START /p/A.csproj :: ClassATests\n     Passed: 3\nFACTORY::TEST::FILTER::RESULT exit=0\nFACTORY::SUMMARY::filter exit=0\n'
    + 'FACTORY::TEST::FILTER::START /p/A.csproj :: ClassBTests\n     Passed: 6\nFACTORY::TEST::FILTER::RESULT exit=0\nFACTORY::SUMMARY::filter exit=0\n'
    + 'FACTORY::TEST::FILTER::START /p/A.csproj :: ClassETests\n     Failed: 1\nFACTORY::TEST::FILTER::RESULT exit=1\nFACTORY::SUMMARY::filter exit=1\n';
  const pmc = parseVerifyRaw(multiClass);
  eq(pmc.targetedFail, true, 'parseVerifyRaw: multi-class transcript, last class failing -> targetedFail true');
  eq(pmc.targetedFailClass, 'ClassETests', 'KI-E70: targetedFailClass names the LAST class, not the first-run one');
  eq(verdictFromParse(pmc, 0).reason, 'targeted regression test did not pass (ClassETests)', 'KI-E70: verdict reason names the specific failing class');
  // Same-class retry still attributes correctly (no regression from the class-pairing addition).
  const retrySameClass = 'FACTORY::TEST::FILTER::START /p/A.csproj :: FooTests\nFACTORY::TEST::FILTER::RESULT exit=1\nFACTORY::TEST::FILTER::START /p/A.csproj :: FooTests\nFACTORY::TEST::FILTER::RESULT exit=0\n';
  eq(parseVerifyRaw(retrySameClass).targetedFailClass, null, 'KI-E70: a retry that ends green carries no targetedFailClass (targetedFail is false)');
  // A transcript with no FILTER::START at all (e.g. a bare/legacy marker) degrades to no class name,
  // never a crash or a fabricated attribution.
  eq(parseVerifyRaw('FACTORY::TEST::FILTER::RESULT exit=1').targetedFailClass, null, 'KI-E70: no START marker present -> targetedFailClass stays null, not fabricated');
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

// KI-E54 — decodeTranscript: BOM-aware decode so a UTF-16-emitting producer (e.g. a subagent's `tee`
// crossing into a PowerShell-hosted shell, where `tee`/Out-File/`>` default to UTF-16LE) never silently
// mis-decodes a fold-time transcript read into unparseable mojibake.
{
  const plain = 'FACTORY::RED::START foo\nFACTORY::RED::1\n';
  eq(decodeTranscript(Buffer.from(plain, 'utf8')), plain, 'decodeTranscript: plain UTF-8/ASCII (no BOM) decodes byte-identically to the old hardcoded utf8 read');
  const utf16le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(plain, 'utf16le')]);
  eq(decodeTranscript(utf16le), plain, 'decodeTranscript: UTF-16LE BOM (PowerShell tee/Out-File/> default) decodes back to the original ASCII text');
  ok(parseRedRaw(decodeTranscript(utf16le)).hasData && parseRedRaw(decodeTranscript(utf16le)).exit === 1, 'decodeTranscript: a UTF-16LE-mangled verify-red-raw.txt now round-trips through parseRedRaw correctly (the live KI-E54 failure mode)');
  const beBytes = Buffer.from(plain, 'utf16le');
  for (let i = 0; i + 1 < beBytes.length; i += 2) { const t = beBytes[i]; beBytes[i] = beBytes[i + 1]; beBytes[i + 1] = t; }
  const utf16be = Buffer.concat([Buffer.from([0xFE, 0xFF]), beBytes]);
  eq(decodeTranscript(utf16be), plain, 'decodeTranscript: UTF-16BE BOM also decodes back to the original ASCII text');
  const utf8bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(plain, 'utf8')]);
  eq(decodeTranscript(utf8bom), plain, 'decodeTranscript: UTF-8 BOM is stripped');
  eq(decodeTranscript(Buffer.alloc(0)), '', 'decodeTranscript: empty buffer -> empty string, never throws');
  const dsrc54 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc54.includes("decodeTranscript(readFileSync(p)) : null") && dsrc54.includes('parseVerifyRaw(decodeTranscript(readFileSync(p)))'), 'KI-E54: driver wires decodeTranscript at BOTH fold-time transcript read sites (readIf + the inline baseline-raw.txt read)');
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
  // KI-E62 (P1) — perCliqueBatchPatterns: a MIXED batch stamps each qualifying sub-clique
  // independently instead of stripping the stamp from EVERY item the moment the whole batch
  // isn't one clique.
  const perClique = perCliqueBatchPatterns([A, B, C, D]);
  eq(perClique.get('S-A'), pat, 'similarity: perCliqueBatchPatterns stamps a clique member with the SAME text batchPatternFor(clique) produces');
  eq(perClique.get('S-B'), pat, 'similarity: perCliqueBatchPatterns stamps BOTH clique members with the identical pattern string');
  ok(!perClique.has('S-C'), 'similarity: perCliqueBatchPatterns leaves a dissimilar singleton unstamped');
  ok(!perClique.has('S-D'), 'similarity: perCliqueBatchPatterns leaves a different-theme singleton unstamped');
  eq(perClique.size, 2, 'similarity: perCliqueBatchPatterns stamps exactly the clique members, nothing else, from a 4-item mixed batch');
  // Strictly-additive parity: when the WHOLE batch IS one clique, perCliqueBatchPatterns must
  // produce the IDENTICAL stamp batchPatternFor(items) already did — P1 must never regress the
  // pre-existing whole-batch-is-one-clique case.
  const wholeBatchClique = perCliqueBatchPatterns([A, B]);
  eq(wholeBatchClique.get('S-A'), batchPatternFor([A, B]), 'similarity: perCliqueBatchPatterns([A,B]) matches batchPatternFor([A,B]) exactly when the whole batch is one clique');
  eq(wholeBatchClique.get('S-B'), batchPatternFor([A, B]), 'similarity: perCliqueBatchPatterns whole-batch-clique parity holds for every member, not just the first');
  eq(perCliqueBatchPatterns([A]).size, 0, 'similarity: perCliqueBatchPatterns([singleton]) stamps nothing');
  eq(perCliqueBatchPatterns([A, C]).size, 0, 'similarity: perCliqueBatchPatterns([mixed-shape pair]) stamps nothing (both singletons in the cluster sense)');
  // wiring pins: driver stamps (per-clique) + forwards per-item, factory briefs, cluster.mjs consumes the shared rule
  const drv = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(drv.includes('perCliqueBatchPatterns(picked)'), 'similarity: group auto-stamps PER-CLIQUE patterns from the picked batch (KI-E62)');
  ok(drv.includes('batchPatternById.get(wi.id) || undefined'), 'similarity: group forwards the per-item stamp lookup on every item entry (KI-E62)');
  // KI-E62 follow-on: suggest's own batch-pattern preview must reflect the SAME per-clique rule
  // group actually applies, not the retired whole-batch-only check — otherwise a pick(false)
  // fallback batch (file-disjoint, not all-pairs similar) previews "none" for a batch group WOULD
  // actually stamp a qualifying sub-clique within.
  ok(!drv.includes("const pattern = batchPatternFor(batch);"), 'similarity: suggest preview no longer uses the retired whole-batch-only batchPatternFor(batch) check (KI-E62)');
  ok(drv.includes('const perClique = perCliqueBatchPatterns(batch);'), 'similarity: suggest preview uses perCliqueBatchPatterns(batch) to match group\'s real per-clique stamping (KI-E62)');
  ok(drv.includes('AUTO, per-clique (KI-E62): '), 'similarity: suggest preview reports a partial per-clique stamp distinctly from a whole-batch stamp');
  // KI-E62 live-caught regression (2026-08-02): the batchPattern -> batchPatternById rename left a
  // BARE `batchPattern` reference in the run_prepared telemetry emit, far below the rename site —
  // a ReferenceError that crashed EVERY real (non-dry-run-only-in-imagination) `group` invocation.
  // Source-text pins on the rename sites alone did not catch this (they never execute cmdGroup);
  // caught only by an actual `driver.mjs group --dry` smoke run. Pinned here so this exact class
  // (a rename that misses a distant usage site) cannot silently regress again.
  ok(drv.includes('batchPattern: batchPatternById.size > 0'), 'similarity: run_prepared telemetry uses the renamed batchPatternById, not a bare (ReferenceError-crashing) batchPattern (KI-E62)');
  ok(drv.includes("case 'suggest': return cmdSuggest(flags);"), 'similarity: suggest command is dispatched');
  const fsrc = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(fsrc.includes('BATCH PATTERN — SIMILARITY BATCH: ') && fsrc.includes('structurally IDENTICAL'), 'similarity: factory briefs agents to keep sibling changes structurally identical');
  const csrc = readFileSync(join(import.meta.dirname, '..', 'cluster.mjs'), 'utf8');
  ok(csrc.includes("from './lib/similarity.mjs'"), 'similarity: cluster.mjs imports the shared rule (single source of truth)');

  // KI-E63 (R2) — bestClosedPrecedent: the single, MOST-RECENTLY-closed matching sibling from a
  // pool of already-CLOSED items, scoped the same way batch-pattern matching is (same theme +
  // similarSigs), but one-item-vs-pool rather than N-items-vs-each-other (no clustering needed).
  const closedPool = [
    { id: 'OLD-1', target: 'SvcX', theme: 'deploy', title: B.title, closedAt: '2026-07-01T00:00:00Z' },
    { id: 'OLD-2', target: 'SvcY', theme: 'deploy', title: B.title, closedAt: '2026-07-15T00:00:00Z' },
    { id: 'OLD-3', target: 'SvcZ', theme: 'crypto', title: B.title, closedAt: '2026-07-20T00:00:00Z' },
    { id: 'OLD-4', target: 'SvcW', theme: 'deploy', title: 'logging format change for structured output', closedAt: '2026-07-25T00:00:00Z' },
  ];
  const prec = bestClosedPrecedent(A, closedPool);
  ok(!!prec, 'similarity: bestClosedPrecedent finds a matching already-closed sibling for a same-shape item');
  eq(prec && prec.id, 'OLD-2', 'similarity: bestClosedPrecedent picks the MOST RECENT qualifying match (OLD-2), not the first (OLD-1) or a cross-theme/dissimilar one (OLD-3/OLD-4)');
  eq(bestClosedPrecedent(C, closedPool), null, 'similarity: bestClosedPrecedent returns null when no closed candidate matches the item\'s shape (same-theme OLD-4 is unrelated prose, not a shape match)');
  eq(bestClosedPrecedent(A, [{ id: 'S-A', target: 'SvcA', theme: 'deploy', title: B.title, closedAt: '2099-01-01' }]), null, 'similarity: bestClosedPrecedent excludes a candidate sharing the item\'s OWN id');
  eq(bestClosedPrecedent(A, []), null, 'similarity: bestClosedPrecedent([], ) returns null on an empty pool');
  eq(bestClosedPrecedent(A, null), null, 'similarity: bestClosedPrecedent tolerates a null pool (defensive)');
  // wiring pins: driver builds the closed-candidate pool + existence-checks before stamping, forwards per-item
  ok(drv.includes('bestClosedPrecedent(wi, closedCandidates)'), 'similarity: group looks up a precedent for each picked item (KI-E63)');
  ok(drv.includes('if (!hasFix && !hasWt) continue;'), 'similarity: group NEVER stamps a precedent whose evidence is not actually present on disk (KI-E63)');
  ok(drv.includes('precedent: precedentByItem.get(wi.id) || undefined'), 'similarity: group forwards the per-item precedent stamp on every item entry (KI-E63)');
  ok(fsrc.includes('PRECEDENT — a gate-APPROVED instance of this exact change-shape already CLOSED: '), 'factory: precedent block present in shared prefix (KI-E63)');
  ok(fsrc.includes('never Edit it, never touch its files'), 'factory: precedent is explicitly framed as read-only, foreign-item reference material (KI-E63)');
  const opsrc63 = readFileSync(join(import.meta.dirname, '..', 'opencode', 'compose.mjs'), 'utf8');
  ok(opsrc63.includes('PRECEDENT — a gate-APPROVED instance of this exact change-shape already CLOSED: '), 'opencode compose: KI-E63 precedent block ported (runtime parity)');
  ok(opsrc63.includes('never Edit it, never touch its files'), 'opencode compose: KI-E63 read-only framing ported (runtime parity)');
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
  ok(String((by['SMOKE-SCOPESTOP'] && by['SMOKE-SCOPESTOP'].note) || '').includes('gate headline: stub genuine red-line'), 'KI-E30 (review fix): the flagging gate headline reaches the queue-visible block note');
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

// KI-E65: toState/transitions reconciliation — live bug (ITEM-30, cycle 57r): a recovery-fold.json
// set toState:'FAILED' (a CHANGES_REQUIRED gate) but left transitions ending in the skeleton's
// default success path ('...,CLOSED'); foldResults walked transitions and silently CLOSED a
// still-broken item. reconcileToStateAndTransitions must catch and correct this BEFORE fold.
{
  eq(reconcileToStateAndTransitions(null), null, 'KI-E65: null result is a no-op');
  eq(reconcileToStateAndTransitions({ id: 'X', toState: 'FAILED' }), null, 'KI-E65: no transitions array is a no-op (nothing to reconcile against)');
  eq(reconcileToStateAndTransitions({ id: 'X', transitions: ['RED', 'GREEN'] }), null, 'KI-E65: no toState is a no-op');
  eq(reconcileToStateAndTransitions({ id: 'X', toState: 'CLOSED', transitions: ['RED', 'GREEN', 'BUILT', 'CLOSED'] }), null, 'KI-E65: already-consistent (last element === toState) is a no-op, unmutated');

  // toState appears mid-array (over-ran its own stated ending) — truncate there.
  const rMid = { id: 'X', toState: 'FAILED', transitions: ['CLAIMED', 'RED', 'FAILED', 'GREEN', 'BUILT'] };
  const recMid = reconcileToStateAndTransitions(rMid);
  ok(!!recMid, 'KI-E65: mid-array toState mismatch is detected and reconciled');
  eq(rMid.transitions, ['CLAIMED', 'RED', 'FAILED'], 'KI-E65: mid-array case truncates AT the first occurrence of toState, dropping everything after');

  // toState absent from the array entirely (the live ITEM-30 shape) — walk backwards to the last
  // state canTransition allows to reach toState directly, then append it.
  const rLive = { id: 'ITEM-30', toState: 'FAILED', transitions: ['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED', 'INTEGRATED', 'CLOSED'] };
  const recLive = reconcileToStateAndTransitions(rLive);
  ok(!!recLive, 'KI-E65: toState absent from transitions (the live ITEM-30 shape) is detected');
  eq(rLive.transitions, ['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED', 'FAILED'], 'KI-E65: walks back to REAUDITED (the last ACTIVE state, a legal FAILED off-ramp) and appends toState — CLOSED/INTEGRATED are correctly skipped as illegal jump-off points');
  eq(recLive.before.join(','), 'CLAIMED,RED,GREEN,BUILT,TESTED,GATED,REFUTE_OK,REAUDITED,INTEGRATED,CLOSED', 'KI-E65: correction record preserves the original (pre-mutation) array for logging');

  // End-to-end regression pin: the exact live bug, run through the REAL fold path.
  const g65 = { items: [{ id: 'WI-65', target: 'X', severity: 'HIGH', fixType: 'non-trivial', files: ['a.cs'], dependsOn: [], autonomyTier: 'auto', layer: 'service', acceptance: '', regressionTest: '', gateSet: [], theme: 't', source: 's' }] };
  const l65 = emptyLedger('syn65'); syncFromGraph(l65, g65);
  transition(l65, 'WI-65', 'CLAIMED', 't'); transition(l65, 'WI-65', 'RED', 't'); transition(l65, 'WI-65', 'FAILED', 't');
  const liveShaped = { id: 'WI-65', resultId: 'WI-65#1r', toState: 'FAILED', gates: { 'gate:developer': 'CHANGES_REQUIRED' }, transitions: ['RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED', 'INTEGRATED', 'CLOSED'], attemptsDelta: 0 };
  reconcileToStateAndTransitions(liveShaped);
  foldResults(l65, [liveShaped]);
  eq(l65.items['WI-65'].state, 'FAILED', 'KI-E65 regression pin: a recovery-fold with toState=FAILED but transitions ending in CLOSED lands the row on FAILED end-to-end, not CLOSED (the exact live ITEM-30 bug)');
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

// KI-E35 (review fix): splitDriftByStatus — behavioral, throwaway real-git repo: only COMMITTED drift
// reads as human delivery; an uncommitted edit AND an untracked stray (the live ITEM-H5 shape,
// invisible to `git diff HEAD`) both stay in the contamination bucket.
{
  const { splitDriftByStatus } = await import('./mainguard.mjs');
  const { mkdtempSync: mk35, writeFileSync: wf35, rmSync: rm35 } = await import('node:fs');
  const root35 = mk35(join(tmpdir(), 'e35split-'));
  const g35 = (...a) => execFileSync('git', ['-C', root35, ...a], { encoding: 'utf8' });
  g35('init', '-q');
  wf35(join(root35, 'committed.txt'), 'v1');
  wf35(join(root35, 'modified.txt'), 'v1');
  g35('add', '.');
  g35('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base', '--no-gpg-sign', '--no-verify');
  wf35(join(root35, 'committed.txt'), 'v2');
  g35('add', 'committed.txt');
  g35('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'human delivery', '--no-gpg-sign', '--no-verify');
  wf35(join(root35, 'modified.txt'), 'v2');
  wf35(join(root35, 'untracked-new.txt'), 'stray');
  const s35 = splitDriftByStatus(root35, [{ file: 'committed.txt' }, { file: 'modified.txt' }, { file: 'untracked-new.txt' }]);
  eq(s35.committed.map((d) => d.file), ['committed.txt'], 'KI-E35: committed drift classifies as human delivery');
  eq(s35.dirty.map((d) => d.file), ['modified.txt', 'untracked-new.txt'], 'KI-E35: an uncommitted edit AND an untracked stray both classify as contamination (review fix)');
  rm35(root35, { recursive: true, force: true });
}

// KI-E61 (2026-08-02): repairDirtyDrift — auto-repair for exactly the dirty bucket splitDriftByStatus
// proves is agent contamination (never human delivery). A present->changed file restores from HEAD;
// an absent->present file (a stray the worktree agent created) is removed; a repair failure on one
// path is recorded on that entry and never thrown (a partial repair must not crash the fold).
{
  const { splitDriftByStatus: sds66, repairDirtyDrift } = await import('./mainguard.mjs');
  const { mkdtempSync: mk66, writeFileSync: wf66, readFileSync: rf66, existsSync: ex66, rmSync: rm66 } = await import('node:fs');
  const root66 = mk66(join(tmpdir(), 'l66repair-'));
  const g66 = (...a) => execFileSync('git', ['-C', root66, ...a], { encoding: 'utf8' });
  g66('init', '-q');
  wf66(join(root66, 'existing.cs'), 'ORIGINAL');
  g66('add', '.');
  g66('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base', '--no-gpg-sign', '--no-verify');
  wf66(join(root66, 'existing.cs'), 'CONTAMINATED BY A ROGUE AGENT');
  wf66(join(root66, 'stray.md'), 'a file HEAD never had');
  const { dirty: dirty66 } = sds66(root66, [{ file: 'existing.cs', was: 'present' }, { file: 'stray.md', was: 'absent' }]);
  eq(dirty66.length, 2, 'KI-E61: both the mutated tracked file and the new stray classify as dirty');
  const repaired66 = repairDirtyDrift(root66, dirty66);
  eq(repaired66.length, 2, 'KI-E61: both dirty entries report as repaired');
  eq(rf66(join(root66, 'existing.cs'), 'utf8'), 'ORIGINAL', 'KI-E61: present->changed file restored to its HEAD content');
  ok(!ex66(join(root66, 'stray.md')), 'KI-E61: absent->present stray file removed (checkout cannot restore what HEAD never had)');
  // a git failure (invalid repo path) must fail closed per-entry, not throw the whole fold
  const badRepair = repairDirtyDrift(join(root66, 'not-a-repo'), [{ file: 'x.cs', was: 'present' }]);
  eq(badRepair.length, 0, 'KI-E61: a git failure repairs nothing (excluded from the repaired list)');
  rm66(root66, { recursive: true, force: true });
  // driver wiring pin: both the fold-time (KI-L65) and relaunch pre-flight (KI-E41) dirty-drift
  // checks call the auto-repair, not just report it — a fix that only touches mainguard.mjs and
  // never gets called would leave the bug live.
  const dsrc66 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  const foldSite = dsrc66.indexOf('MAIN-TREE CONTAMINATION');
  const resumeSite = dsrc66.indexOf('MAIN-GUARD ${id} (KI-E41)');
  ok(foldSite > 0 && dsrc66.slice(Math.max(0, foldSite - 400), foldSite).includes('repairDirtyDrift('), 'driver: KI-E61 fold-time contamination check calls repairDirtyDrift before reporting');
  ok(resumeSite > 0 && dsrc66.slice(Math.max(0, resumeSite - 400), resumeSite).includes('repairDirtyDrift('), 'driver: KI-E61 resume pre-flight main-guard calls repairDirtyDrift before reporting');
}

// KI-E36 (review fix): parkedAtMs + allCommittedAfter — the delivered-in-HEAD date logic, pure.
{
  const { parkedAtMs, allCommittedAfter } = await import('./ledger.mjs');
  const rowP = { state: 'BLOCKED', updatedAt: '2026-07-24T12:00:00Z', history: [{ from: null, to: 'READY', at: '2026-07-01T00:00:00Z' }, { from: 'READY', to: 'BLOCKED', at: '2026-07-10T00:00:00Z' }] };
  eq(parkedAtMs(rowP), Date.parse('2026-07-10T00:00:00Z'), 'KI-E36: park baseline = the history entry that ENTERED the current state, not updatedAt');
  eq(parkedAtMs({ state: 'ESCALATED', updatedAt: '2026-07-24T12:00:00Z' }), Date.parse('2026-07-24T12:00:00Z'), 'KI-E36: no matching history -> updatedAt fallback');
  eq(parkedAtMs({ state: 'BLOCKED' }), null, 'KI-E36: no usable timestamp -> null (hint suppressed)');
  const iso36 = { 'a.cs': '2026-07-11T00:00:00Z', 'b.cs': '2026-07-12T00:00:00Z', 'never.cs': '' };
  const lk36 = (f) => iso36[f];
  ok(allCommittedAfter(['a.cs', 'b.cs'], Date.parse('2026-07-10T00:00:00Z'), lk36) === true, 'KI-E36: every touch-set file newer than the park -> hint fires');
  ok(allCommittedAfter(['a.cs', 'never.cs'], Date.parse('2026-07-10T00:00:00Z'), lk36) === false, 'KI-E36: a never-committed file suppresses the hint');
  ok(allCommittedAfter([], Date.parse('2026-07-10T00:00:00Z'), lk36) === false, 'KI-E36: an empty touch-set never hints');
  ok(allCommittedAfter(['a.cs'], null, lk36) === false, 'KI-E36: an unknown park time never hints');
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
  // KI-E64 (2026-08-02): LEDGER_PATH was '_bmad-output/tech-debt/STANDARDS-LEDGER.md' (missing
  // "DIVERGENCE") since KI-E16's introduction — a filename that has NEVER existed on disk, so the
  // gap check could never be satisfied even when files[] correctly carried the real path, and
  // `graph-audit --fix` would have appended a nonexistent path instead of the real ledger. Pin the
  // correct constant so this exact typo-regression cannot silently return.
  ok(dsrc16.includes("const LEDGER_PATH = '_bmad-output/tech-debt/STANDARDS-DIVERGENCE-LEDGER.md';"), 'KI-E64: graph-audit LEDGER_PATH points at the real ledger filename (with DIVERGENCE), not the historical typo');
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
  const cli = fileURLToPath(new URL('../telemetry-emit.mjs', import.meta.url));
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
  eq(D.extractPathClaims('see doc/runbooks/admin-portal.md and Controllers/Admin/AdminController.cs'), ['doc/runbooks/admin-portal.md', 'Controllers/Admin/AdminController.cs'], 'doclint: extension-bearing file claims are kept');
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
  const posixOf = (p) => String(p).split(sep).join('/');
  const fakeFs = {
    existsSync: (p) => posixOf(p).endsWith('doc/data-flows/Svc.md') || posixOf(p).endsWith('Svc/CONTEXT.md'),
    readFileSync: (p) => posixOf(p).endsWith('CONTEXT.md') ? '## Deps\n' : '## API\nx\n## Events\n',
  };
  const dm = buildDocMap('/repo', 'Svc', fakeFs);
  eq(dm.length, 2, 'promptpack: buildDocMap maps only existing docs');
  ok(dm[0] === 'doc/data-flows/Svc.md :: § API @L1 · § Events @L3', 'promptpack: buildDocMap data-flow entry shape (got ' + dm[0] + ')');
  ok(dm[1] === 'Svc/CONTEXT.md :: § Deps @L1', 'promptpack: buildDocMap CONTEXT entry shape');
  eq(buildDocMap('/repo', '', fakeFs), [], 'promptpack: buildDocMap empty target -> []');
  eq(buildDocMap('/repo', 'Svc', { existsSync: () => { throw new Error('io'); }, readFileSync: () => '' }), [], 'promptpack: buildDocMap io failure is best-effort []');
  // readRoleBriefs: injected io — .md only, role keyed, capped; dir failure -> {}.
  const fakeDir = { readdirSync: () => ['fixer.md', 'notes.txt', 'gate-qa.md'], readFileSync: (p) => 'BRIEF:' + basename(p) };
  const briefs = readRoleBriefs('/agents', fakeDir);
  eq(Object.keys(briefs).sort(), ['fixer', 'gate-qa'], 'promptpack: readRoleBriefs .md-only role keys');
  ok(briefs.fixer === 'BRIEF:fixer.md', 'promptpack: readRoleBriefs content');
  eq(readRoleBriefs('/agents', { readdirSync: () => { throw new Error('io'); } }), {}, 'promptpack: readRoleBriefs dir failure -> {} (compose falls back to pointer)');

  // factory.js invariants: shared prefix order (GUARDRAILS before every role-conditional block),
  // pack seams, inline-brief branch, docMap block, telemetry verdict split.
  const LIBDIR = dirname(fileURLToPath(import.meta.url));
  const fsrc = readFileSync(join(LIBDIR, '..', 'factory.js'), 'utf8');
  const iGuard = fsrc.indexOf("'GUARDRAILS (.claude/rules");
  const iPack = fsrc.indexOf("'REVIEW PACK: Read '");
  const iD7 = fsrc.indexOf('PARALLEL REVIEW STAGE — LIVE-PROBE');
  ok(iGuard > 0 && iPack > iGuard && iD7 > iPack, 'factory: cache-strategic order — GUARDRAILS < REVIEW PACK < KI-D7 (role tail after shared prefix)');
  ok(fsrc.includes('A.briefs && A.briefs[role]'), 'factory: inline-brief branch present (batch briefs win, pointer fallback)');
  ok(fsrc.includes('DOC MAP (section index'), 'factory: docMap block present in shared prefix');
  // KI-E61 (2026-08-02): every docMap path must be REPO-anchored at the point of use, and any path
  // that is ALSO in the item's files[] touch-set must carry an explicit worktree-edit-target line —
  // this is the actual fix for the main-tree-contamination class (cycle 35/48/56 all hit a doc/
  // data-flows, CONTEXT.md, or AGENTS.md file, exactly what buildDocMap indexes).
  ok(fsrc.includes("lines.push('  ' + REPO + '/' + d)"), 'factory: KI-E61 docMap entries are REPO-anchored, not bare-relative');
  ok(fsrc.includes('THIS path is ALSO in your files[] touch-set') && fsrc.includes("Your edit target for"), 'factory: KI-E61 docMap warns when a reference doc is also an edit target, naming the worktree path');
  const opsrc66 = readFileSync(join(LIBDIR, '..', 'opencode', 'compose.mjs'), 'utf8');
  ok(opsrc66.includes('THIS path is ALSO in your files[] touch-set'), 'opencode compose: KI-E61 docMap edit-anchor warning ported (runtime parity)');
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

// KI-E60: readRepoProfiles — a purely-ADDITIVE per-repo style overlay (agents/repo-profiles/<target>.md)
// layered on top of (never instead of) the universal agents/*.md briefs every target already gets
// (KI-E56: a universal brief cannot correctly describe every real repo's own conventions, e.g.
// NUnit vs xUnit+FluentAssertions). Same read-only-best-effort shape as readRoleBriefs: injected
// io — .md only, target keyed, capped; dir failure (the common "no profile yet" case) -> {}, never
// a throw — a target with no profile file behaves EXACTLY as it did before this mechanism existed.
{
  const fakeProfileDir = { readdirSync: () => ['Contoso.Web.md', 'notes.txt', 'Fabrikam.Api.md', 'README.md', '_example.Contoso.Widgets.md'], readFileSync: (p) => 'PROFILE:' + basename(p) };
  const profiles = readRepoProfiles('/agents/repo-profiles', fakeProfileDir);
  eq(Object.keys(profiles).sort(), ['Contoso.Web', 'Fabrikam.Api'], 'promptpack: readRepoProfiles .md-only target keys (README + _example.* excluded — docs/template, never real target keys)');
  ok(profiles['Contoso.Web'] === 'PROFILE:Contoso.Web.md', 'promptpack: readRepoProfiles content');
  eq(readRepoProfiles('/agents/repo-profiles', { readdirSync: () => { throw new Error('io'); } }), {}, 'promptpack: readRepoProfiles missing-dir/io-failure -> {} (compose omits the overlay; the universal brief alone stays authoritative)');
  // PR#9 review — profiles cap at PROFILE_CAP (30k), NOT the 12k BRIEF_CAP: real profiles run
  // 8-26KB and the BRIEF_CAP slice silently dropped 30-53% of 3 of the first 4 live profiles.
  ok(PROFILE_CAP > 12000, 'PR#9: PROFILE_CAP exceeds BRIEF_CAP (profiles are bigger than role briefs)');
  const big = { readdirSync: () => ['Big.md'], readFileSync: () => 'y'.repeat(PROFILE_CAP + 5000) };
  eq(readRepoProfiles('/p', big)['Big.md'.replace(/\.md$/, '')].length, PROFILE_CAP, 'PR#9: an oversize profile truncates at PROFILE_CAP (both runtimes share this bound)');
  const mid = { readdirSync: () => ['Mid.md'], readFileSync: () => 'y'.repeat(20000) };
  eq(readRepoProfiles('/p', mid)['Mid'].length, 20000, 'PR#9: a 20k profile (over the old 12k BRIEF_CAP) now survives whole');

  // static grep-based wiring checks (mirroring the fsrc.includes(...) pattern used above/elsewhere in
  // this file for other mechanisms): both runtimes actually read + inject the overlay, and driver.mjs
  // actually feeds it into the batch (KI-E2 split — the Workflow runtime has no fs of its own).
  const fsrc60 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(fsrc60.includes('A.repoProfiles'), 'KI-E60: factory.js reads A.repoProfiles (the driver-inlined per-target overlay)');
  ok(fsrc60.includes('REPO-SPECIFIC STYLE PROFILE'), 'KI-E60: factory.js injects the REPO-SPECIFIC STYLE PROFILE label into the prompt');
  const csrc60 = readFileSync(join(import.meta.dirname, '..', 'opencode', 'compose.mjs'), 'utf8');
  ok(csrc60.includes("'repo-profiles'"), 'KI-E60: opencode/compose.mjs resolves the agents/repo-profiles/<target>.md path');
  ok(csrc60.includes('REPO-SPECIFIC STYLE PROFILE'), 'KI-E60: opencode/compose.mjs injects the SAME REPO-SPECIFIC STYLE PROFILE label');
  const dsrc60 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc60.includes('readRepoProfiles') && dsrc60.includes("'repo-profiles'"), 'KI-E60: driver.mjs imports + calls readRepoProfiles against the repo-profiles subdir');
}

// KI-E74B — the runner's VERIFY_SCHEMA `note` field (an honest caveat, e.g. "green here does NOT
// mean a prior review round's findings are resolved") was captured into a local `verify` variable
// and then never read again by any later stage — silently dropped, with no channel reaching the
// gate/review band, which only ever saw review-pack.md (a pure git-diff snapshot, zero narrative).
// ITEM-H1 live, 2026-08-07: 8 gates approved a worktree the runner's own verify.json ALREADY said
// did not address known issues; only an unrelated deterministic transcript check (KI-E70) happened
// to catch it. Fixed by threading verify.note onto item.verifyNote (survives into every later
// review-role compose() call for the item) and rendering it prominently when present.
{
  const fsrc74 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(/if \(verify\.note && String\(verify\.note\)\.trim\(\)\) item\.verifyNote = String\(verify\.note\)\.trim\(\)/.test(fsrc74), 'KI-E74B: factory.js threads the runner\'s verify.note onto item.verifyNote right after the runner call, before any early FAILED return');
  ok(/if \(item\.verifyNote\) lines\.push\('', 'VERIFY-STAGE NOTE/.test(fsrc74), 'KI-E74B: factory.js renders item.verifyNote prominently in the review-role prompt tail');
  // The render call site must be INSIDE the isReviewRole branch (only gates/reviews see it, not the
  // fixer/planner/runner itself) — assert it sits after the isReviewRole guard opens.
  const reviewBranchIdx = fsrc74.indexOf('const isReviewRole = ');
  const verifyNoteRenderIdx = fsrc74.indexOf('VERIFY-STAGE NOTE (from the runner');
  ok(reviewBranchIdx >= 0 && verifyNoteRenderIdx > reviewBranchIdx, 'KI-E74B: the verifyNote render lives inside the review-role branch, not the shared prefix every role sees');
  const csrc74 = readFileSync(join(import.meta.dirname, '..', 'opencode', 'compose.mjs'), 'utf8');
  ok(/if \(item\.verifyNote\) lines\.push\('', 'VERIFY-STAGE NOTE/.test(csrc74), 'KI-E74B: opencode/compose.mjs mirrors the SAME render (disclosed gap: the setting half is not yet wired into runtime.mjs\'s different step-dispatch model)');
}

// KI-E60: exec-smoke — a populated A.repoProfiles for the smoke batch's own target ("X") must not
// disturb any existing lane's behaviour. execSmoke's stub harness only records {label, model} per
// call, never the prompt string, so this cannot assert the injected TEXT itself (the static grep
// checks above already cover that); it proves presence is a harmless no-op to the surrounding
// orchestration — no agentOverride/blockedGate needed, so every lane must still complete exactly as
// the unmodified KI-L43 baseline block above does (regression-safety: that baseline block is
// untouched by this change and must still pass on its own).
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  const batchWithProfile = { ...smokeBatch(), repoProfiles: { X: 'REPO-PROFILE (smoke): NUnit, Assert.That, no comments.' } };
  const { result, calls } = await execSmoke(src, batchWithProfile);
  ok(!(result.results || []).some((r) => String(r.note || '').startsWith('runItem threw')), 'KI-E60: NO runItem crash with A.repoProfiles populated (KI-L36-class regression check)');
  const by60 = Object.fromEntries((result.results || []).map((r) => [r.id, r]));
  eq(by60['SMOKE-DOC'] && by60['SMOKE-DOC'].toState, 'CLOSED', 'KI-E60: doc/editorial lane still completes with a populated A.repoProfiles for its own target');
  eq(by60['SMOKE-CODE'] && by60['SMOKE-CODE'].toState, 'CLOSED', 'KI-E60: FULL code lane still completes to CLOSED with a populated A.repoProfiles for its own target');
  eq(calls.filter((c) => c.label.endsWith(':checkpoint')).length, 6, 'KI-E60: every item result still checkpointed (six items, same as the unmodified KI-L43 baseline)');
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
  ok(readFileSync(new URL('../../agents/test-author.md', import.meta.url), 'utf8').includes('REAL-SHAPE SEEDING (KI-E38'), 'KI-E38: test-author brief carries the real-shape seeding rule');
  ok(readFileSync(new URL('../../agents/review-testreview.md', import.meta.url), 'utf8').includes('Seed-shape completeness (KI-E38'), 'KI-E38: test-review brief carries the seed-shape completeness lens');
  const ta38 = readFileSync(new URL('../../agents/test-author.md', import.meta.url), 'utf8');
  ok(ta38.indexOf('REAL-SHAPE SEEDING (KI-E38') < ta38.indexOf('### REAL-INFRA TESTS'), 'KI-E38 (review fix): the seeding rule is UNCONDITIONAL — it lives before/outside the REAL-INFRA-only section');
  const compose39 = readFileSync(new URL('../../telemetry/compose-profile.example.yaml', import.meta.url), 'utf8');
  ok(!/^\s*container_name\s*:/m.test(compose39), 'KI-E39: the host-compose profile carries NO container_name key (the KI-E25 collision class stays dead)');
  ok(compose39.includes('- exporter') && compose39.includes('- otel-collector') && compose39.includes('- prometheus'), 'KI-E39: the three aliases the stock configs resolve are declared');
  ok((compose39.match(/profiles:/g) || []).length === 4, 'KI-E39: all four services are gated behind the factory profile');
}

// KI-E40 (2026-07-24): gate-verdict vocabulary classifier + usage rendering. The report counted
// only the literal APPROVED, so 100%-passing reaudit (code=ok…), adjudicator (UPHELD), regate
// (CONFIRMED) and direct-recovery (converged-remedy…) rows rendered 0% — a poisoned quality
// signal; and KI-E23 usage events were collected but never rendered anywhere.
{
  const T = await import('./telemetry.mjs');
  ok(T.verdictOk('APPROVED') && T.verdictOk('UPHELD') && T.verdictOk('CONFIRMED'), 'KI-E40: literal ok verdicts classify ok');
  ok(T.verdictOk('code=ok') && T.verdictOk('code=ok edge-case=ok security=ok'), 'KI-E40: reaudit key=ok families classify ok');
  ok(T.verdictOk('converged-remedy (gate:developer + review:adversarial aligned)'), 'KI-E40: direct-recovery converged-remedy prose classifies ok');
  ok(!T.verdictOk('CHANGES_REQUIRED') && !T.verdictOk('') && !T.verdictOk('code=ok security=fail') && !T.verdictOk('MYSTERY'), 'KI-E40: fail/unknown/mixed-key vocab classifies not-ok');
  ok(!T.verdictOk('OVERRULED') && T.KNOWN_FAIL_VERDICT.test('OVERRULED'), 'KI-E40: adjudicator OVERRULED is known-fail (Ok-rate reads as dissent-upheld calibration), never unclassified');
  const agg40 = T.aggregateEvents([
    { event: 'item_folded', source: 'driver', item: 'A', cycle: 48, attrs: { toState: 'CLOSED', gates: { reaudit: 'code=ok security=ok', adjudicator: 'UPHELD', 'gate:qa': 'CHANGES_REQUIRED', 'gate:x': 'MYSTERY', 'gate:y': 'OVERRULED', 'gate:z': 'code=ok security=no', 'gate:w': 'code=NULL' } } },
    { event: 'usage', source: 'driver', cycle: 48, attrs: { outputTokens: 12345, file: 'results-cycle-48.json' } },
  ]);
  eq(agg40.usage, [{ cycle: 48, file: 'results-cycle-48.json', outputTokens: 12345 }], 'KI-E40: usage events aggregate');
  const md40 = T.renderTelemetryReport(agg40, { generatedAt: 'T', file: 'f' });
  ok(md40.includes('| reaudit | 1 | 1 | 100% |') && md40.includes('| adjudicator | 1 | 1 | 100% |'), 'KI-E40: role ok-vocabularies count as Ok in the gate table');
  ok(md40.includes('| gate:qa | 1 | 0 | 0% |'), 'KI-E40: CHANGES_REQUIRED still counts not-ok');
  ok(md40.includes('Unclassified verdict vocabulary') && md40.includes('`MYSTERY`×1'), 'KI-E40: unknown vocabulary self-reports in the footnote');
  ok(!md40.includes('`CHANGES_REQUIRED`×') && !md40.includes('`OVERRULED`×'), 'KI-E40: known-fail vocabulary is NOT flagged as unclassified');
  ok(md40.includes('| gate:z | 1 | 0 | 0% |') && md40.includes('| gate:w | 1 | 0 | 0% |'), 'KI-E40: mixed/NULL reaudit families count not-ok in the gate table');
  ok(!md40.includes('`code=ok security=no`×') && !md40.includes('`code=NULL`×'), 'KI-E40: known-fail reaudit FAMILIES never pollute the drift footnote (review find)');
  ok(md40.includes('## Fold-time token usage') && md40.includes('12,345'), 'KI-E40: usage section renders token spend');
  ok(md40.includes('late-failure spend'), 'KI-E40: failure-concentration reading note present');
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
  ok(bts.includes('leftovers|comments)') && bts.includes('leftover-lint.mjs'), 'KI-D12: build-test.sh leftovers subcommand wired to the CLI (engine-owned dispatch BEFORE the local-override seam — PR#9)');
  ok(bts.indexOf('leftovers|comments)') < bts.indexOf('build-test.local.sh"') , 'PR#9: the diff-lint dispatch precedes the build-test.local.sh override exec (a stale host override can never swallow the lints)');
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

// KI-E59: CommentScan — the deterministic detector + the factory-side probe wiring. Runs BEFORE
// leftover-scan; unlike leftover-scan there is NO classify step — every hit is a hard violation
// (owner directive 2026-07-30: no comment may ever be added or reworded, zero exceptions).
{
  // detector: any new comment syntax HITS; a bare URL (no real comment marker) does NOT.
  ok(csClassify('X/src/Foo.cs', '  var x = 1; // trailing comment'), 'KI-E59: a trailing // comment is a hit');
  ok(csClassify('X/src/Foo.cs', '  // standalone comment'), 'KI-E59: a standalone // comment is a hit');
  ok(csClassify('X/src/Foo.cs', '  /* block comment */'), 'KI-E59: a /* */ block comment is a hit');
  ok(csClassify('X/src/Foo.html', '  <!-- html comment -->'), 'KI-E59: an <!-- --> HTML comment is a hit');
  ok(!csClassify('X/src/Foo.cs', '  var url = "https://example.com";'), 'KI-E59: a bare URL with no comment marker is NOT a hit');
  ok(!csClassify('X/src/Foo.cs', '  var a = "https://x.com"; var b = "https://y.com";'), 'KI-E59: multiple URLs with no real comment marker is NOT a hit');
  ok(csClassify('X/src/Foo.cs', '  var url = "https://example.com"; // real comment'), 'KI-E59: a URL EARLIER in the line does not mask a REAL comment LATER on the same line');
  ok(!csClassify('X/src/Foo.cs', '  '), 'KI-E59: a blank line is not a hit');
  // PR#9 review — measured false-positive classes killed by string-stripping + extension awareness:
  ok(!csClassify('X/src/Foo.cs', '  var sep = "//";'), 'PR#9: a "//" string literal is NOT a hit');
  ok(!csClassify('X/src/Foo.cs', '  var url = "//cdn.example.com/lib.js";'), 'PR#9: a protocol-relative URL in a string is NOT a hit');
  ok(!csClassify('X/src/Foo.cs', '  var b64 = "qL7//9k=";'), 'PR#9: base64 in a string is NOT a hit');
  ok(!csClassify('X/proj.csproj', '  <Compile Include="**/*.cs" />'), 'PR#9: a csproj glob Include is NOT a hit (quoted attribute value stripped)');
  ok(!csClassify('X/app.js', 'while (x --> 0) n++;'), 'PR#9: the --> idiom in a non-markup file is NOT a hit');
  ok(!csClassify('X/app.js', 'const re = /\\/\\//;'), 'PR#9: a JS regex literal containing // is NOT a hit');
  ok(!csClassify('docs/note.md', '<!-- toc -->'), 'PR#9: .md files are never scanned (KI-E58 sends residual-gap notes to docs)');
  ok(!csClassify('data.json', '"path": "a//b",'), 'PR#9: .json files are never scanned (JSON has no comments)');
  ok(csClassify('X/q.sql', '-- add index on users').kind === 'dash', 'PR#9: a SQL -- comment IS a hit');
  ok(csClassify('X/deploy.yml', 'port: 8080 # inline comment').kind === 'hash', 'PR#9: a YAML # comment IS a hit');
  ok(!csClassify('X/cfg.yml', 'other: p#ss'), 'PR#9: a # with no preceding whitespace in YAML is NOT a comment');
  ok(csClassify('X/Page.razor', '@* razor comment *@').kind === 'razor', 'PR#9: a Razor @* *@ comment IS a hit');
  ok(csClassify('X/run.ps1', '<# block #>').kind === 'block', 'PR#9: a PowerShell <# #> block comment IS a hit');
  ok(!csClassify('X/run.sh', '#!/usr/bin/env bash'), 'PR#9: a shebang is NOT a hit');
  // Move-suppression + Windows-safe untracked reads (findComments level) — real git fixture:
  {
    const mvd = mkdtempSync(join(tmpdir(), 'csmove-'));
    const g = (...a) => execFileSync('git', ['-C', mvd, ...a], { encoding: 'utf8' });
    g('init', '-q', '.'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fsWrite(join(mvd, 'Move.cs'), 'namespace Old.Ns\n{\n    // pre-existing invariant comment\n    class A { }\n}\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    fsWrite(join(mvd, 'Move.cs'), 'namespace New.Ns;\n\n// pre-existing invariant comment\nclass A { }\n// BRAND NEW comment\n');
    fsWrite(join(mvd, 'NewTests.cs'), 'public class T {\n    // untracked comment in new test file\n}\n');
    const mhits = findComments(mvd, 50);
    eq(mhits.map((h) => h.line).sort(), ['// BRAND NEW comment', '// untracked comment in new test file'],
      'PR#9: a byte-identical MOVED/re-indented comment is suppressed (file-scoped-ns conversion no longer hard-fails); genuinely new + untracked-file comments still hit');
    eq(mhits.skipped, 0, 'PR#9: untracked files read via readFileSync (no cat dependency), zero skipped');
  }
  // factory wiring contract (grep-visible; exec-smoke below RUNS the FAIL path)
  const fsrc = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(fsrc.includes('const COMMENT_SCHEMA') && fsrc.includes("call('comment-probe'"), 'KI-E59: factory declares COMMENT_SCHEMA + runs the haiku comment-probe');
  ok(fsrc.includes("' comments ' + wtPath"), 'KI-E59: the probe invokes build-test.sh comments on the worktree');
  ok(fsrc.includes('typeof cs.count'), 'KI-E59: only an EXPLICIT numeric count acts (a malformed/unavailable probe never sinks an item)');
  ok(fsrc.includes('cs.count >= 0'), 'PR#9: the count:-1 scan-unavailable report records NO gate verdict (fold backstop covers)');
  ok(fsrc.includes('A.policies.noNewComments'), 'PR#9: the comment probe runs ONLY when the host enables policies.noNewComments');
  ok(fsrc.indexOf("call('comment-probe'") < fsrc.indexOf("call('leftover-probe'"), 'KI-E59: the comment-probe call runs BEFORE the leftover-probe call');
}

// KI-E59: build-test.sh comments subcommand -> CLI; CLI emits the marker from the SAME lib the probe reads.
{
  const bts = readFileSync(new URL('../../verify/build-test.sh', import.meta.url), 'utf8');
  ok(bts.includes('comments)') && bts.includes('comment-lint.mjs'), 'KI-E59: build-test.sh comments subcommand wired to the CLI');
  const ccli = readFileSync(new URL('../comment-lint.mjs', import.meta.url), 'utf8');
  ok(ccli.includes('FACTORY::COMMENT::') && ccli.includes('findComments'), 'KI-E59: comment CLI emits the machine marker from the SAME comment-scan lib the probe + fold read');
}

// KI-E59: exec-smoke — a comment-probe hit FAILS the code lane PRE-BAND (before leftover-scan even
// runs), and a clean verdict (count=0) lets it proceed to CLOSED with the gate recorded.
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  const hit = await execSmoke(src, smokeBatch(), {
    agentOverride: (prompt, opts) => ((opts && opts.label) === 'SMOKE-CODE:comment-probe')
      ? { count: 1, hits: ['X/src/Some.cs [line]: // new comment'] } : undefined,
  });
  const hitBy = Object.fromEntries((hit.result.results || []).map((r) => [r.id, r]));
  eq(hitBy['SMOKE-CODE'] && hitBy['SMOKE-CODE'].toState, 'FAILED', 'KI-E59: a non-zero comment-scan count FAILS the code lane');
  ok(String(hitBy['SMOKE-CODE'] && hitBy['SMOKE-CODE'].note || '').includes('comment-scan'), 'KI-E59: the FAIL note cites comment-scan');
  ok(!hit.calls.some((c) => c.label === 'SMOKE-CODE:leftover-probe'), 'KI-E59: a comment-scan FAIL short-circuits BEFORE the leftover-probe call ever runs');
  ok(!hit.calls.some((c) => c.label === 'SMOKE-CODE:gate-architect'), 'KI-E59: the comment-scan FAIL is PRE-BAND (no opus gate spent)');
  const cleanRun = await execSmoke(src, smokeBatch(), {
    agentOverride: (prompt, opts) => ((opts && opts.label) === 'SMOKE-CODE:comment-probe') ? { count: 0, hits: [] } : undefined,
  });
  const cleanBy = Object.fromEntries((cleanRun.result.results || []).map((r) => [r.id, r]));
  eq(cleanBy['SMOKE-CODE'] && cleanBy['SMOKE-CODE'].toState, 'CLOSED', 'KI-E59: a clean comment-scan verdict lets the code lane proceed to CLOSED');
  eq(cleanBy['SMOKE-CODE'] && cleanBy['SMOKE-CODE'].gates && cleanBy['SMOKE-CODE'].gates['probe:comment-scan'], 'APPROVED', 'KI-E59: a clean verdict records probe:comment-scan APPROVED in the gates map');
  // PR#9 review — the gate is HOST-POLICY-GATED: with policies absent (the shipped-engine default)
  // the probe never runs at all, even when it WOULD have reported a hit.
  const offBatch = { ...smokeBatch() };
  delete offBatch.policies;
  const offRun = await execSmoke(src, offBatch, {
    agentOverride: (prompt, opts) => (String((opts && opts.label) || '').endsWith(':comment-probe'))
      ? { count: 9, hits: ['would-have-failed'] } : undefined,
  });
  ok(!offRun.calls.some((c) => c.label.endsWith(':comment-probe')), 'PR#9: with policies.noNewComments OFF (default) the comment probe is never called');
  const offBy = Object.fromEntries((offRun.result.results || []).map((r) => [r.id, r]));
  eq(offBy['SMOKE-CODE'] && offBy['SMOKE-CODE'].toState, 'CLOSED', 'PR#9: policy-OFF code lane closes with no comment gate involved');
  // PR#9 review — count:-1 (scan unavailable) is fail-open: no gate recorded, item proceeds.
  const unavailRun = await execSmoke(src, smokeBatch(), {
    agentOverride: (prompt, opts) => ((opts && opts.label) === 'SMOKE-CODE:comment-probe') ? { count: -1, hits: [] } : undefined,
  });
  const unavailBy = Object.fromEntries((unavailRun.result.results || []).map((r) => [r.id, r]));
  eq(unavailBy['SMOKE-CODE'] && unavailBy['SMOKE-CODE'].toState, 'CLOSED', 'PR#9: a count:-1 scan-unavailable probe never sinks the item');
  ok(!(unavailBy['SMOKE-CODE'].gates || {})['probe:comment-scan'], 'PR#9: scan-unavailable records NO probe:comment-scan gate (an APPROVED requires a real count 0)');
}

// KI-E59: the opencode port (runtime.mjs) mirrors the SAME gate fully deterministically (no LLM at
// all — a DIRECT findComments import since the PR#9 review: no bash dependency, Windows-safe, and
// immune to the build-test.local.sh override seam), policy-gated, checked first in the mech
// 'leftover' step, FAILing immediately on any hit before the leftover scan runs. A throwing scan
// records NO gate key (never a false APPROVED — AP#19); its behavioral pins live in the opencode
// suite (spawned green below).
{
  const rsrc = readFileSync(join(import.meta.dirname, '..', 'opencode', 'runtime.mjs'), 'utf8');
  ok(rsrc.includes("from '../lib/comment-scan.mjs'") && rsrc.includes('runCommentGate('), 'KI-E59: runtime.mjs imports findComments directly (no bash seam) via runCommentGate');
  ok(rsrc.includes('loadPolicies(FACTORY_ROOT)'), 'PR#9: runtime.mjs gates the comment check on the host policy (same loader as the driver)');
  ok(rsrc.includes('FACTORY::COMMENT::') && rsrc.includes('FACTORY::COMMENT-HIT::'), 'KI-E59: runtime.mjs writes the comment-scan markers (comment-raw.txt in the CLI format)');
  ok(rsrc.includes('comment-scan (KI-E59)'), 'KI-E59: runtime.mjs FAILs with a comment-scan-cited note');
  ok(rsrc.indexOf('runCommentGate(') < rsrc.indexOf("runBuildTest(progress.ctx.factoryRoot, 'leftovers'"), 'KI-E59: runtime.mjs checks comments BEFORE leftovers in the mech step');
}

// KI-E59: driver.mjs fold-time WARN-only backstop (mirrors the KI-D12/F2 posture — a detection aid,
// never a fold-blocker) re-greps each folding result's worktree independent of any LLM verdict.
{
  const dsrc = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc.includes("import { findComments } from './lib/comment-scan.mjs'"), 'KI-E59: driver.mjs imports findComments for the fold backstop');
  ok(dsrc.includes('COMMENT') && dsrc.includes('findComments(r.worktree'), 'KI-E59: driver.mjs fold re-greps each folding result worktree for comments');
  ok(dsrc.includes('.noNewComments) for (const r of arr)'), 'PR#9: the fold COMMENT backstop is host-policy-gated (never warns on hosts where comments are allowed)');
}

// KI-E53 (PR#9 review) — the escalations note walk, behaviorally: r.note is a dead field nothing
// assigns; only per-transition history[].note entries carry the real reason. Previously pinned by
// a source-regex only — a defect inside the walk itself would have passed.
{
  const L = await import('./ledger.mjs');
  eq(L.lastHistoryNote({ history: [{ from: 'GATED', to: 'ESCALATED', note: 'auto-drafted; awaiting sign-off' }, { from: 'X', to: 'Y', note: null }] }),
    'auto-drafted; awaiting sign-off', 'KI-E53: lastHistoryNote returns the LAST note-bearing history entry, skipping note-less hops');
  eq(L.lastHistoryNote({ note: 'dead static field', history: [] }), '(no note)', 'KI-E53: the dead row.note field is never consulted');
  eq(L.lastHistoryNote({}), '(no note)', 'KI-E53: a history-less row renders (no note), never throws');
  const dsrcE53 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrcE53.includes('const lastNote = lastHistoryNote'), 'KI-E53: cmdEscalationsSync routes through the lib helper (both the per-item line and the retry-exhausted section)');
  const escBody = dsrcE53.slice(dsrcE53.indexOf('function cmdEscalationsSync'), dsrcE53.indexOf('\nfunction ', dsrcE53.indexOf('function cmdEscalationsSync') + 1));
  ok(escBody.length > 100 && !/\br\.note \|\|/.test(escBody), 'KI-E53: the escalations renderer never falls back to the dead ledger-row r.note field (fold RESULT objects elsewhere legitimately carry .note)');
}

// PR#9 review (LOW) — opencode resolveTarget: UNC paths are absolute (never joined onto the
// worktree) and the outside-worktree compare case-folds ONLY on win32.
{
  const rsrcRT = readFileSync(join(import.meta.dirname, '..', 'opencode', 'runtime.mjs'), 'utf8');
  ok(rsrcRT.includes("t.startsWith('\\\\\\\\')"), 'PR#9: resolveTarget treats UNC \\\\server\\share targets as absolute');
  ok(rsrcRT.includes("process.platform === 'win32' ? s.toLowerCase() : s"), 'PR#9: resolveTarget case-folds the worktree-prefix compare only on win32');
}

// PR#9 review — the host-policy seam itself: lib/policy.mjs loader + the driver/factory wiring.
{
  const pd = mkdtempSync(join(tmpdir(), 'pol-'));
  eq(loadPolicies(pd), { noNewComments: false, noSchemaChanges: false, archaeology: false }, 'policy: no config at all -> all OFF (shipped-engine default)');
  mkdirSync(join(pd, 'config'), { recursive: true });
  fsWrite(join(pd, 'config', 'factory.config.json'), JSON.stringify({ policies: { noNewComments: false, noSchemaChanges: false } }));
  fsWrite(join(pd, 'config', 'factory.config.local.json'), JSON.stringify({ policies: { noNewComments: true } }));
  eq(loadPolicies(pd), { noNewComments: true, noSchemaChanges: false, archaeology: false }, 'policy: gitignored local overlay flips a policy per host (KI-E17 seam)');
  fsWrite(join(pd, 'config', 'factory.config.local.json'), '{ broken json');
  eq(loadPolicies(pd), { noNewComments: false, noSchemaChanges: false, archaeology: false }, 'policy: an unreadable overlay never throws — falls back to the committed config');
  eq(renderPolicies({ noNewComments: true }), 'noNewComments=on noSchemaChanges=off archaeology=off', 'policy: renderPolicies one-liner for the driver status prints');
  // Committed config ships ALL policies OFF — a public engine must not default to one owner's rules.
  const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'config', 'factory.config.json'), 'utf8'));
  eq(!!(shipped.policies && shipped.policies.noNewComments), false, 'policy: shipped config has noNewComments OFF');
  eq(!!(shipped.policies && shipped.policies.noSchemaChanges), false, 'policy: shipped config has noSchemaChanges OFF');
  eq(!!(shipped.policies && shipped.policies.archaeology), false, 'policy: shipped config has archaeology OFF (KI-E75)');
  // factory.js cannot import policy.mjs (sandboxed) — its inlined HOST POLICY strings must stay
  // byte-identical to POLICY_TEXT, in BOTH compose() and sweepCompose() (2 sites each).
  const fsrcP = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  eq((fsrcP.split(POLICY_TEXT.noNewComments).length - 1), 2, 'policy: factory.js inlines POLICY_TEXT.noNewComments byte-identically in compose + sweepCompose');
  eq((fsrcP.split(POLICY_TEXT.noSchemaChanges).length - 1), 2, 'policy: factory.js inlines POLICY_TEXT.noSchemaChanges byte-identically in compose + sweepCompose');
  ok(fsrcP.includes('A.policies && A.policies.noSchemaChanges'), 'policy: factory.js injects the schema-change block only when the host enabled it');
  // Driver: every runArgs-emitting lane (select, group, sweep) carries policies + profiles/briefs.
  const dsrcP = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok((dsrcP.match(/policies: loadPolicies\(FACTORY_ROOT\)/g) || []).length >= 3, 'policy: select + group + sweep runArgs all carry policies');
  ok((dsrcP.match(/repoProfiles: readRepoProfiles\(/g) || []).length >= 3, 'PR#9: select + group + sweep runArgs all carry repoProfiles (the sweep/select KI-E60 gap)');
  ok((dsrcP.match(/briefs: readRoleBriefs\(/g) || []).length >= 3, 'PR#9: select + group + sweep runArgs all carry inlined briefs');
  ok(dsrcP.includes('renderPolicies(runArgs.policies)'), 'policy: the driver prints the effective policy state at launch (an unset overlay is visible, never silent)');
  ok(dsrcP.includes('POLICY_TEXT.noNewComments') && dsrcP.includes('POLICY_TEXT.noSchemaChanges'), 'policy: recover prompts inject the canonical POLICY_TEXT blocks');
  // sweepCompose parity: brief inlining + profile overlay now reach sweep agents too.
  ok(fsrcP.includes('swBrief') && fsrcP.includes('swProfile'), 'PR#9: sweepCompose inlines the role brief + injects the repo profile (sweep prompt parity)');
  // KI-O2 stays pinned: FIX_SCHEMA accepts the object divergence shape the fixer brief asks for.
  ok(fsrcP.includes("divergence: { type: ['string', 'null', 'object'] }"), 'KI-O2: FIX_SCHEMA divergence accepts string|null|object');
}

// PR#9 review — the opencode suite is now gated by THIS selftest (previously it was invoked by
// nothing automated: no CI selftest, and setup/release.sh + install.sh gate only on this file, so
// wiring it here makes every release/install/upgrade gate cover the port too).
{
  let oout = '';
  try {
    oout = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'opencode', '_selftest.mjs')],
      { encoding: 'utf8', cwd: join(import.meta.dirname, '..', '..'), maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    oout = String((e && e.stdout) || '') + '\nSPAWN-FAILED: ' + String((e && e.message) || e);
  }
  ok(/TOTAL: \d+ passed, 0 failed/.test(oout), 'PR#9: the opencode suite runs green under the main selftest (' + ((/TOTAL: [^\n]+/.exec(oout) || ['no TOTAL line'])[0]) + ')');
}

// KI-E17: portable mounts — host-repo-root walk-up + stock-prefix config rewrite.
{
  const { findRepoRoot, resolveRepoRoot, swapMountPrefix, STOCK_MOUNT } = await import('./rootfind.mjs');
  // walk-up starts at the mount's PARENT: the factory's own .git (submodule gitfile at the
  // mount root) must never win; the first ancestor holding .git does.
  // findRepoRoot/resolveRepoRoot normalize every path through node:path's resolve() internally,
  // which prepends the current drive on win32 (`/host` -> `C:\host`) — mirror that here so the
  // fake fs keys and expected roots match on every platform (KI-E17 is pure path math, no real fs).
  const R = (p) => resolvePath(p);
  const fakeFs = (present) => ({ existsSync: (p) => present.includes(p) });
  eq(findRepoRoot('/host/_bmad-output/ai-factory', fakeFs([R('/host/.git'), R('/host/_bmad-output/ai-factory/.git')])), R('/host'),
    'KI-E17: walk-up finds the HOST .git, never the factory submodule gitfile');
  eq(findRepoRoot('/host/tools/factory', fakeFs([R('/host/.git')])), R('/host'), 'KI-E17: any mount depth resolves to the enclosing repo');
  eq(findRepoRoot('/nowhere/factory', fakeFs([])), null, 'KI-E17: no enclosing repo -> null (standalone checkout)');
  eq(resolveRepoRoot('/x/factory', { FACTORY_REPO_ROOT: '/override' }, fakeFs([])), R('/override'), 'KI-E17: FACTORY_REPO_ROOT env wins');
  eq(resolveRepoRoot('/a/b/factory', {}, fakeFs([])), R('/a'), 'KI-E17: git-less fallback stays the legacy ../..');
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
  eq(recoveryTransitions('BLOCKED')[0], 'CLAIMED', 'KI-E34: BLOCKED recovery (post-reset, from READY) walks the full chain from CLAIMED');
  eq(recoveryTransitions('BLOCKED').length, 10, 'KI-E34: the BLOCKED recovery chain is the full 10-hop re-entry');
  eq(priorCycleOf({ resultId: 'X-1#46' }, 9), 46, 'KI-E20: recovery cycle parsed from the prior checkpoint');
  eq(priorCycleOf(null, 9), 9, 'KI-E20: no checkpoint -> fallback cycle');
  const sk = recoveryFoldSkeleton('X-1', { state: 'FAILED', worktree: 'wt', branch: 'b' }, { codeChange: true, needsRealInfra: false, rootCauseFiles: ['a.cs'], integrateRaw: true, resultId: 'X-1#46' }, 46);
  eq(sk.resultId, 'X-1#46r', 'KI-E20: skeleton resultId is #<cycle>r');
  eq(sk.attemptsDelta, 0, 'KI-E20: a recovery consumes no retry budget');
  ok(sk.codeChange === true && sk.integrateRaw === true && sk.transitions.length === 10, 'KI-E20: machine-evidence flags carry over; the FAILED chain has 10 hops');
  ok(String(recoveryFoldSkeleton('X-0', { state: 'BLOCKED' }, null, 3).codeChange).startsWith('<FILL'), 'KI-E34 (review fix): a prior-less skeleton FILL-prompts codeChange — never silently the no-evidence doc/config path');
  eq(recoveryFoldSkeleton('X-2', { state: 'FAILED' }, { band: 'FULL', codeChange: true, resultId: 'X-2#7' }, 7).band, 'FULL', 'KI-E20 (review fix): band carries onto the recovery skeleton — the KI-E19 pair rule arms on recovery folds');
  const dsrc20 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc20.includes("case 'recover'") && dsrc20.includes('recovery_prepared') && dsrc20.includes('mutation-proof.txt'), 'KI-E20: driver wires recover + telemetry + the evidence contract');
  ok(dsrc20.includes("case 'decisions-digest'") && dsrc20.includes('Rule-together bundles'), 'KI-E24: driver wires the ranked owner-decision digest');
  // KI-E74: decisions-digest reuses the SAME clustering cluster.mjs already trusts for the SWEEP
  // report (clusterBySimilarity/sharedLabel) instead of a second, target-only classifier — and the
  // bundle is framed as a VERIFY-worthy candidate (chain-transitive clustering can loop in an
  // outlier via a shared boilerplate word), never asserted as certain.
  ok(dsrc20.includes('crossServiceBundles = clusterBySimilarity(clusterInput)') && dsrc20.includes('b.targets.length >= 2'), 'KI-E74: decisions-digest bundles cross-SERVICE duplicates via the shared clusterer, filtered to genuinely cross-target clusters');
  ok(dsrc20.includes('Candidate cross-service question bundles') && dsrc20.includes('VERIFY before ruling, do not assume'), 'KI-E74: the cross-service bundle is framed as a candidate to verify, not an assertion (chain-transitive clustering can merge a tangential outlier)');
  ok(dsrc20.includes("'FAILED', 'ESCALATED', 'BLOCKED'"), 'KI-E34: cmdRecover accepts BLOCKED (owner-ruling recovery)');
  ok(dsrc20.includes('COMMITTED DELIVERY') && dsrc20.includes('MAIN-TREE CONTAMINATION'), 'KI-E35: fold splits human-committed delivery from agent contamination');
  ok(dsrc20.includes('possibly DELIVERED in HEAD (KI-E36)'), 'KI-E36: escalations queue carries the delivered-in-HEAD hint');
  ok((dsrc20.match(/deliveredInHeadHint\(/g) || []).length >= 3, 'KI-E36 (review fix): the delivered-in-HEAD hint renders in BOTH the queue and the decisions-digest');
  ok(dsrc20.includes("['compose', '-p', p.Name, 'down', '-v', '--remove-orphans']") && dsrc20.includes('strayComposeProjects(parseComposeLs(raw), wtRoot)') && dsrc20.includes('abs(cfg.paths.worktreesState)'), 'KI-E37: gc downs only compose projects under the CONFIGURED worktrees root (review fix)');
  ok(dsrc20.includes('debris/P9 diff checks SKIPPED'), 'KI-E20 (review fix): the override announces a gone/unreadable worktree instead of silently skipping diff checks');
  const { closedDepsWithLiveWorktree } = await import('./ledger.mjs');
  eq(closedDepsWithLiveWorktree([{ id: 'B', dependsOn: ['A'] }], { A: { state: 'CLOSED', worktree: 'state/worktrees/A' } }, () => true), [{ id: 'B', dep: 'A', worktree: 'state/worktrees/A' }], 'KI-E29 (review fix): a CLOSED dep with a live ledger-recorded worktree -> warn');
  eq(closedDepsWithLiveWorktree([{ id: 'B', dependsOn: ['A'] }], { A: { state: 'CLOSED', worktree: null } }, () => true).length, 0, 'KI-E29 (review fix): gc nulls row.worktree -> no warn (dep committed + collected)');
  eq(closedDepsWithLiveWorktree([{ id: 'B', dependsOn: ['A'] }], { A: { state: 'CLOSED', worktree: 'state/worktrees/sweep-3' } }, (w) => w.includes('sweep')), [{ id: 'B', dep: 'A', worktree: 'state/worktrees/sweep-3' }], 'KI-E29 (review fix): a SWEEP-closed dep is covered — the row path, not an assumed <id> dir');
  ok(dsrc20.includes('closedDepsWithLiveWorktree(picked, ledger.items'), 'KI-E29 (review fix): cmdGroup wires the pure warn core');
  ok(dsrc20.includes('unwrapResultEnvelope(readJson(foldPath)') && dsrc20.includes('payload carried ZERO results'), 'KI-E31 (review fix): cmdFold wires the unwrap AND stops loudly on a zero-result payload (no success affect)');
  ok(readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8').includes('means EXACTLY a product-scope.md red-line'), 'KI-E30: the shared gate prompt carries the scopeViolation clarification');
  ok(/return `## \$\{id\} — \$\{r\.state\}\\n\\n- \$\{lastNote\(r\)\}/.test(dsrc20), 'KI-E53: escalations per-item line renders lastNote(r) (the real last-transition reason) — not the never-populated static r.note field');
}

// KI-E37 (review fix): compose-ls parsing + the stray filter — behavioral (pure, no docker).
{
  const { parseComposeLs, strayComposeProjects } = await import('./worktree.mjs');
  eq(parseComposeLs(''), [], 'KI-E37: blank compose-ls output -> no projects');
  eq(parseComposeLs('[{"Name":"a","ConfigFiles":"/x/a.yml"}]').length, 1, 'KI-E37: JSON-array shape parses');
  eq(parseComposeLs('{"Name":"a"}\n{"Name":"b"}').length, 2, 'KI-E37: NDJSON shape parses');
  eq(parseComposeLs('{"Name":"solo"}').length, 1, 'KI-E37: a lone object is wrapped');
  const WT37 = '/repo/_f/state/worktrees';
  const strays37 = strayComposeProjects([
    { Name: 'wt', ConfigFiles: WT37 + '/ID-1/docker-compose.yml' },
    { Name: 'sibling', ConfigFiles: WT37 + '-archive/x/docker-compose.yml' },
    { Name: 'hybrid', ConfigFiles: '/host/docker-compose.yml,' + WT37 + '/ID-2/override.yml' },
    { Name: 'host', ConfigFiles: '/host/docker-compose.yml' },
    { Name: 'multiwt', ConfigFiles: WT37 + '/ID-3/a.yml, ' + WT37 + '/ID-3/b.yml' },
  ], WT37);
  eq(strays37.map((p) => p.Name), ['wt', 'multiwt'], 'KI-E37: EVERY config must sit under the ANCHORED worktrees root — sibling dirs + hybrid host projects never match (review fix)');
  eq(strayComposeProjects([{ Name: 'w', ConfigFiles: WT37 + '/ID/x.yml' }], WT37 + '/').length, 1, 'KI-E37: trailing-separator root normalizes');
  eq(strayComposeProjects(null, WT37).length, 0, 'KI-E37: null projects -> empty');
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
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'Uses the same chain OrdersController uses today.', files: [] }, io22).length, 0, 'KI-E32: "same … chain X" reads as a reference, not a gap');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ResolveThing at doc/data-flows/SvcA.md:42 explains it.', files: ['SvcA/README.md'] }, io22).length, 0, 'KI-E32: a File:line citation is a reference, not a gap');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'Do NOT touch OrdersController; leave it alone.', files: [] }, io22).length, 0, 'KI-E32: "do NOT touch X" exclusion is not a gap');
  // …but an ACTIVELY-named edit target still surfaces (the heuristic stays conservative)
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ItemsController clamps page before querying.', files: [] }, io22).map((g) => g.resolved), ['SvcA/src/Api/ItemsController.cs'], 'KI-E32: an actively-named surface is still a gap (no over-suppression)');
  // Review-fix pins: cue tightening — everyday ACTIVE phrasings flag; strong references stay suppressed.
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'Update the existing ItemsController to clamp page.', files: [] }, io22).length, 1, 'KI-E32 (review fix): "the existing X" is an ACTIVE edit target — no longer suppressed');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ItemsController uses a raw Skip; fix it.', files: [] }, io22).length, 1, 'KI-E32 (review fix): "X uses <bad thing>" is the canonical defect phrasing — no longer suppressed');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'ItemsController does not clamp pageSize.', files: [] }, io22).length, 1, 'KI-E32 (review fix): "X does not …" flags');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'See ItemsController and fix the off-by-one there.', files: [] }, io22).length, 1, 'KI-E32 (review fix): bare "see X" no longer suppresses an edit directive');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'Never touch OrdersController; ItemsController must clamp page.', files: [] }, io22).map((g) => g.resolved), ['SvcA/src/Api/ItemsController.cs'], 'KI-E32 (review fix): a cue in the PREVIOUS clause does not suppress the next clause (clause stops)');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'Score is resolved (ItemsController.cs:739) and cached.', files: [] }, io22).length, 0, 'KI-E32 (review fix): a bare TypeName.cs:NN citation is recognized (the row\'s own example shape)');
  eq(acceptanceSurfaceGaps({ target: 'SvcA', acceptance: 'Follows the ItemsController pattern for paging.', files: [] }, io22).length, 0, 'KI-E32: "X pattern" stays a reference');
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
  // Review-fix pins: the sniff boundaries are a deliberate contract.
  const env31e = { summary: 's', result: { mode: 'run', cycle: 9, results: [] } };
  eq(unwrapResultEnvelope(env31e), env31e.result, 'KI-E31 (review fix): an EMPTY-results envelope still unwraps — cmdFold then stops LOUDLY on zero results');
  const mode31 = { result: { mode: 'x' } };
  eq(unwrapResultEnvelope(mode31), mode31.result, 'KI-E31: the mode cue alone unwraps (sniff pinned so widening stays deliberate)');
  const inert31 = { result: { verdict: 'ok' } };
  eq(unwrapResultEnvelope(inert31), inert31, 'KI-E31: a cue-less .result passes through untouched');
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
    { number: 4242, title: 'Example: the link opens the right record', body, labels: [{ name: 'bug' }, { name: 'CRM' }] },
    { repo: 'example-org/example-repo', idPrefix: 'GH' });
  eq(withAcc.id, 'GH-4242', 'ingest: github id is prefix + issue number');
  eq(withAcc.autonomyTier, 'escalate', 'ingest: acceptance section found -> escalate (human confirms), never auto');
  eq(withAcc.fixType, 'non-trivial', 'ingest: acceptance section found -> non-trivial');
  eq(withAcc.theme, 'crm-link-integrity', 'ingest: theme routed from labels');
  eq(withAcc.source, 'example-org/example-repo#4242', 'ingest: source stamps repo#number');
  eq(withAcc.files, [], 'ingest: files[] starts empty — the human authors the lock set');
  ok(/^[A-Z0-9]+(-[A-Z0-9]+)+$/.test(withAcc.id), 'ingest: generated id is schema-valid');

  // an issue WITHOUT an acceptance section -> blocked triage / owner-decision, with a triage ownerDecision
  const noAcc = githubIssueToItem({ number: 42, title: 'Vague thing', body: 'no structure here', labels: [] }, { repo: 'o/r' });
  eq(noAcc.autonomyTier, 'blocked', 'ingest: no acceptance section -> blocked triage (never auto-runs)');
  eq(noAcc.fixType, 'owner-decision', 'ingest: no acceptance section -> owner-decision');
  ok(!!noAcc.ownerDecision, 'ingest: triage item carries an ownerDecision prompt');
  ok(!!noAcc.acceptance && !!noAcc.regressionTest, 'ingest: triage item still fills acceptance/regressionTest so merge-graph validation passes (as triage text)');

  // markdown checklist -> one blocked item per UNCHECKED box (checked [x] = done work, skipped —
  // review fix); ids are content-hashed so backlog edits/reorders never re-attach ledger state.
  const items = markdownChecklistToItems('- [ ] First task\n- [x] done already\nnot a task\n* [ ] Second task', { idPrefix: 'BL' });
  eq(items.length, 2, 'ingest (review fix): markdown picks up UNCHECKED boxes only — a checked [x] box is done work, not a fresh item');
  ok(/^BL-[0-9A-F]{8}$/.test(items[0].id), 'ingest (review fix): markdown id is prefix + content hash (stable under reorder/insertion)');
  eq(markdownChecklistToItems('- [ ] Zeroth\n- [ ] First task', { idPrefix: 'BL' })[1].id, items[0].id, 'ingest (review fix): the same title keeps the same id when lines shift');
  eq(countCheckedBoxes('- [ ] a\n- [x] b\n- [X] c'), 2, 'ingest (review fix): countCheckedBoxes reports what the unchecked-only rule skipped');
  eq(items.every((i) => i.autonomyTier === 'blocked'), true, 'ingest: markdown items are all blocked triage');

  // report split (+ the review-fix `other` bucket: an unexpected tier is never silently uncounted)
  const rep = ingestReport([withAcc, noAcc, ...items]);
  eq(rep.total, 4, 'ingest: report totals every item');
  eq(rep.escalate, 1, 'ingest: report counts the one escalate item');
  eq(rep.blocked, 3, 'ingest: report counts the blocked-triage items');
  eq(ingestReport([{ autonomyTier: 'auto', severity: 'LOW' }]).other, 1, 'ingest (review fix): an unexpected tier lands in `other` — the "none are auto-runnable" line must never print over it');

  // Review fix — the honest-acceptance invariant is ENFORCED, not just mapped: passthrough clamps.
  eq(enforceIngestTier({ acceptance: 'x', autonomyTier: 'auto' }).autonomyTier, 'escalate', 'KI-E27 (review fix): a passthrough auto tier clamps to escalate — ingest NEVER emits schedulable items');
  eq(enforceIngestTier({ acceptance: 'x' }).autonomyTier, 'escalate', 'KI-E27 (review fix): a MISSING tier with acceptance clamps to escalate (merge-graph would default it to auto)');
  eq(enforceIngestTier({}).autonomyTier, 'blocked', 'KI-E27 (review fix): a missing tier without acceptance clamps to blocked');
  eq(enforceIngestTier({ autonomyTier: 'blocked' }).autonomyTier, 'blocked', 'KI-E27: blocked stays blocked through the clamp');

  // Review-fix pins: secondary mapper paths + boundary hardening.
  const repro27 = githubIssueToItem({ number: 7, title: 't', body: '## Expected behaviour\nok\n## Steps to reproduce\n1. click\n2. boom', labels: [] }, {});
  ok(repro27.regressionTest.includes('1. click'), 'ingest: a repro section lifts into regressionTest');
  const dod27 = githubIssueToItem({ number: 8, title: 't', body: '## Definition of done\nall green', labels: [] }, {});
  eq(dod27.autonomyTier, 'escalate', 'ingest: alternate acceptance headings (Definition of done) escalate too');
  ok(dod27.acceptance.includes('"Definition of done"'), 'ingest (review fix): provenance cites the ACTUAL matched heading, not a hardcoded one');
  const fenced27 = extractSection('## Expected behaviour\nline one\n```bash\n# a comment, not a heading\necho hi\n```\nline two\n## Next\nz', ['expected behaviou?r']);
  ok(fenced27.includes('# a comment') && fenced27.includes('line two'), 'ingest (review fix): fenced code inside a section neither stops nor truncates the lift');
  eq(severityFromLabels(['not-critical']), 'MEDIUM', 'ingest (review fix): "not-critical" is not CRITICAL (hyphen boundary)');
  eq(severityFromLabels(['P10']), 'MEDIUM', 'ingest (review fix): P10 is not the p1 of HIGH (alnum boundary)');
  eq(severityFromLabels(['high', 'critical']), 'CRITICAL', 'ingest: CRITICAL beats HIGH on multi-label (order pin)');
  eq(themeFromLabels(['docker']), 'triage', 'ingest (review fix): a docker label is not doc-drift (word boundary)');
  eq(themeFromLabels([{ name: 'payment' }]), 'money', 'ingest: money labels route the money theme');
  eq(themeFromLabels(['race-condition']), 'concurrency', 'ingest: concurrency labels route');
}

// KI-E33: cost-telemetry readiness probe (pure over injected env)
{
  eq(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }).ready, true, 'KI-E33: enable + otlp exporter + endpoint -> ready');
  eq(costTelemetryReady({ OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }).ready, false, 'KI-E33: no CLAUDE_CODE_ENABLE_TELEMETRY -> not gathered');
  eq(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: 'true', OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'x' }).ready, false, 'KI-E33 (review fix): "true" is not "1" — the likeliest real misconfig is caught and named');
  ok(/OTEL_METRICS_EXPORTER/.test(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'x' }).reason), 'KI-E33 (review fix): enable+endpoint alone export NOTHING — the missing metrics exporter is named, never a false ready');
  eq(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'console', OTEL_EXPORTER_OTLP_ENDPOINT: 'x' }).ready, false, 'KI-E33 (review fix): a non-otlp metrics exporter is not ready');
  eq(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp' }).ready, false, 'KI-E33: no OTLP endpoint -> not gathered');
  eq(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://m:4318' }).endpoint, 'http://m:4318', 'KI-E33 (review fix): the metrics-specific endpoint counts — no false NOT-gathered');
  eq(costTelemetryReady({ FACTORY_TELEMETRY: '0', CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'x' }).ready, true, 'KI-E33 (review fix): FACTORY_TELEMETRY mutes only factory events — session cost telemetry is an independent plane');
  ok(/http\/protobuf/.test(costTelemetryReady({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: 'x' }).note || ''), 'KI-E33 (review fix): the protocol-unset caution rides on ready (grpc default vs the :4318 HTTP collector)');
  ok(/telemetry\/claude-code-telemetry\.env\.example|CLAUDE_CODE_ENABLE_TELEMETRY/.test(readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8')), 'KI-E33: driver preflight surfaces the cost-telemetry cue');
}

// KI-E72: dotnetAvailable() also credits the verify/build-test.local.sh host PATH shim (KI-E17) —
// a controller session's own raw PATH lacking dotnet (e.g. a non-interactive shell that never
// sources ~/.zshrc) must not misreport ABSENT when the shim every real verify call uses is present.
{
  const execShim = join(dir, 'fake-build-test.local.sh');
  fsWrite(execShim, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(execShim, 0o755);
  ok(shimAvailable(execShim), 'KI-E72: shimAvailable is true for an existing, executable shim path');
  const nonExecShim = join(dir, 'fake-build-test-noexec.local.sh');
  fsWrite(nonExecShim, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(nonExecShim, 0o644);
  ok(!shimAvailable(nonExecShim), 'KI-E72: shimAvailable is false for a present but non-executable file (mode bit checked, not just existence)');
  ok(!shimAvailable(join(dir, 'does-not-exist.sh')), 'KI-E72: shimAvailable is false for a nonexistent path');
  ok(!shimAvailable(''), 'KI-E72: shimAvailable degrades to false, never throws, on an empty path');
  ok(dotnetAvailable(execShim), 'KI-E72: dotnetAvailable(shimPath) is true when an injected shim resolves, independent of raw dotnet on THIS process PATH');
}

// KI-E73: deriveUnfoldedCycle — shared by cmdResume (checkpoint visibility) and cmdReconstruct
// (KI-L63 parallel-lane derivation). Live bug shape: an item checkpoints at resultId "<id>#N" where
// N === ledger.cycle (the KI-E69 `resume --reuse` relaunch shape — items keep their OWN claim's
// cycle rather than getting a freshly-bumped one) — the naive "always ledger.cycle+1" guess misses
// this entirely.
{
  const itemsRoot73 = join(dir, 'ki-e73-items');
  mkdirSync(itemsRoot73, { recursive: true });
  eq(deriveUnfoldedCycle(itemsRoot73, { cycle: 5, folded: {} }), 6, 'KI-E73: empty items dir -> falls back to ledger.cycle + 1');
  mkdirSync(join(itemsRoot73, 'FOO'), { recursive: true });
  fsWrite(join(itemsRoot73, 'FOO', 'result.json'), JSON.stringify({ id: 'FOO', resultId: 'FOO#5', toState: 'CLOSED' }));
  eq(deriveUnfoldedCycle(itemsRoot73, { cycle: 5, folded: {} }), 5, 'KI-E73 (the live ITEM-H1-class bug): a same-cycle checkpoint (resultId ends #5, ledger.cycle is ALSO 5 — the --reuse relaunch shape) is found, NOT blindly guessed as 6');
  eq(deriveUnfoldedCycle(itemsRoot73, { cycle: 5, folded: { 'FOO#5': true } }), 6, 'KI-E73: an ALREADY-FOLDED checkpoint is excluded — falls back to ledger.cycle + 1 with nothing else on disk');
  mkdirSync(join(itemsRoot73, 'BAR'), { recursive: true });
  fsWrite(join(itemsRoot73, 'BAR', 'result.json'), JSON.stringify({ id: 'BAR', resultId: 'BAR#7', toState: 'FAILED' }));
  eq(deriveUnfoldedCycle(itemsRoot73, { cycle: 5, folded: { 'FOO#5': true } }), 7, 'KI-E73 (KI-L63 parallel-lane shape): the MAX unfolded cycle across items wins — BAR#7 found even though FOO#5 is already folded');
  mkdirSync(join(itemsRoot73, 'BAD'), { recursive: true });
  fsWrite(join(itemsRoot73, 'BAD', 'result.json'), '{ not valid json');
  eq(deriveUnfoldedCycle(itemsRoot73, { cycle: 5, folded: { 'FOO#5': true } }), 7, 'KI-E73: an unparseable result.json is skipped gracefully, never throws, never poisons the max');
  const drvText73 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(/deriveUnfoldedCycle\(abs\(cfg\.paths\.items\), ledger\)/.test(drvText73), 'KI-E73: cmdResume calls the SHARED deriveUnfoldedCycle (no local re-inlined copy to drift again)');
  ok((drvText73.match(/deriveUnfoldedCycle\(/g) || []).length === 2, 'KI-E73: exactly 2 call sites (cmdResume + cmdReconstruct) — the old inline duplicate in cmdReconstruct is gone');
}

// KI-E43: integrate/verify baseline parity — the effective baseline is the LARGER of the
// run-reported array and the RED-time baseline-raw.txt transcript (pure; the cycle-47
// ITEM-H15 false regression — 6 pre-existing Docker-unavailable failures vs baseline [] —
// is the motivating case).
{
  eq(effectiveBaseline([], null), 0, 'KI-E43: no report + no transcript -> 0 (pre-KI-E43 behavior unchanged)');
  eq(effectiveBaseline(['A', 'B'], null), 2, 'KI-E43: transcript-less run keeps the reported baseline');
  eq(effectiveBaseline(undefined, null), 0, 'KI-E43: absent report array -> 0, never NaN');
  eq(effectiveBaseline([], parseVerifyRaw('FACTORY::SUMMARY::suite exit=1 failed=6 passed=700 skipped=0')), 6, 'KI-E43: empty report + RED-time transcript with 6 env failures -> 6 (the ITEM-H15 cycle-47 shape)');
  eq(effectiveBaseline(['A'], parseVerifyRaw('FACTORY::SUMMARY::suite exit=1 failed=6 passed=700 skipped=0')), 6, 'KI-E43: the larger of the two counts wins');
  eq(effectiveBaseline(['A', 'B', 'C'], parseVerifyRaw('FACTORY::SUMMARY::suite exit=1 failed=1 passed=9')), 3, 'KI-E43: a bigger reported array is never shrunk by the transcript');
  eq(effectiveBaseline([], parseVerifyRaw('no markers here')), 0, 'KI-E43: an unparseable baseline transcript contributes 0');
  eq(effectiveBaseline([], parseVerifyRaw('FACTORY::SUMMARY::suite exit=0 failed=0 passed=10')), 0, 'KI-E43: a GREEN baseline transcript adds nothing — no free failure allowance');
  const drvText43 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  const facText43 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(/baseline-raw\.txt/.test(drvText43) && /effectiveBaseline\(/.test(drvText43), 'KI-E43: the fold override merges the RED-time baseline transcript');
  ok(/KI-E43 reFix fence/.test(drvText43) && /prevState === 'FAILED'/.test(drvText43), 'KI-E43: a reFix round distrusts a transcript (re)captured after claim — the prior fix cannot launder its own breakage into the baseline (review find)');
  ok(/FULL-SUITE BASELINE \(KI-E43\)/.test(facText43), 'KI-E43: the RED brief instructs the pre-fix baseline capture on Docker-less hosts');
  ok(/test\.baselineFailures/.test(facText43), 'KI-E43: the checkpoint prefers the RED-stage baseline over the verify-stage report');
}

// KI-E41/E42/E44: killed-run relaunch hardening — main-guard at resume, artifact quarantine,
// reconstruct usage passthrough (cycle-47 post-mortem engine fixes).
{
  const T42 = await import('./telemetry.mjs');
  const junk = T42.nonCanonicalArtifacts(['RESULT.md', 'COMPLETION.md', 'notes.txt', 'plan.md', 'gate-developer.md', 'review-adversarial.md', 'feedback.md', 'result.json', 'verify-raw.txt', 'main-snapshot.json', 'baseline-raw.txt', 'review-pack.md', 'last-failure.md']);
  eq(junk, ['RESULT.md', 'COMPLETION.md', 'notes.txt'], 'KI-E42: exactly the improvised artifacts classify non-canonical (the cycle-47 stray RESULT.md class); stage + control files never do');
  eq(T42.nonCanonicalArtifacts([]), [], 'KI-E42: empty artifact dir -> nothing to quarantine');
  // KI-E71 (live 2026-08-07): leftover-raw.txt is the KI-D12 probe's OWN artifact (factory.js writes
  // res.artifacts['probe:leftover-scan'] to exactly this filename) and must never classify as debris
  // — it was missing from STAGE_ARTIFACTS and false-positived "from the dead attempt" on every item
  // that reached that stage, live run or not. leftover-final.txt has ZERO references anywhere in
  // factory.js/agents/*.md — it genuinely IS agent improvisation and must stay flagged.
  eq(T42.nonCanonicalArtifacts(['leftover-raw.txt', 'leftover-final.txt', 'plan.md']), ['leftover-final.txt'], 'KI-E71: leftover-raw.txt is canonical (KI-D12 probe output); leftover-final.txt is genuine improvisation and still flags');
  eq(T42.stageForArtifact('leftover-raw.txt'), 'probe:leftover-scan', 'KI-E71: leftover-raw.txt maps to the probe:leftover-scan stage');
  const drvText42 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(/resume --quarantine/.test(drvText42) && /flags\.quarantine/.test(drvText42), 'KI-E42: resume detects debris always, moves only on --quarantine');
  ok(/MAIN-GUARD/.test(drvText42) && /KI-E41/.test(drvText42), 'KI-E41: resume diffs main-snapshot.json for relaunch candidates before printing the launch lines');
  ok(/MAIN-GUARD \$\{id\} SKIPPED/.test(drvText42) && /DEBRIS-CHECK \$\{id\} SKIPPED/.test(drvText42), 'KI-E41/E42: a failed relaunch check ANNOUNCES itself — silence never reads as clean (review find)');
  ok(/usage-tokens/.test(drvText42) && /KI-E44/.test(drvText42), 'KI-E44: reconstruct accepts --usage-tokens and stamps payload.usage for the fold emit');
  ok(/gapsByItem/.test(drvText42) && /KI-E45/.test(drvText42), 'KI-E45: the claim-time main-snapshot unions files[] with the KI-E22 acceptance-resolved paths');
}

// KI-E46..E51 (2026-07-26): telemetry-driven effectiveness wave — direct-recovery classification
// (the KPI undercounted the factory's dominant close path: 9 of 13 live recoveries read as plain
// re-band closes), recovery folds out of the derived duration authority, band-split first-pass
// KPI, agent event-vocabulary clamp + ts-paired agent durations, the mid-band main-drift check,
// and the count-claim / test-comment briefs targeting the fix-introduced-defect class.
{
  const T = await import('./telemetry.mjs');
  // KI-E46 — the classifier over every live recovery signature
  ok(T.isRecoveryResultId('X#47r') && T.isRecoveryResultId('X#27r3'), 'KI-E46: #Nr and #NrK resultIds classify as recovery');
  ok(!T.isRecoveryResultId('X#47') && !T.isRecoveryResultId('') && !T.isRecoveryResultId(null), 'KI-E46: plain #N / empty / null never classify');
  ok(T.isDirectRecoveryFold({ gates: { 'direct-recovery': 'converged-remedy (x)' } }), 'KI-E46: legacy gates-map signature classifies');
  ok(T.isDirectRecoveryFold({ note: 'direct-recovery, 4 delta re-gate rounds to convergence' }), 'KI-E46: scaffolded note prefix classifies (the live cycle-47r/48r shape)');
  ok(T.isDirectRecoveryFold({ resultId: 'A#48r' }) && T.isDirectRecoveryFold({ direct: true }), 'KI-E46: emit-time resultId/direct stamps classify');
  ok(!T.isDirectRecoveryFold({ note: 'closed clean; not a direct-recovery' }) && !T.isDirectRecoveryFold({}), 'KI-E46: a mid-note mention or empty attrs never classifies (prefix-anchored)');
  // KI-E46 + KI-E48 end-to-end: a recovery close counts recovered (never first-pass); bands split
  const agg46 = T.aggregateEvents([
    { event: 'item_folded', source: 'driver', item: 'A', cycle: 47, attrs: { toState: 'FAILED', band: 'LIGHT', gates: { 'gate:qa': 'CHANGES_REQUIRED' } } },
    { event: 'item_folded', source: 'driver', item: 'A', cycle: 47, attrs: { toState: 'CLOSED', band: 'LIGHT', note: 'direct-recovery (3 lenses converged)', gates: {} } },
    { event: 'item_folded', source: 'driver', item: 'B', cycle: 48, attrs: { toState: 'CLOSED', band: 'LIGHT', gates: { 'gate:qa': 'APPROVED' } } },
    { event: 'item_folded', source: 'driver', item: 'C', cycle: 49, attrs: { toState: 'CLOSED', band: 'FULL', resultId: 'C#49', gates: { 'gate:qa': 'APPROVED' } } },
  ]);
  eq(agg46.itemFolds['A'].map((f) => f.direct), [false, true], 'KI-E46: the scaffolded recovery fold classifies direct in aggregation');
  const md46 = T.renderTelemetryReport(agg46, { generatedAt: 'T', file: 'f' });
  ok(md46.includes('First-pass close rate (clean first fold / closed) | 2/3'), 'KI-E46: a recovery close is never first-pass');
  ok(md46.includes('Direct-recovery rate (recovered closes / closed) | 1/3'), 'KI-E46: the scaffolded recovery close now counts in the KPI');
  ok(md46.includes('| First-pass — FULL band (KI-E48) | 1/1 closed = 100% (1 folded) |'), 'KI-E48: FULL-band split row renders');
  ok(md46.includes('| First-pass — LIGHT band (KI-E48) | 1/2 closed = 50% (2 folded) |'), 'KI-E48: LIGHT-band split row renders');
  const aggLegacy = T.aggregateEvents([{ event: 'item_folded', source: 'driver', item: 'A', attrs: { toState: 'CLOSED', gates: {} } }]);
  ok(!T.renderTelemetryReport(aggLegacy, { generatedAt: 'T', file: 'f' }).includes('KI-E48'), 'KI-E48: a pure-legacy (unstamped) stream renders no band rows');
  // KI-E48 — ts-paired agent durations (agents never pass --durMs; the table was permanently empty)
  const aggTs = T.aggregateEvents([
    { event: 'stage_start', source: 'agent', item: 'A', role: 'fixer', stage: 'fix', ts: '2026-07-26T10:00:00.000Z' },
    { event: 'stage_end', source: 'agent', item: 'A', role: 'fixer', stage: 'fix', ts: '2026-07-26T10:05:00.000Z' },
    { event: 'stage_start', source: 'agent', item: 'B', role: 'runner', ts: '2026-07-26T10:00:00.000Z' },
    { event: 'stage_end', source: 'agent', item: 'B', role: 'runner', ts: '2026-07-27T10:00:00.000Z' },
  ]);
  eq(aggTs.agentStages.fix, [300000], 'KI-E48: paired agent start/end ts derive a best-effort duration');
  ok(!aggTs.agentStages.verify, 'KI-E48: a pair spanning the gap fence is dropped (dead-attempt start + relaunch end)');
  // KI-E49 — the agent event-vocabulary clamp
  eq(T.clampAgentEvent('stage_start'), 'stage_start', 'KI-E49: canonical events pass the clamp');
  eq(T.clampAgentEvent('dummy_probe'), 'agent_note', 'KI-E49: a free-typed event clamps to agent_note (the live probe/dummy_probe/tool_use class)');
  eq(T.clampAgentEvent(''), 'agent_note', 'KI-E49: empty clamps too (emit still requires --event upstream)');
  // source contracts
  const drv46 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(/isRecoveryResultId\(r\.resultId\) \|\| isDirectRecoveryFold\(/.test(drv46) && /KI-E47/.test(drv46), 'KI-E47: the fold derives no stage timeline for ANY recovery-signature fold (full KI-E46 set) + stamps direct/resultId');
  ok(/case 'main-check'/.test(drv46) && /KI-E50/.test(drv46), 'KI-E50: driver main-check command exists (read-only, warn-only)');
  ok(!/MUTATING = new Set\(\[[^\]]*main-check/.test(drv46), 'KI-E50: main-check is NOT in the mutating set (no lock, no lease)');
  const fac46 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(/MAIN-DRIFT CHECK \(KI-E50\)/.test(fac46) && /main-check ' \+ id/.test(fac46), 'KI-E50: the runner verify hint carries the mid-band main-check command');
  const emit46 = readFileSync(join(import.meta.dirname, '..', 'telemetry-emit.mjs'), 'utf8');
  ok(/clampAgentEvent/.test(emit46) && /origEvent/.test(emit46), 'KI-E49: telemetry-emit clamps the vocabulary and preserves the original name');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'fixer.md'), 'utf8').includes('COUNT-CLAIM SELF-CHECK (KI-E51)'), 'KI-E51: fixer card carries the count-claim self-check');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'test-author.md'), 'utf8').includes('NO-COMMENTS POLICY (KI-E51/KI-E57'), 'KI-E51: test-author card carries the absolute no-comments policy');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'fixer.md'), 'utf8').includes('NO-COMMENTS POLICY (KI-E55/KI-E57'), 'KI-E55: fixer card carries the absolute no-comments policy (KI-E51 extended from test files to every file the fixer touches)');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'gate-developer.md'), 'utf8').includes('Hunt and FAIL on (KI-E55/KI-E57'), 'KI-E55: gate-developer card carries the absolute no-comments backstop check');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'review-code.md'), 'utf8').includes('KI-E51/KI-E55/KI-E57'), 'KI-E55: review-code card excludes ALL new comments from its style-nits carve-out, not just narrative ones');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'test-author.md'), 'utf8').includes('KI-E56'), 'KI-E56: test-author card no longer hardcodes a single test framework assumption');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'fixer.md'), 'utf8').includes('DB/schema changes (KI-E58, HOST-POLICY-GATED)'), 'KI-E58: fixer card carries the host-policy-gated no-schema-changes hard stop');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'planner.md'), 'utf8').includes('DB/schema changes (KI-E58, HOST-POLICY-GATED)'), 'KI-E58: planner card carries the host-policy-gated no-schema-changes hard stop');
  // PR#9 review — the policy sections are CONDITIONAL on the injected HOST POLICY blocks, with an
  // explicit policy-OFF branch, and fixer Do-6's divergence call-site tag is waived under the
  // no-comments policy (previously Do-6 mandated a comment Do-7 forbade — a self-contradiction).
  for (const b of ['fixer', 'test-author', 'gate-developer', 'review-code', 'planner']) {
    const bt = readFileSync(join(import.meta.dirname, '..', '..', 'agents', b + '.md'), 'utf8');
    ok(bt.includes('HOST POLICY —'), 'PR#9: ' + b + ' card conditions its policy section on the HOST POLICY prompt block');
    ok(/When NO such block is present/i.test(bt), 'PR#9: ' + b + ' card states the policy-OFF behaviour explicitly');
  }
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'fixer.md'), 'utf8').includes('the ledger entry alone'), 'PR#9: fixer Do-6 waives the call-site tag comment under the no-comments policy (Do-6/Do-7 contradiction resolved)');
  ok(readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'gate-architect.md'), 'utf8').includes('HOST POLICY — NO DB/SCHEMA CHANGES'), 'PR#9: gate-architect reconciles the CLI-migrations norm with the no-schema-changes policy');
}

// KI-E52 (2026-07-26): versioned releases + team install/upgrade + per-developer telemetry
// bootstrap (setup/install.sh, setup/release.sh, VERSION, CHANGELOG.md). Source-contract pins —
// the behaviours are E2E-tested by the installer's own fixture flow (install → rollback-on-red →
// pinned upgrade → telemetry env → vendored refusal).
{
  const ROOT = join(import.meta.dirname, '..', '..');
  const ver = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
  ok(/^\d+\.\d+\.\d+$/.test(ver), 'KI-E52: VERSION is semver X.Y.Z');
  const inst = readFileSync(join(ROOT, 'setup', 'install.sh'), 'utf8');
  ok(/ls-remote --tags --refs/.test(inst) && /sort -V/.test(inst), 'KI-E52: latest release resolves from remote vX.Y.Z tags (no gh dependency for installs)');
  ok(/run_selftest/.test(inst) && /_selftest\.mjs/.test(inst), 'KI-E52: install AND upgrade are selftest-gated');
  ok(/ROLLING BACK/.test(inst) && inst.includes('git -C "$mount" checkout --quiet "$prev"'), 'KI-E52: a red selftest on upgrade ROLLS BACK to the previous ref');
  ok(/VENDORED/.test(inst), 'KI-E52: a vendored (.git-less) mount is refused, never half-upgraded');
  ok(inst.includes('claude-code-telemetry.env') && inst.includes('settings.local.json'), 'KI-E52: telemetry bootstrap writes the per-host env file AND merges the host settings env block');
  ok(/ai-factory cost telemetry/.test(inst) && /\.bashrc/.test(inst), 'KI-E52: optional shell-profile env block (the KI-E33-reliable session path) is marker-guarded');
  ok(inst.includes('docker compose --project-directory'), 'KI-E52: the compose stack starts against the mount telemetry dir (per-host .env respected, KI-E25)');
  ok(inst.includes('if [ -n "$HOST" ]'), 'KI-E52: an explicit --host beats script self-location (E2E-caught redirect bug)');
  const rel = readFileSync(join(ROOT, 'setup', 'release.sh'), 'utf8');
  ok(/_selftest\.mjs/.test(rel) && /git tag -a/.test(rel) && rel.includes('> VERSION'), 'KI-E52: release cut is selftest-gated, bumps VERSION, tags vX.Y.Z');
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  ok(/^telemetry\/\.env$/m.test(gi), 'KI-E52: per-host telemetry/.env is gitignored (E2E-caught — upgrades must see a clean tree)');
  // Deep-review hardening pins (2026-07-27) — behaviors are exercised end to end by setup/_e2e.sh.
  const { execFileSync: exf52 } = await import('node:child_process');
  let parse52 = true;
  try { for (const s of ['install.sh', 'release.sh', '_e2e.sh']) exf52('bash', ['-n', join(ROOT, 'setup', s)]); } catch { parse52 = false; }
  ok(parse52, 'KI-E52: install.sh / release.sh / _e2e.sh all parse (bash -n)');
  ok(existsSync(join(ROOT, 'setup', '_e2e.sh')), 'KI-E52: the hermetic E2E harness ships in-tree — the "E2E-tested" claim is re-runnable');
  ok(/REFUSING to touch/.test(inst), 'KI-E52: an existing-but-unparseable settings.local.json is refused, never clobbered (review fix)');
  ok(inst.includes('cannot reach $REPO') && inst.includes("grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$'"), 'KI-E52: latest-release resolve dies loudly on an unreachable remote and only strict vX.Y.Z tags win (review fix)');
  ok(inst.includes('install_cleanup') && inst.includes('rm -rf "$INSTALL_CREATED"'), 'KI-E52: a failed install removes the mount it created — no half-install blocks the corrective re-run (review fix)');
  ok(inst.includes('|| warn "telemetry bootstrap FAILED') && inst.includes('setup/init.mjs" --repo-root "$(host_of_mount'), 'KI-E52: telemetry failure never fails a good engine install; upgrade refreshes host scaffolding via init.mjs (review fix)');
  ok(rel.includes('git push --atomic origin main "refs/tags/$TAG"') && rel.includes('rev-parse origin/main') && rel.includes('HEAD:refs/heads/feature/release-$TAG'), 'KI-E52: release cut is origin-synced + atomic, and a PR-only main falls back to tag + release-branch + PR (review find: a rejected --follow-tags push still published the tag); the fallback branch is feature/-prefixed to satisfy this repo\'s branch-name CI check (live-caught cutting v1.1.0)');
}

// KI-E66 (2026-08-03): cache-hit-rate + token-type breakdown did not exist ANYWHERE in the
// factory's own event stream (only in two permanently-empty Grafana panels, KI-E28/KI-E33 — this
// host's own OTEL exporter env was never actually configured, confirmed live: zero claude_code_*
// metric names in Prometheus despite the compose stack running). Cycle-scoped bridge from
// Prometheus into events.jsonl (lib/token-usage.mjs) + a disclosed per-item apportionment of the
// real KI-E23 output-token total by real per-item call-count share (true per-item measurement is
// not available from inside factory.js's sandboxed Workflow runtime — budget.spent() is a
// whole-turn/whole-workflow aggregate only, per platform docs, and this factory's own multi-month
// history never achieved better despite KI-E23 wanting per-item granularity).
{
  const U = await import('./token-usage.mjs');
  // parseTokenUsageVector — the exact label shape from the already-authored dashboard panels
  // (telemetry/grafana/dashboards/ai-factory.json), an unknown type ignored, an empty result is
  // all-zero (never an error).
  const vec = U.parseTokenUsageVector({ status: 'success', data: { resultType: 'vector', result: [
    { metric: { type: 'input' }, value: [1700000000, '1000'] },
    { metric: { type: 'output' }, value: [1700000000, '200'] },
    { metric: { type: 'cacheRead' }, value: [1700000000, '5000'] },
    { metric: { type: 'cacheCreation' }, value: [1700000000, '300'] },
    { metric: { type: 'somethingUnknown' }, value: [1700000000, '99999'] },
  ] } });
  eq(vec, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 300 }, 'KI-E66: parseTokenUsageVector sums by the exact dashboard type labels, ignoring an unrecognized type');
  eq(U.parseTokenUsageVector({ status: 'success', data: { result: [] } }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'KI-E66: empty Prometheus result -> all-zero, never a throw');
  eq(U.parseTokenUsageVector(null), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'KI-E66: null/malformed input -> all-zero, never a throw');
  ok(U.parseTokenUsageVector({ data: { result: [{ metric: { type: 'input' }, values: [[1, '1'], [2, '7']] }] } }).inputTokens === 7, 'KI-E66: a range-vector series (values[]) reads the LATEST sample, not the first');

  // cacheHitRate — the SAME formula already authored in the "Prompt-cache hit ratio" Grafana panel
  // (cacheRead / (cacheRead + cacheCreation + input)); null (never 0/NaN) with no signal.
  ok(Math.abs(U.cacheHitRate({ cacheReadTokens: 5000, cacheCreationTokens: 300, inputTokens: 1000 }) - (5000 / 6300)) < 1e-9, 'KI-E66: cacheHitRate matches the dashboard formula exactly');
  eq(U.cacheHitRate({ cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0 }), null, 'KI-E66: zero denominator -> null, never 0% or NaN (a bare 0 would silently read as measured zero hits, the KI-E40 lesson)');
  eq(U.cacheHitRate(null), null, 'KI-E66: null usage -> null');
  eq(U.cacheHitRate({ cacheReadTokens: 100, cacheCreationTokens: 0, inputTokens: 0 }), 1, 'KI-E66: all-cache-read (no fresh input at all) -> 100% hit rate');

  // tokenUsageSummary — bundles totals + hit rate together
  const summary = U.tokenUsageSummary({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 300 });
  eq(summary.totalTokens, 6500, 'KI-E66: tokenUsageSummary sums all four buckets');
  ok(Math.abs(summary.cacheHitRate - (5000 / 6300)) < 1e-9, 'KI-E66: tokenUsageSummary carries the same cacheHitRate formula');

  // buildTokenUsageQuery — the increase() PromQL + the window's END as the query time
  const q = U.buildTokenUsageQuery(1700000000000, 1700003600000); // exactly 1h window
  eq(q, { query: 'sum by (type) (increase(claude_code_token_usage_tokens_total[3600s]))', time: 1700003600 }, 'KI-E66: buildTokenUsageQuery windows in seconds and evaluates at the window END');

  // apportionTokensByCallShare — a disclosed apportionment of a REAL total, never a fabricated one
  eq(U.apportionTokensByCallShare(1000, { A: 3, B: 1 }), { A: 750, B: 250 }, 'KI-E66: apportions the real total proportional to real call-count share');
  eq(U.apportionTokensByCallShare(1000, {}), {}, 'KI-E66: no call counts -> nothing to apportion against (empty, never a guess)');
  eq(U.apportionTokensByCallShare(0, { A: 3 }), {}, 'KI-E66: zero real total -> empty (never fabricates a nonzero figure)');
  eq(U.apportionTokensByCallShare(1000, { A: 0, B: 0 }), {}, 'KI-E66: all-zero call counts -> empty, no divide-by-zero');

  // Integration: aggregateEvents + renderTelemetryReport render both new sections, and the
  // itemCallCounts aggregation is keyed by cycle so a retried item's later-cycle calls never
  // dilute an earlier cycle's apportionment.
  const T = await import('./telemetry.mjs');
  const agg66 = T.aggregateEvents([
    { event: 'usage', source: 'driver', cycle: 57, attrs: { outputTokens: 1000, file: 'r57.json' } },
    { event: 'item_folded', source: 'driver', item: 'X', cycle: 57, attrs: { toState: 'CLOSED', gates: {}, cost: { 'claude-sonnet-5': 3 } } },
    { event: 'item_folded', source: 'driver', item: 'Y', cycle: 57, attrs: { toState: 'FAILED', gates: {}, cost: { 'claude-opus-4-8': 1 } } },
    { event: 'token_usage_snapshot', source: 'driver', cycle: 57, ts: '2026-08-03T12:00:00.000Z', attrs: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheCreationTokens: 300, totalTokens: 6500, cacheHitRate: 5000 / 6300 } },
  ]);
  eq(agg66.itemCallCounts[57], { X: 3, Y: 1 }, 'KI-E66: per-item call counts aggregate keyed by cycle');
  eq(agg66.tokenUsageSnapshots.length, 1, 'KI-E66: token_usage_snapshot events collect into tokenUsageSnapshots');
  const md66 = T.renderTelemetryReport(agg66, { generatedAt: 'T', file: 'f' });
  ok(md66.includes('## Session token usage & cache hit rate (KI-E66, cycle-scoped, Prometheus-derived)'), 'KI-E66: the cache-hit-rate section header renders');
  ok(md66.includes('| 57 | 1,000 | 200 | 5,000 | 300 | 6,500 | 79% |'), 'KI-E66: the cycle-level token/cache-hit-rate row renders with the correct rounded percentage');
  ok(md66.includes('## Per-item apportioned tokens (estimate — NOT a measurement, KI-E66)'), 'KI-E66: the per-item apportionment section header renders, explicitly labeled as an estimate');
  ok(md66.includes('| 57 | X | 750 |') && md66.includes('| 57 | Y | 250 |'), 'KI-E66: per-item apportioned tokens render proportional to real call-count share (X:3 calls=750, Y:1 call=250, of the real 1000-token cycle total)');
  // No snapshot gathered (the common case on a host whose OTEL exporter env is unconfigured, or
  // Prometheus unreachable/empty) -> an honest NOT-gathered message, never a silent 0/blank table.
  const aggNone66 = T.aggregateEvents([{ event: 'usage', source: 'driver', cycle: 1, attrs: { outputTokens: 100, file: 'r1.json' } }]);
  const mdNone66 = T.renderTelemetryReport(aggNone66, { generatedAt: 'T', file: 'f' });
  ok(mdNone66.includes('_NOT gathered'), 'KI-E66: with no token_usage_snapshot events, the report says NOT gathered rather than rendering an empty/misleading table');
}

// KI-E67 (2026-08-03): narrative/verdict contradiction detector — found live while auditing
// ITEM-22, whose non-canonical VERIFICATION-REPORT.md read as confidently "✅ COMPLETE... Ready
// for merge" while the deterministic fold verdict was FAILED (406 new suite failures).
{
  const N = await import('./narrative-check.mjs');
  const doneText = '# X Verification Report\n\n**Status**: ✅ COMPLETE — All acceptance criteria met.\n\n**Conclusion**\n\nReady for merge. No additional changes required.\n';
  eq(N.detectNarrativeVerdictContradiction('CLOSED', { 'VERIFICATION-REPORT.md': doneText }), [], 'KI-E67: a CLOSED item with upbeat prose is NOT a contradiction — it is an accurate description, never flagged');
  eq(N.detectNarrativeVerdictContradiction('FAILED', {}), [], 'KI-E67: no artifact text at all -> no hit');
  eq(N.detectNarrativeVerdictContradiction('FAILED', { 'plan.md': 'Approach: read the ledger entry and add the tag.' }), [], 'KI-E67: ordinary neutral prose on a FAILED item -> no false positive');
  const failHits = N.detectNarrativeVerdictContradiction('FAILED', { 'VERIFICATION-REPORT.md': doneText, 'plan.md': 'no marker text here' });
  eq(failHits.map((h) => h.file), ['VERIFICATION-REPORT.md'], 'KI-E67: the live ITEM-22 shape (FAILED + a confidently-done non-canonical file) is detected, and only the offending file is named');
  ok(failHits[0].marker.length > 0, 'KI-E67: the hit carries the actual matched phrase, not just a boolean');
  ok(N.detectNarrativeVerdictContradiction('ESCALATED', { 'x.md': 'Status: fully complete' }).length === 1, 'KI-E67: ESCALATED is treated the same as FAILED (both are "not actually done")');
  // Every individual strong marker phrase is independently covered, so the marker list can't
  // silently regress to only matching the ONE phrase used in the composite doneText fixture above.
  for (const phrase of ['✅ complete', 'all acceptance criteria met', 'ready for merge', 'no additional changes required', 'zero leftovers', 'Status: fully complete']) {
    ok(N.detectNarrativeVerdictContradiction('FAILED', { 'f.md': phrase }).length === 1, `KI-E67: marker phrase "${phrase}" is independently detected`);
  }
  // Fold wiring: the driver actually calls the detector inside cmdFold, scanning every .md in the
  // item's directory (not just the canonical artifact list) for a FAILED/ESCALATED result.
  const drvText67 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(drvText67.includes('detectNarrativeVerdictContradiction') && drvText67.includes('NARRATIVE-VERDICT-MISMATCH'), 'KI-E67: cmdFold wires the detector and prints the WARN with the KI tag');
  ok(/toState !== 'FAILED' && r\.toState !== 'ESCALATED'\) continue/.test(drvText67), 'KI-E67: the fold wiring is gated to FAILED/ESCALATED results only, matching the pure function\'s own contract');
}

// KI-E74C (2026-08-07): the MIRROR of KI-E67 — a CLOSED verdict contradicted by an artifact that
// itself admits something is NOT resolved. Found live on ITEM-H1: the runner's own verify.json
// admitted a prior review round's 5 findings were unaddressed; all 8 gates approved anyway.
{
  const N74 = await import('./narrative-check.mjs');
  const itemH1Text = "Re-confirmation verify of the round-1 re-fix. NOTE: review-edgecase.md was re-scanned AFTER that fix (round 2) and returned CHANGES_REQUIRED again. No fixer round has touched the worktree since. Build+targeted-test green here does NOT mean round 2's findings are resolved — they are not, and are unaddressed in this worktree as of this pass.";
  eq(N74.detectUnresolvedCaveatOnClose('CLOSED', { 'verify.json': itemH1Text }), [{ file: 'verify.json', marker: "does NOT mean round 2's findings are resolved — they are not, and are unaddressed" }], 'KI-E74C: the live ITEM-H1 verify.json admission is detected on a CLOSED result');
  eq(N74.detectUnresolvedCaveatOnClose('FAILED', { 'verify.json': itemH1Text }), [], 'KI-E74C: the SAME admission on a FAILED result is not flagged — an accurate description, not a contradiction (mirrors KI-E67\'s own CLOSED exemption)');
  eq(N74.detectUnresolvedCaveatOnClose('CLOSED', {}), [], 'KI-E74C: no artifact text at all -> no hit');
  eq(N74.detectUnresolvedCaveatOnClose('CLOSED', { 'plan.md': 'Approach: read the ledger entry and add the tag.' }), [], 'KI-E74C: ordinary neutral prose on a CLOSED item -> no false positive');
  eq(N74.detectUnresolvedCaveatOnClose('CLOSED', { 'gate-qa.md': 'one LOW finding about comment style remains unresolved but is accepted as non-blocking per PO sign-off' }), [], 'KI-E74C: a legitimately-accepted minor deferral does not false-positive');
  // Every individual marker phrase is independently covered.
  const markerFixtures = [
    'this pass does not mean the bug is addressed at all here',
    'the reported findings here remain unaddressed for now',
    'this leaves the item unaddressed in the worktree for later review',
    'the ticket looks resolved — they are not actually done though',
  ];
  for (const phrase of markerFixtures) {
    ok(N74.detectUnresolvedCaveatOnClose('CLOSED', { 'f.md': phrase }).length === 1, `KI-E74C: marker phrase "${phrase}" is independently detected`);
  }
  // Fold wiring: the driver calls the detector inside cmdFold for CLOSED results, scanning .md
  // files PLUS verify.json (the proven real source of this admission — broader than the KI-E67
  // loop's .md-only scan, deliberately, since that check already ships and works).
  const drvText74c = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(drvText74c.includes('detectUnresolvedCaveatOnClose') && drvText74c.includes('UNRESOLVED-CAVEAT-ON-CLOSE'), 'KI-E74C: cmdFold wires the mirror detector and prints the WARN with the KI tag');
  ok(/toState !== 'CLOSED'\) continue/.test(drvText74c), 'KI-E74C: the fold wiring is gated to CLOSED results only, matching the pure function\'s own contract');
  ok(/f\.endsWith\('\.md'\) && f !== 'verify\.json'\) continue/.test(drvText74c), 'KI-E74C: the scan includes verify.json alongside .md files (the proven real source of the admission)');
}

// KI-E68 (2026-08-03): cmdGroup's concurrency default was a bare hardcoded 2, disconnected from
// config/factory.config.json's documented concurrency.{throttled,normal,max,default} tiers (never
// read by any code path). No pure-function harness exists for cmdGroup itself (it is a CLI command
// wired to filesystem/ledger state), so — matching the existing KI-E14/KI-E29 cmdGroup source-pin
// style — this is a source-text pin confirming the fix, not a runtime-behavior test.
{
  const drvText68 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(drvText68.includes('(cfg.concurrency && cfg.concurrency.default) || 6'), 'KI-E68: cmdGroup\'s concurrency default reads cfg.concurrency.default (config-driven) instead of a bare disconnected literal, with a 6 fallback');
  ok(!/concurrency: flags\.conc \? parseInt\(flags\.conc, 10\) : 2,/.test(drvText68), 'KI-E68: the old disconnected hardcoded-2 default is gone from cmdGroup');
  const cfg68 = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'config', 'factory.config.json'), 'utf8'));
  eq(cfg68.concurrency.default, 6, 'KI-E68: config.concurrency.default raised 3->6 (== normal tier) so the documented default and the code-read default agree');
}

// KI-E69 (2026-08-03): cross-session prior-attempt reuse. Witnessed live: a 12-item stuck batch
// (killed run, no checkpoints) included items with 50/42/32 real changed files already complete in
// their worktrees — the sanctioned relaunch ("relaunch the same run-script verbatim") would have
// re-run plan/test-author/fixer from scratch for all of them. Scope is deliberately narrow: verify
// is NEVER reused (a real on-disk verify.json was found to carry rich {result,errors,...} objects
// where runItem() reads a plain pass/fail string — reusing it would have silently misclassified a
// passing build) and nothing from the editorial pass onward changes at all.
{
  const P = await import('./prior-attempt.mjs');
  const pdir = mkdtempSync(join(tmpdir(), 'factory-priorattempt-'));
  const beforeWrite = Date.now() - 5000; // a claim timestamp strictly BEFORE any fixture file below is written

  // Empty dir -> nothing to reuse, never throws.
  eq(P.loadPriorAttempt(join(pdir, 'nope'), beforeWrite), { plan: null, test: null, fix: null }, 'KI-E69: a nonexistent item dir -> all-null, no throw');

  // test.json alone (fixer never got that far) -> test reused, fix stays null, plan stays null
  // (plan.md itself is not on disk, so the safe stand-in is correctly withheld too).
  const d1 = join(pdir, 'd1'); mkdirSync(d1, { recursive: true });
  fsWrite(join(d1, 'test.json'), JSON.stringify({ red: true, testFiles: ['a.cs'] }));
  const pa1 = P.loadPriorAttempt(d1, beforeWrite);
  ok(pa1.test && pa1.test.red === true, 'KI-E69: test.json alone is reused when fresh (mtime after the claim)');
  eq(pa1.fix, null, 'KI-E69: fix stays null when fix.json is absent');
  eq(pa1.plan, null, 'KI-E69: plan stand-in is withheld when plan.md itself is not on disk, even though test.json reused');
  eq(P.priorAttemptStages(pa1), ['test'], 'KI-E69: priorAttemptStages reports exactly the reused stages');

  // plan.md + test.json + fix.json all present and fresh -> all three reused; plan is the safe
  // {recommendScopeStop:false, recommendEscalate:false} stand-in, never a parse of the prose file.
  const d2 = join(pdir, 'd2'); mkdirSync(d2, { recursive: true });
  fsWrite(join(d2, 'plan.md'), '# Plan\nproceed.');
  fsWrite(join(d2, 'test.json'), JSON.stringify({ red: false, verificationOnly: true }));
  fsWrite(join(d2, 'fix.json'), JSON.stringify({ applied: true, scopeStop: false, summary: 'did it' }));
  const pa2 = P.loadPriorAttempt(d2, beforeWrite);
  eq(pa2.plan, { recommendScopeStop: false, recommendEscalate: false }, 'KI-E69: plan reuses the safe stand-in (never a plan.md prose parse) once test.json is ALSO present');
  eq(pa2.test.verificationOnly, true, 'KI-E69: test.json reused verbatim');
  eq(pa2.fix.applied, true, 'KI-E69: fix.json reused verbatim');
  eq(P.priorAttemptStages(pa2), ['plan', 'test', 'fix'], 'KI-E69: all three stages report reused');

  // Stale artifacts (mtime BEFORE the current claim) are a prior cycle's leftovers, never reused —
  // a claim timestamp set strictly AFTER these already-written files simulates exactly that (this
  // item was re-claimed for a NEW attempt since these files were last written).
  const afterWrite = Date.now() + 5000;
  const paStale = P.loadPriorAttempt(d2, afterWrite);
  eq(paStale, { plan: null, test: null, fix: null }, 'KI-E69: artifacts older than the current claim timestamp are never reused (stale prior-cycle guard)');

  // Malformed JSON -> null for that stage, never a throw, never a crash for siblings.
  const d3 = join(pdir, 'd3'); mkdirSync(d3, { recursive: true });
  fsWrite(join(d3, 'test.json'), '{ not valid json');
  fsWrite(join(d3, 'fix.json'), JSON.stringify({ applied: true }));
  const pa3 = P.loadPriorAttempt(d3, beforeWrite);
  eq(pa3.test, null, 'KI-E69: malformed test.json -> null, never a throw');
  ok(pa3.fix && pa3.fix.applied === true, 'KI-E69: a sibling malformed file never poisons an otherwise-valid one');

  // Wiring: factory.js consults item.priorAttempt at exactly the plan/test/fix call sites, never at
  // verify (which must ALWAYS run fresh — the shape-mismatch risk above is exactly why).
  const facText69 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(facText69.includes("(item.priorAttempt && item.priorAttempt.plan) ||"), 'KI-E69: runItem() plan stage consults item.priorAttempt.plan');
  ok(facText69.includes("(item.priorAttempt && item.priorAttempt.test) ||"), 'KI-E69: runItem() test stage consults item.priorAttempt.test');
  ok(facText69.includes("(item.priorAttempt && item.priorAttempt.fix) ||"), 'KI-E69: runItem() fix stage consults item.priorAttempt.fix');
  ok(!facText69.includes('item.priorAttempt.verify') && !facText69.includes('item.priorAttempt && item.priorAttempt.verify'), 'KI-E69: verify is NEVER read from item.priorAttempt — always runs fresh (unsafe on-disk shape)');
  ok(facText69.includes('res.priorAttemptReuse'), 'KI-E69: the result always carries priorAttemptReuse (empty array when nothing was reused) — never silently absent');

  const drvText69 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(drvText69.includes("if (flags.reuse) {") && drvText69.includes('loadPriorAttempt(itemDir'), 'KI-E69: cmdResume gates the regeneration behind an explicit --reuse flag (never a silent default-behavior change)');
  ok(drvText69.includes('priorAttemptReuse: (r.priorAttemptReuse'), 'KI-E69: item_folded telemetry surfaces priorAttemptReuse whenever a relaunch reused a killed run\'s artifacts');
  // Live-caught review fix (same day, cutting the actual cycle-58 recovery): run-args.json is a
  // group-time snapshot that does not see a LATER hand-edit to the emitted run-script (exactly what
  // KI-E68 did — concurrency 2 -> 6 directly in state/run-script.js) or a config fix landed after the
  // original group. A naive regenerate-from-snapshot would have silently UNDONE that fix.
  ok(drvText69.includes('freshConc') && drvText69.includes('runArgs.concurrency = freshConc'), 'KI-E69: --reuse refreshes concurrency from the CURRENT config default rather than blindly replaying the group-time snapshot (review fix — would have silently undone a later hand-edit or config fix, e.g. KI-E68)');
}

// KI-E75 — archaeologist (research phase): a host-opt-in role that establishes validated ground
// truth for a doc-less target BEFORE planning, then writes that ground truth into the host's own
// conventional doc files. Reuses buildDocMap's existing doc-less-target signal (an empty DOC MAP)
// rather than inventing a second "does this repo have docs" detector. Enrichment only — never
// blocks the item.
{
  // Pure gate coverage — lib/archaeology.mjs shouldRunArchaeology, the canonical copy factory.js's
  // routesFor() inlines byte-for-byte (KI-E2).
  ok(shouldRunArchaeology({ policies: { archaeology: true }, fixType: 'critical', docMap: [] }) === true,
    'archaeology: on + non-mechanical + doc-less target -> eligible');
  ok(shouldRunArchaeology({ policies: { archaeology: false }, fixType: 'critical', docMap: [] }) === false,
    'archaeology: host policy OFF -> never eligible regardless of doc coverage');
  ok(shouldRunArchaeology({ policies: { archaeology: true }, fixType: 'mechanical', docMap: [] }) === false,
    'archaeology: mechanical fixType -> not eligible even on a doc-less target (mirrors planner\'s crit gate)');
  ok(shouldRunArchaeology({ policies: { archaeology: true }, fixType: 'critical', docMap: ['doc/data-flows/Svc.md :: § API @L1'] }) === false,
    'archaeology: non-empty DOC MAP (a documented target) -> not eligible');
  ok(shouldRunArchaeology({ policies: { archaeology: true }, fixType: 'critical', docMap: undefined }) === true,
    'archaeology: missing docMap treated the same as an empty one (doc-less)');
  ok(shouldRunArchaeology({ policies: null, fixType: 'critical', docMap: [] }) === false,
    'archaeology: missing policies object -> safe-default false, never throws');

  // Routing: buildFactoryRouting (routing-drift.mjs RT_MAP) picks up the new route from
  // config/model-routing.json — proves BOTH files were updated consistently in one check. The
  // existing KI-B1 drift block (above) re-checks factory.js's inline RT.archaeologist against it.
  const bfr75 = buildFactoryRouting(routing);
  eq(bfr75.RT.archaeologist, { model: 'claude-sonnet-5', effort: 'high' }, 'archaeology: model-routing.json archaeologist route (sonnet/high — deliberately off the budget-gated fable-5 tier, KI-E75)');

  // agents/archaeologist.md — the evidence-only contract exists and states its core rule.
  const archBrief = readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'archaeologist.md'), 'utf8');
  ok(archBrief.includes('Never assume. Validate.'), 'archaeology: agents/archaeologist.md states the core no-assumptions rule');
  ok(archBrief.includes('archaeology.md'), 'archaeology: brief instructs writing the state/items/<id>/archaeology.md evidence artifact');
  ok(/CONTEXT\.md/.test(archBrief) && /data-flows/.test(archBrief), 'archaeology: brief names the real doc conventions it should extend (CONTEXT.md / doc/data-flows)');

  // factory.js wiring — schema, routing, gating, phase ordering, prompt threading.
  const facText75 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(facText75.includes('const ARCHAEOLOGY_SCHEMA ='), 'archaeology: ARCHAEOLOGY_SCHEMA defined');
  ok(facText75.includes("archaeologist: { model: 'claude-sonnet-5', effort: 'high' }"), 'archaeology: RT.archaeologist inline entry present (drift-guard source)');
  ok(facText75.includes('const archEligible = archOn && crit && docLess'), 'archaeology: routesFor() computes the 3-condition eligibility gate');
  ok(facText75.includes('archaeologist: archEligible ? RT.archaeologist : null'), 'archaeology: routesFor() returns the gated route');
  ok(facText75.includes("call('archaeologist', R.archaeologist, ARCHAEOLOGY_SCHEMA"), 'archaeology: runItem() invokes the archaeologist role');
  ok(facText75.includes("item.archaeologyFindings = findingsText"), 'archaeology: runItem() threads findings onto item.archaeologyFindings');
  ok(facText75.includes('ARCHAEOLOGY FINDINGS (validated ground truth'), 'archaeology: compose() renders archaeologyFindings into the shared prompt prefix');
  // Never-blocks invariant: the archaeologist call site must NOT early-return FAILED the way
  // test-author/fixer/runner do on a null result — a null/thin result is enrichment loss only.
  const archCallBlock = facText75.slice(facText75.indexOf("phase('Research')"), facText75.indexOf("phase('Plan')"));
  ok(!/finish\('FAILED'/.test(archCallBlock), 'archaeology: the Research phase never FAILs the item — enrichment only, exactly like a missing item.verifyNote never blocked anything before it');
  // Ordering: Research runs strictly before Plan, so a validated-ground-truth item's findings are
  // already on `item` by the time planner's own call() composes its prompt.
  ok(facText75.indexOf("phase('Research')") > 0 && facText75.indexOf("phase('Research')") < facText75.indexOf("phase('Plan')"), 'archaeology: Research phase precedes Plan phase in runItem()');

  // Downstream consistency: runner's fix-manifest cross-check knows archaeology-written docs are
  // expected tracked changes, not debris (mirrors how it already expects the test file(s)).
  const runnerBrief = readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'runner.md'), 'utf8');
  ok(runnerBrief.includes('KI-E75'), 'archaeology: runner.md fix-manifest cross-check accounts for archaeology-written docs');

  // lib/policy.mjs — the archaeology policy loads/renders/merges through the SAME generic machinery
  // as the other two (already proven by the updated policy-seam block above); pin the DEFAULTS shape
  // directly here too so a future DEFAULTS edit that drops the key is caught at this file as well.
  eq(loadPolicies(mkdtempSync(join(tmpdir(), 'pol75-'))).archaeology, false, 'archaeology: loadPolicies default is OFF on a host with no config at all');
}

console.log(`\nself-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
