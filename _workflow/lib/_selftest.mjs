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
import { dissentersFrom, roleForGateKey, recoveryTransitions, recoveryFoldSkeleton, priorCycleOf, missingStageFrom } from './recover.mjs';
import { extractHeadings, buildDocMap, readRoleBriefs, readRepoProfiles, PROFILE_CAP } from './promptpack.mjs';
import { loadPolicies, renderPolicies, POLICY_TEXT } from './policy.mjs'; // PR#9 review — host-policy seam
import { githubIssueToItem, markdownChecklistToItems, extractSection, severityFromLabels, themeFromLabels, ingestReport, enforceIngestTier, countCheckedBoxes } from './ingest.mjs';
import { costTelemetryReady, shimAvailable, dotnetAvailable } from './preflight.mjs';
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
eq(resolve(routing, 'fixer.mechanical').model, 'claude-sonnet-4-6', 'mechanical fixer -> sonnet-4-6 (KI-E92 2026-08-28 re-adoption)');
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

// Ported from a host-mount session (2026-08-29) — removeWorktree (worktree.mjs) drops the worktree
// directory + git's worktree-admin entry but leaves the `factory/<id>` branch ref standing at its
// stale creation commit. Origin evidence: refreshing drifted worktrees required a MANUAL
// `git branch -D factory/<id>` after `worktree-remove` before a subsequent `addWorktree` call actually
// started fresh — because addWorktree's OWN fallback path (`git worktree add -b` failing "already
// exists" -> falls back to plain `git worktree add <path> <existing-branch>`) silently attaches the
// new worktree to the OLD branch tip instead of cutting a new one from current HEAD.
// `pruneStaleBranch` closes the gap: called right after `removeWorktree`, gated on `git merge-base
// --is-ancestor <branch> HEAD` — per the file's own header invariant (the factory NEVER commits), a
// factory/<id> branch has, by construction, zero commits beyond its base, so one that IS an ancestor
// of HEAD carries no unique value and is safe to discard; one that is NOT (an unexpected commit landed
// on it, which the hard rule forbids but this function must not blindly trust) is left standing for
// manual review, never silently discarded.
try {
  const wtdir = mkdtempSync(join(tmpdir(), 'factory-prunebranch-'));
  const wg = (...a) => execFileSync('git', ['-C', wtdir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  wg('init', '-q');
  fsWrite(join(wtdir, 'f.txt'), 'a\n');
  wg('add', 'f.txt'); wg('commit', '-qm', 'base');
  const defaultBranch = wg('symbolic-ref', '--short', 'HEAD').toString().trim(); // host-agnostic — init.defaultBranch varies (master/main)
  wg('branch', 'factory/safe'); // no unique commits beyond base — safe to delete
  wg('branch', 'factory/unsafe');
  wg('checkout', '-q', 'factory/unsafe');
  fsWrite(join(wtdir, 'g.txt'), 'b\n');
  wg('add', 'g.txt'); wg('commit', '-qm', 'unexpected extra commit — the hard rule forbids this but the function must not trust that');
  wg('checkout', '-q', defaultBranch);
  const { pruneStaleBranch: PSB } = await import('./worktree.mjs');
  const safe = PSB('factory/safe', wtdir);
  eq(safe, { deleted: true, branch: 'factory/safe' }, 'KI-E100: a branch with zero commits beyond HEAD is deleted');
  let branchesAfterSafeDelete = wg('branch').toString();
  ok(!branchesAfterSafeDelete.includes('factory/safe'), 'KI-E100: the deleted branch no longer appears in `git branch`');
  const unsafe = PSB('factory/unsafe', wtdir);
  eq(unsafe.deleted, false, 'KI-E100: a branch with a commit NOT reachable from HEAD is left standing, never silently discarded');
  ok(/not reachable from HEAD/.test(unsafe.reason), 'KI-E100: the left-standing reason names why, for a human to review');
  ok(wg('branch').toString().includes('factory/unsafe'), 'KI-E100: the unsafe branch still exists after the declined delete');
  eq(PSB(null, wtdir), { deleted: false, reason: 'no-branch-given' }, 'KI-E100: no branch given -> short-circuits, never touches git');
  const missing = PSB('factory/does-not-exist', wtdir);
  eq(missing.deleted, false, 'KI-E100: a nonexistent branch is never mistaken for a deletable one');
  ok(/does not exist/.test(missing.reason), 'KI-E100: the nonexistent-branch reason is distinguishable from the has-unique-commits reason (not conflated)');
  // refs/heads/ prefix form is accepted identically to the bare name (both are real call shapes:
  // listWorktrees() porcelain output returns the refs/heads/ form; the ledger's r.branch is bare).
  wg('branch', 'factory/prefixtest');
  eq(PSB('refs/heads/factory/prefixtest', wtdir), { deleted: true, branch: 'factory/prefixtest' }, 'KI-E100: a refs/heads/-prefixed branch name is stripped and handled identically to the bare form');
} catch (e) {
  console.log('  SKIP pruneStaleBranch git-integration test (git unavailable: ' + (e && e.message) + ')');
}
{
  // Driver wiring: both removeWorktree call sites (the CLI worktree-remove subcommand and gc's
  // CLOSED-item sweep) now call pruneStaleBranch right after removing the worktree — closing the
  // staleness trap at its source instead of relying on a human to notice and hand-delete the branch.
  const drvTextE100 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(/import \{ addWorktree, removeWorktree, pruneStaleBranch,/.test(drvTextE100), 'KI-E100: driver.mjs imports pruneStaleBranch alongside removeWorktree');
  ok(/sub === 'worktree-remove'[\s\S]{0,400}listWorktrees\(\)\.find/.test(drvTextE100), 'KI-E100: the worktree-remove subcommand resolves the attached branch via listWorktrees() BEFORE removing (branch info is gone once the worktree is gone)');
  ok(/sub === 'worktree-remove'[\s\S]{0,700}pruneStaleBranch\(branch, REPO_ROOT\)/.test(drvTextE100), 'KI-E100: the worktree-remove subcommand calls pruneStaleBranch after removeWorktree');
  ok(/if \(r\.branch\) \{[\s\S]{0,200}pruneStaleBranch\(r\.branch, REPO_ROOT\)/.test(drvTextE100), 'KI-E100: cmdGc calls pruneStaleBranch using the ledger\'s own r.branch for every CLOSED item it sweeps');
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

// Ported from a host-mount session (2026-08-29) — REALINFRA_SIGNAL's bare `concurren` catch-all
// matched plain-English uses of "concurrent" with zero relation to a real concurrency defect, forcing
// needsRealInfra:true (an unnecessary Testcontainers demand). Origin evidence: 5 live false-positive
// incidents, fixed by narrowing the catch-all with noun/preposition exclusions plus a preceding
// are/is lookbehind and a close-paren exclusion, WITHOUT losing any of 11 confirmed-genuine
// concurrency-defect matches (several of which depend ENTIRELY on this regex since their own graph
// entry declares realInfra:false). Fixture text below is quoted VERBATIM from the origin session's
// live incidents — never paraphrased, so the pin tracks the actual incident shape, not a
// reconstruction of it; none of it names an origin-specific item id or service.
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  const sigMatch = src.match(/const REALINFRA_SIGNAL = (\/[^;\n]+\/)/);
  ok(!!sigMatch, 'KI-E97: factory.js defines REALINFRA_SIGNAL as a single-line regex literal');
  const re = new RegExp(sigMatch[1].slice(1, sigMatch[1].lastIndexOf('/')));

  // Confirmed false positives (must NOT match) — verbatim origin-incident phrasing.
  eq(re.test('ystream on every download and scan path; ~10 concurrent 100mb downloads cause oom | s3objectstore.cs'), false,
    'KI-E97: "concurrent downloads" (an OOM/volume concern) is not a concurrency defect');
  eq(re.test('guards in the same controller. do not group concurrently with item-h8 or other-c7a/c7b (sh'), false,
    'KI-E97: a file-lock scheduling note ("concurrently with X"), not a defect description');
  eq(re.test('rface — file-lock will serialize against any concurrent loki work.'), false,
    'KI-E97: "concurrent … work" is scheduling prose, not a defect');
  eq(re.test('ct http calls are observed (or that they are concurrent). | at orderscontroller.cs:275-291 and helpe'), false,
    'KI-E97: "they are concurrent" excluded by the are/is lookbehind');
  eq(re.test('henall with a semaphoreslim cap (e.g. max 10 concurrent). add an input cap (reject or chunk at e.g.'), false,
    'KI-E97 follow-up: a bare throttle-cap aside with no following noun; only the close-paren exclusion (?!\\)) catches this, and it is what made the first-pass fix insufficient on its own');

  // Confirmed genuine (must still match) — includes cases whose OWN graph entry says
  // realInfra:false, so they depend entirely on this regex as the safety net.
  eq(re.test('concurrent cps-webhook redeliveries double-gr'), true, 'KI-E97: a real double-grant race, still caught');
  eq(re.test('riants | auditchaintests.cs adds a concurrent-append-under-advisory-lock test (t'), true, 'KI-E97: concurrent-append test coverage, still caught');
  eq(re.test('ire 200-row batch on a single xmin optimistic-concurrency conflict — breach notifications'), true, 'KI-E97: optimistic-concurrency conflict, still caught');
  eq(re.test('t exceed the cap on any replica. | concurrent test (real redis via testcontainer'), true, 'KI-E97: concurrent-guard test, still caught');
  eq(re.test('no optimistic-concurrency token on any aggregate (order, d'), true, 'KI-E97: optimistic-concurrency token gap, still caught');
  eq(re.test('ips the tick body. a test with two concurrent job invocations confirms only one'), true, 'KI-E97: "two concurrent job invocations" (a genuine leader-election test) stays caught; "job" was deliberately kept OUT of the noun-exclusion list for exactly this case');
  eq(re.test('in exception — the 4 most critical concurrency regressions fail instead of skippi'), true, 'KI-E97: concurrency regression tests, still caught');
  eq(re.test('avechangesasync can throw a second concurrencyconflictexception, stranding processedevent in proce'), true, 'KI-E97: realInfra:false in the graph — depends entirely on the concurrencyexception alternative');
  eq(re.test('k.savechangesasync missing dbupdateconcurrencyexception -> concurrencyexception mapping —'), true, 'KI-E97: realInfra:false in the graph — depends entirely on the concurrencyexception alternative');
  eq(re.test('ersisted record will throw dbupdateconcurrencyexception on the next savechanges - the iden'), true, 'KI-E97: realInfra:false in the graph — depends entirely on the concurrencyexception alternative');
  eq(re.test("al same-month burst traffic | when advisory lock acquisition returns 'already held'"), true, 'KI-E97: realInfra:false in the graph — depends entirely on the advisory-lock alternative');
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
  // KI-E101: the STEP branch actually EXECUTES here (the planner stub now returns steps[]), not just
  // pins as source text — this is the KI-L43 reason exec-smoke exists: a TDZ/reference/shape crash in
  // a newly-added branch is invisible to `node --check` and to every source-text assertion.
  ok(calls.some((c) => c.label === 'SMOKE-CODE:plan-commitment-probe'), 'KI-E101 exec-smoke: STEP mode dispatches the probe on a planned code lane (the stub approach carries NO commitment language, so PROSE mode alone would never have fired)');
  ok(calls.some((c) => c.label === 'SMOKE-DISPUTE:plan-commitment-probe'), 'KI-E101 exec-smoke: STEP mode dispatches on the dispute lane too');
  ok(!calls.some((c) => c.label === 'SMOKE-VONLY:plan-commitment-probe'), 'KI-E101 exec-smoke: the verification-only lane still SKIPS the plan scan (no fix diff to probe by design)');
  ok(by['SMOKE-CODE'] && by['SMOKE-CODE'].gates && by['SMOKE-CODE'].gates['probe:plan-commitment-scan'] === 'APPROVED', 'KI-E101 exec-smoke: a satisfied STEP-mode probe records APPROVED under the SHARED gate key (no orphaned second key)');
  ok(by['SMOKE-CODE'].gateDetails['probe:plan-commitment-scan'].headline.includes('[STEP mode]'), 'KI-E101 exec-smoke: the recorded headline stamps STEP mode, so gateDetails says which axis fired');
  ok(by['SMOKE-CODE'].gateDetails['probe:plan-commitment-scan'].headline.includes('plan step'), 'KI-E101 exec-smoke: the headline renders the STEP-mode `axis` noun, not the PROSE-mode one');
  eq(calls.filter((c) => c.label === 'SMOKE-CODE:fixer').length, 1, 'KI-E101 scope bound (behavioural): a clean STEP-mode scan spends exactly ONE fixer call — steps never fan the implementation out per step');
}

// KI-E101 — the STEP-mode FAILURE path, executed end to end. The block above proves a SATISFIED
// scan is recorded and costs nothing extra; this proves the half the feature actually exists for:
// an un-evidenced plan step must fail the item PRE-BAND (cheap), after exactly ONE bounded amend,
// with the step text reaching the operator-visible note. Modelled on the budget-stop lane below —
// a second execSmoke run with a targeted agentOverride rather than new fixtures.
{
  const src = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  const gapStep = 'Update the data-flow doc for the endpoint';
  const { result, calls } = await execSmoke(src, smokeBatch(), {
    agentOverride: (prompt, opts) => {
      // Same label covers the probe AND its re-probe, so the gap survives the bounded amend —
      // the item must then fail rather than loop for a second amend.
      if ((opts && opts.label) === 'SMOKE-CODE:plan-commitment-probe') return { honored: false, gaps: [{ commitment: gapStep, why: 'no hunk anywhere in the diff touches the data-flow doc' }] };
      return undefined;
    },
  });
  const byE101 = Object.fromEntries((result.results || []).map((r) => [r.id, r]));
  const code101 = byE101['SMOKE-CODE'];
  ok(!(result.results || []).some((r) => String(r.note || '').startsWith('runItem threw')), 'KI-E101 fail-path: no runItem crash on any lane');
  eq(code101 && code101.toState, 'FAILED', 'KI-E101 fail-path: an un-evidenced plan step FAILS the item');
  ok(String(code101.note || '').includes('KI-E101 STEP mode'), 'KI-E101 fail-path: the note names STEP mode, so the operator knows which axis rejected it');
  ok(String(code101.note || '').includes(gapStep), 'KI-E101 fail-path: the un-evidenced step text itself reaches the note (feedback.md gets the actionable detail, not just a code)');
  ok(String(code101.note || '').includes('no gate band was spent'), 'KI-E101 fail-path: the note states the fail was pre-band — the cost claim the whole probe exists for');
  eq(code101.gates['probe:plan-commitment-scan'], 'CHANGES_REQUIRED', 'KI-E101 fail-path: the shared gate key records CHANGES_REQUIRED');
  ok(code101.gateDetails['probe:plan-commitment-scan'].findings.some((f) => f.title.includes('unhonored plan step')), 'KI-E101 fail-path: the gap is rendered as a structured HIGH finding using the STEP-mode axis noun');
  // the two bounds that keep this cheap and non-looping
  eq(calls.filter((c) => c.label === 'SMOKE-CODE:fixer').length, 2, 'KI-E101 fail-path: exactly TWO fixer calls (the main fix + ONE bounded amend) — the amend never loops');
  eq(calls.filter((c) => c.label === 'SMOKE-CODE:plan-commitment-probe').length, 2, 'KI-E101 fail-path: exactly TWO probe calls (initial + ONE re-probe) — the re-probe verdict is final');
  ok(!calls.some((c) => c.label.startsWith('SMOKE-CODE:gate-')), 'KI-E101 fail-path: the item never reached the gate band — this is the entire economic argument for a pre-band probe (a FULL band is ~5 opus gates + refuter + multi-lens reaudit)');
  // sibling lanes are unaffected — one item's probe verdict must never leak across lanes
  eq(byE101['SMOKE-DOC'] && byE101['SMOKE-DOC'].toState, 'CLOSED', 'KI-E101 fail-path: a sibling lane whose own steps ARE evidenced still closes (per-item isolation holds)');
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

// KI-E89 (2026-08-24, ported from a host-mount session) — main-check's per-item snapshot loop
// (incl. its own KI-E82 --all widening) can only ever check a path that is part of some CHECKED
// item's claim-time files[] — a brand-new leaked path no item ever declared has no snapshot to diff
// against. unclaimedMainDrift (lib/mainguard.mjs) closes that gap: given raw main-tree dirt
// (dirtyMainPaths), the factory's own mount prefix, and the union of every path any CHECKED item has
// ever claimed, it returns whatever dirt remains unexplained.
{
  const { unclaimedMainDrift } = await import('./mainguard.mjs');
  const { mkdtempSync: mkF, writeFileSync: wfF, mkdirSync: mdF, rmSync: rmF } = await import('node:fs');
  const { tmpdir: tdF } = await import('node:os');
  const { join: jF } = await import('node:path');
  const { execFileSync: exF } = await import('node:child_process');
  // pure predicate first (no git needed)
  const dirtyF = { paths: ['Svc/src/Leak.cs', '_bmad-output/ai-factory/state/ledger.json'], dirs: ['Svc/tests/Leaked/'] };
  eq(unclaimedMainDrift(dirtyF, '_bmad-output/ai-factory', new Set()).sort().join(','), 'Svc/src/Leak.cs,Svc/tests/Leaked/', 'KI-E89: an unclaimed outside-mount file AND an unclaimed outside-mount dir both surface; the mount bookkeeping file never does');
  eq(unclaimedMainDrift(dirtyF, '_bmad-output/ai-factory', new Set(['Svc/src/Leak.cs'])).join(','), 'Svc/tests/Leaked/', 'KI-E89: a claimed outside-mount file is excluded (some item DOES have a snapshot to check it against) — only the still-unclaimed dir remains');
  eq(unclaimedMainDrift({ paths: ['_bmad-output/ai-factory/reports/burndown.md'], dirs: [] }, '_bmad-output/ai-factory', new Set()).length, 0, 'KI-E89: mount-internal dirt (driver bookkeeping) is ALWAYS excluded regardless of claim status');
  eq(unclaimedMainDrift({ paths: ['_bmad-output/ai-factory'], dirs: [] }, '_bmad-output/ai-factory', new Set()).length, 0, 'KI-E89: exact-equal mount path (no trailing slash) is excluded, not just prefix matches');
  eq(unclaimedMainDrift({ paths: [], dirs: [] }, '_bmad-output/ai-factory', new Set()).length, 0, 'KI-E89: nothing dirty -> nothing unclaimed');
  eq(unclaimedMainDrift(null, '_bmad-output/ai-factory', null).length, 0, 'KI-E89: null dirty/claimedPaths never throws, resolves to empty');
  // Fix (multi-lens review, 2026-08-25, ported): the `dirs` branch used to ignore claimedPaths
  // entirely (only `underMount` gated it) — a directory an item legitimately declared in its own
  // files[] (e.g. a new untracked test-project subfolder, which git reports at the DIRECTORY level
  // per its own shallowest-untracked-boundary convention — see the live-repo proof below) was
  // permanently reported as unclaimed, contradicting this function's own header comment.
  eq(unclaimedMainDrift({ paths: [], dirs: ['Svc/NewFeature/'] }, '_bmad-output/ai-factory', new Set(['Svc/NewFeature/File.cs'])).length, 0, 'KI-E89 fix: a dirty untracked DIRECTORY is excluded when a claimed FILE lives inside it — the dirs branch now consults claimedPaths, mirroring filesOverlapDirty\'s reversed-direction check');
  eq(unclaimedMainDrift({ paths: [], dirs: ['Svc/NewFeature/'] }, '_bmad-output/ai-factory', new Set(['Svc/Unrelated/Other.cs'])).join(','), 'Svc/NewFeature/', 'KI-E89 fix: a claimed path that does NOT live under the dirty dir still leaves that dir correctly reported as unclaimed (the fix does not over-exclude)');
  // live-repo proof: a mount dir with its own dirty bookkeeping, an outside-mount CLAIMED modified
  // file, and an outside-mount UNCLAIMED new dir
  const rootF = mkF(jF(tdF(), 'unclaimedmain-'));
  exF('git', ['-C', rootF, 'init', '-q']);
  mdF(jF(rootF, '_bmad-output', 'ai-factory', 'state'), { recursive: true });
  wfF(jF(rootF, '_bmad-output', 'ai-factory', 'state', 'ledger.json'), '{}');
  mdF(jF(rootF, 'Svc', 'Tests'), { recursive: true }); // the outer test-project dir already exists and is tracked
  wfF(jF(rootF, 'Svc', 'Tests', 'Existing.cs'), 'pre-existing tracked test file');
  wfF(jF(rootF, 'Svc', 'tracked.cs'), 'original');
  exF('git', ['-C', rootF, 'add', '.']);
  exF('git', ['-C', rootF, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x', '--no-gpg-sign', '--no-verify']);
  wfF(jF(rootF, '_bmad-output', 'ai-factory', 'state', 'ledger.json'), '{"cycle":72}'); // driver's own legit churn
  wfF(jF(rootF, 'Svc', 'tracked.cs'), 'CLAIMED CHANGE'); // an item's own approved delivery
  mdF(jF(rootF, 'Svc', 'Tests', 'Helpers'), { recursive: true }); // the only genuinely NEW, untracked leaf
  wfF(jF(rootF, 'Svc', 'Tests', 'Helpers', 'Skip.cs'), 'leaked'); // nobody claimed this
  const { dirtyMainPaths: dmpF } = await import('./mainguard.mjs');
  const dirtyLiveF = dmpF(rootF);
  const unclaimedLiveF = unclaimedMainDrift(dirtyLiveF, '_bmad-output/ai-factory', new Set(['Svc/tracked.cs']));
  eq(unclaimedLiveF.join(','), 'Svc/Tests/Helpers/', 'KI-E89 live repro: the claimed tracked-file edit and the mount\'s own bookkeeping churn both stay silent; only the never-claimed leaked directory surfaces');
  rmF(rootF, { recursive: true, force: true });
  // Fix (multi-lens review, 2026-08-25, ported): dirtyMainPaths stripped only the OUTER quotes git
  // wraps around a path containing a quote/backslash/non-ASCII byte, leaving the C-style \NNN octal
  // escapes literally in the string — verified live against real git output before writing the fix.
  // KI-E102: `"` and `\` are RESERVED characters in a Win32 filename — `weird"quote.cs` throws
  // ENOENT at writeFileSync, and `back\slash.cs` would silently become a `back/` subdirectory
  // instead of a one-file name. Both were written UNCONDITIONALLY, so on Windows this fixture threw
  // UNCAUGHT and aborted the entire selftest at ~line 987 of 2953: every later assertion (roughly
  // two thirds of the suite, including the KI-E87 plan-commitment block right below) never ran, and
  // `node _workflow/lib/_selftest.mjs` — the command CLAUDE.md mandates be green after EVERY change
  // — could not pass at all on the platform KI-E59 already calls "the very platform the gate was
  // born on". The UTF-8 case is a legal filename everywhere and stays unconditional; the two
  // POSIX-only cases are platform-gated and ANNOUNCE their skip, so silence never reads as "passed"
  // (the KI-E41/E42 announce-never-skip-silently posture, and the same try/catch-SKIP convention the
  // git-unavailable fixtures above already use). POSIX coverage is byte-for-byte unchanged — CI runs
  // ubuntu-latest, so the decode assertions this fixture exists for still gate every push.
  const rootQ = mkF(jF(tdF(), 'quotepath-'));
  exF('git', ['-C', rootQ, 'init', '-q']);
  const posixOnlyNames = process.platform !== 'win32';
  wfF(jF(rootQ, 'café.cs'), 'utf8 filename');
  if (posixOnlyNames) {
    wfF(jF(rootQ, 'weird"quote.cs'), 'embedded quote');
    wfF(jF(rootQ, 'back\\slash.cs'), 'embedded backslash');
  }
  const dirtyQ = dmpF(rootQ);
  ok(dirtyQ.paths.includes('café.cs'), 'KI-E89 fix: a non-ASCII (UTF-8) filename decodes back to its real form, not the raw \\NNN octal escapes git emits');
  if (posixOnlyNames) {
    ok(dirtyQ.paths.includes('weird"quote.cs'), 'KI-E89 fix: an embedded double-quote decodes correctly');
    ok(dirtyQ.paths.includes('back\\slash.cs'), 'KI-E89 fix: an embedded backslash decodes correctly (not doubled, not dropped)');
  } else {
    console.log('  SKIP KI-E89 quote/backslash filename decode (2 asserts — win32 reserves " and \\ in filenames; the café.cs UTF-8 decode case above still ran)');
  }
  rmF(rootQ, { recursive: true, force: true });
  // driver wiring pins
  const dsrc89 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc89.includes("import { snapshotMainFiles, driftAgainstSnapshot, dirtyMainPaths, filesOverlapDirty, splitDriftByStatus, repairDirtyDrift, unclaimedMainDrift } from './lib/mainguard.mjs';"), 'KI-E89: driver.mjs imports unclaimedMainDrift alongside its KI-E14/E61 siblings');
  const cmcBody = dsrc89.slice(dsrc89.indexOf('function cmdMainCheck'), dsrc89.indexOf('function cmdMainCheck') + 9000);
  ok(cmcBody.includes('const claimedPaths = new Set();') && cmcBody.includes('for (const f of Object.keys(snapFiles)) claimedPaths.add(f);'), 'KI-E89: claimedPaths is accumulated from every claimed item\'s snapshot files — the true ceiling of what the unclaimed sweep can see');
  ok(cmcBody.includes('unclaimedMainDrift(dirtyMainPaths(REPO_ROOT), MOUNT_REL, claimedPaths)'), 'KI-E89: cmdMainCheck wires the real REPO_ROOT/MOUNT_REL/claimedPaths into the pure helper — reuses dirtyMainPaths (KI-E14), does not hand-roll a fresh git call');
  ok(cmcBody.includes('MAIN-DRIFT unclaimed (KI-E89)'), 'KI-E89: the new warning is labeled distinctly from KI-E50/E82\'s per-item warning so a reader/grep can tell which mechanism found it');
  // Fix (multi-lens review, 2026-08-25, ported): claimedPaths used to be built ONLY from the
  // requested `ids` — correct under --all (ids WAS already every claimed item) but wrong on a
  // targeted, narrow call (the common case: every item's own mid-band Verify stage runs
  // `main-check <id>` for exactly one id, never --all), where any OTHER already-claimed item's
  // legitimate change sitting in the repo-wide dirtyMainPaths(REPO_ROOT) scan got misreported as
  // unclaimed. Fix: allClaimedIds is computed UNCONDITIONALLY (moved out of the
  // `if (!ids.length || flags?.all)` branch — it now happens BEFORE that branch, which just reuses
  // it for `ids` instead of re-scanning), and the claimedPaths-seeding loop iterates
  // allClaimedIds, not `ids`.
  const allClaimedIdx = cmcBody.indexOf('let allClaimedIds = [];');
  const idsWideningIdx = cmcBody.indexOf('if (!ids.length || flags?.all)');
  const claimedSeedLoopIdx = cmcBody.indexOf('for (const id of allClaimedIds) {');
  const perIdLoopIdx = cmcBody.indexOf('for (const id of ids) {');
  ok(allClaimedIdx >= 0 && idsWideningIdx >= 0 && allClaimedIdx < idsWideningIdx, 'KI-E89 fix: allClaimedIds is computed BEFORE (unconditionally, not inside) the --all/bare widening branch');
  ok(claimedSeedLoopIdx >= 0 && perIdLoopIdx > claimedSeedLoopIdx, 'KI-E89 fix: the claimedPaths-seeding loop iterates allClaimedIds (the FULL inventory) and runs BEFORE the separate per-id drift-recheck loop, which still correctly iterates the narrower, targeted `ids`');
  ok(!cmcBody.slice(claimedSeedLoopIdx, perIdLoopIdx).includes('driftAgainstSnapshot'), 'KI-E89 fix: the claimedPaths-seeding pass over allClaimedIds does ONLY path collection, never a drift re-hash (that stays the per-id loop\'s job, scoped to the requested ids)');
}

// KI-E88 (2026-08-24, ported from a host-mount session, adapted to this repo's cluster-based
// suggest — the origin session's mixed-batch-fallback target does not exist here) — band-mix
// surfacing: a FULL-band item runs the full 5-gate opus panel + planner; LIGHT skips 3 of those 5
// gates and the planner entirely — roughly 4x the gate-panel size. Item COUNT alone gives zero
// signal for what a batch actually costs.
{
  const { bandFor, BAND_FULL_THEMES } = await import('./band.mjs');
  eq(bandFor({ band: 'LIGHT', theme: 'money-correctness' }).toString(), 'LIGHT', 'KI-E88: an explicit item.band=LIGHT wins even over a FULL-themed item');
  eq(bandFor({ band: 'FULL', theme: 'doc-drift' }).toString(), 'FULL', 'KI-E88: an explicit item.band=FULL wins even over a LIGHT-themed item');
  eq(bandFor({ band: 'garbage', theme: 'doc-drift' }).toString(), 'LIGHT', 'KI-E88: a non-LIGHT/FULL item.band value falls through to theme-based classification');
  for (const t of BAND_FULL_THEMES) eq(bandFor({ theme: t }).toString(), 'FULL', 'KI-E88: BAND_FULL_THEMES member "' + t + '" always classifies FULL');
  eq(bandFor({ theme: 'doc-drift' }).toString(), 'LIGHT', 'KI-E88: doc-drift theme classifies LIGHT');
  eq(bandFor({ fixType: 'mechanical' }).toString(), 'LIGHT', 'KI-E88: mechanical fixType classifies LIGHT');
  eq(bandFor({ theme: 'something-else', fixType: 'code' }).toString(), 'LIGHT', 'KI-E88: the unconditional default (anything not FULL-themed) is LIGHT');
  // Fix (multi-lens review, 2026-08-25, ported): no case above combines a BAND_FULL_THEMES theme
  // WITH fixType:'mechanical' in one call — bandFor's own P5 safety comment names exactly this
  // interaction ("a mechanical authz/HMAC/tenant-filter edit is still a security change whose
  // load-bearing reviewer must NOT be dropped"), but nothing pinned it: a future edit swapping the
  // order of the two `if`s would silently downgrade a security-themed mechanical item from FULL to
  // LIGHT with zero test failures.
  for (const t of BAND_FULL_THEMES) eq(bandFor({ theme: t, fixType: 'mechanical' }).toString(), 'FULL', 'KI-E88 fix: BAND_FULL_THEMES theme "' + t + '" COMBINED with fixType:\'mechanical\' still derives FULL — theme dominates fixType (P5), never the reverse');
  // factory.js <-> band.mjs byte-parity: both the function body and the themes array
  const bandSrc = readFileSync(new URL('./band.mjs', import.meta.url), 'utf8');
  const fsrc88 = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const bodyOf = (s, name) => { const m = s.match(new RegExp('function ' + name + '[\\s\\S]*?\\n\\}')); return m ? m[0] : null; };
  ok(bodyOf(bandSrc, 'bandFor') !== null, 'KI-E88: band.mjs carries bandFor');
  eq(bodyOf(bandSrc, 'bandFor'), bodyOf(fsrc88, 'bandFor'), 'KI-E88: band.mjs\'s bandFor is byte-identical to factory.js\'s canonical definition');
  const themesOf = (s) => { const m = s.match(/const BAND_FULL_THEMES = (\[[^\]]*\])/); return m ? m[1] : null; };
  // Fix (multi-lens review, 2026-08-25, ported): this extraction had no null-guard, unlike the
  // sibling bodyOf check above — if BOTH files' array-literal formatting changed identically at
  // once, the regex would return null for both and eq(null, null) would silently pass through a
  // genuine content divergence.
  ok(themesOf(fsrc88) !== null, 'KI-E88 fix: factory.js\'s BAND_FULL_THEMES extraction actually matched something (a null here would let the eq() below silently pass on two unrelated failures)');
  eq(themesOf(bandSrc), themesOf(fsrc88), 'KI-E88: BAND_FULL_THEMES array is byte-identical between band.mjs and factory.js');
  // driver wiring pins — adapted target: this repo's cluster-based cmdSuggest, not a mixed-batch fallback
  const dsrc88 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc88.includes("import { bandFor } from './lib/band.mjs';"), 'KI-E88: driver.mjs imports bandFor');
  const suggestBody = dsrc88.slice(dsrc88.indexOf('function cmdSuggest'), dsrc88.indexOf('function cmdSuggest') + 4000);
  ok(suggestBody.includes('band mix (KI-E88'), 'KI-E88: cmdSuggest prints the whole-pool band-mix line');
  ok(suggestBody.includes('band mix of the') && suggestBody.includes('batchLight'), 'KI-E88: cmdSuggest prints a per-cluster band-mix tally on each cluster header');
}

// KI-E87 (2026-08-24, ported from a host-mount session) — PlanCommitmentScan: the deterministic
// hasPlanCommitmentLanguage pre-filter (skip the haiku probe entirely when the plan makes no
// checkable MUST-style promise), plus the factory.js inline-copy parity pin and pipeline-wiring pins.
{
  const { hasPlanCommitmentLanguage } = await import('./plan-commitment.mjs');
  ok(hasPlanCommitmentLanguage('The fix MUST include the brownfield note in the runbook.'), 'KI-E87: all-caps MUST is detected');
  ok(hasPlanCommitmentLanguage('The diff must include a migration for the new column.'), 'KI-E87: lowercase "must include" is detected');
  ok(hasPlanCommitmentLanguage('This change must also update the data-flow doc.'), 'KI-E87: "must also" is detected');
  ok(hasPlanCommitmentLanguage('The handler is required to validate the tenant claim first.'), 'KI-E87: "is required to" is detected');
  ok(hasPlanCommitmentLanguage('Must-cover checklist (all four): (1) both immutable fields named.'), 'KI-E87: hyphenated title-case "Must-cover" is detected ([\\s-]+ separator, not whitespace-only)');
  ok(!hasPlanCommitmentLanguage('This approach should be straightforward and low-risk.'), 'KI-E87: soft "should" language is NOT a commitment');
  ok(!hasPlanCommitmentLanguage('The fix touches Program.cs and adds a null check.'), 'KI-E87: plain descriptive prose with no commitment language is NOT flagged');
  ok(!hasPlanCommitmentLanguage(''), 'KI-E87: empty text -> false');
  ok(!hasPlanCommitmentLanguage(null), 'KI-E87: null text -> false, never throws');
  ok(!hasPlanCommitmentLanguage(undefined), 'KI-E87: undefined text -> false, never throws');
  ok(!hasPlanCommitmentLanguage('Ship widgets in the mustard package.'), 'KI-E87: "must" as a substring of an unrelated word never false-fires — no separator at all between "must" and the following letters');
  ok(!hasPlanCommitmentLanguage('A mustache is not a commitment.'), 'KI-E87: "mustache" never false-fires — no separator at all between "must" and the following letters');
  // Fix (multi-lens review, 2026-08-25, ported): the "must + verb" pattern used to be a CLOSED
  // 14-word verb allowlist. Independently verified: 13 of 14 realistic plan-commitment sentences
  // using OTHER ordinary verbs were silently missed — every one of these represents a real gap the
  // narrow allowlist left open.
  ok(hasPlanCommitmentLanguage('The fix must verify the tenant claim before returning data.'), 'KI-E87 fix: "must verify" (verb not on the old 14-word allowlist) is now detected');
  ok(hasPlanCommitmentLanguage('The handler must implement retry with backoff.'), 'KI-E87 fix: "must implement" is now detected');
  ok(hasPlanCommitmentLanguage('The consumer must reject duplicate deliveries.'), 'KI-E87 fix: "must reject" is now detected');
  ok(hasPlanCommitmentLanguage('The endpoint must enforce the CustomerOnly policy.'), 'KI-E87 fix: "must enforce" is now detected');
  ok(hasPlanCommitmentLanguage('The diff must set the Status field to Approved.'), 'KI-E87 fix: "must set" is now detected');
  ok(hasPlanCommitmentLanguage('Custom must-have widgets ship in the package.'), 'KI-E87 fix: "must-have" (hyphenated noun-modifier, not a verb-list member) now matches too — the widened net catches the whole "must + word" shape, not just the two-incident allowlist');
  // factory.js inline-copy byte-parity
  const fsrcPC = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const asrcPC = readFileSync(new URL('./plan-commitment.mjs', import.meta.url), 'utf8');
  const bodyOfPC = (s) => { const m = s.match(/function hasPlanCommitmentLanguage[\s\S]*?\n\}/); return m ? m[0] : null; };
  ok(bodyOfPC(fsrcPC) !== null, 'KI-E87: factory.js carries an inlined hasPlanCommitmentLanguage');
  eq(bodyOfPC(fsrcPC), bodyOfPC(asrcPC.replace('export function hasPlanCommitmentLanguage', 'function hasPlanCommitmentLanguage')), 'KI-E87: factory.js inline copy is byte-identical to lib/plan-commitment.mjs');
  // full pipeline wiring pins
  ok(fsrcPC.includes("const PLAN_COMMITMENT_SCHEMA = { type: 'object'") && fsrcPC.includes("required: ['honored']"), 'KI-E87: PLAN_COMMITMENT_SCHEMA is defined in factory.js');
  ok(fsrcPC.includes('let plan = null') && fsrcPC.includes('if (R.planner) {'), 'KI-E87: plan is hoisted to function scope (was block-scoped) so the later probe can read it');
  ok(fsrcPC.includes('if (!verificationOnly && plan) {') && fsrcPC.includes('const proseGated = hasPlanCommitmentLanguage(commitmentText)'), 'KI-E87: the scan is gated on verificationOnly + plan existing AND the deterministic commitment-language pre-filter (KI-E101 moved the prefilter into a named `proseGated` binding; it is still consulted, never dropped)');
  ok(fsrcPC.includes("res.gates['probe:plan-commitment-scan']"), 'KI-E87: the probe writes a distinctly-named gate key');
  ok(fsrcPC.slice(0, 2000).includes('plan-commitment scan'), 'KI-E87: factory.js\'s own meta.description names the plan-commitment scan stage, matching what the code actually runs');
  const planCommitBlock = fsrcPC.slice(fsrcPC.indexOf('4c-bis. PLAN-COMMITMENT SCAN'), fsrcPC.indexOf('4d-pre. COMMENT SCAN'));
  eq((planCommitBlock.match(/finish\('FAILED'/g) || []).length, 1, 'KI-E87: fail-open — exactly one finish(\'FAILED\', ...) call site in the whole plan-commitment block');
  // Fix (multi-lens review, 2026-08-25, ported) — KI-E10 gap this repo specifically lacked: the
  // PLAN-COMMITMENT AMEND prompt explicitly offers the fixer a note-only response, but the re-probe
  // used to fire ONLY on `amend.applied` — a fixer taking that option got failed anyway on the
  // stale pre-amend verdict, never re-evaluated.
  ok(!planCommitBlock.includes('if (amend && amend.applied) {'), 'KI-E87 fix: the re-probe gate is no longer applied-only (the exact pre-fix condition text is gone)');
  ok(planCommitBlock.includes('if (amend && (amend.applied || (amend.note && String(amend.note).trim()))) {'), 'KI-E87 fix: the re-probe now also fires on a genuine note-only response (no code change, non-empty note)');
  ok(planCommitBlock.includes("judge whether this explanation genuinely justifies every ' + axis + ' as already-honored"), 'KI-E87 fix: the re-probe prompt explicitly instructs the probe to critically judge a note-only explanation, not rubber-stamp it (KI-E101 renders the noun through `axis` so both modes carry the instruction)');
  // Same fix, sibling acceptance-scan block (the pre-existing KI-E18 bug this repo also had,
  // inherited when KI-E87 mirrored its pattern) — verified fixed here too, not just KI-E87's copy.
  const acceptBlockStandalone = fsrcPC.slice(fsrcPC.indexOf('ACCEPTANCE-GAP AMEND'), fsrcPC.indexOf('4c-bis. PLAN-COMMITMENT SCAN'));
  ok(!acceptBlockStandalone.includes('if (amend && amend.applied) {'), 'KI-E18 fix (ported): the acceptance-scan re-probe gate is no longer applied-only');
  ok(acceptBlockStandalone.includes('if (amend && (amend.applied || (amend.note && String(amend.note).trim()))) {'), 'KI-E18 fix (ported): the acceptance-scan re-probe now also fires on a genuine note-only response');
}

// KI-E103 (2026-09-02) — RUNTIME-parity gate for the opencode/Copilot binding. Until now the ONLY
// mechanical cross-check between factory.js and the port was SCHEMA parity, whose own documented
// workaround (export the schema, omit it from the SCHEMAS registry, add a `NOT yet ported` comment)
// let three stages ship unported while green. Anything with no schema surface — a guard, a phase
// re-order, a routing CONSTANT — was invisible: KI-E97's REALINFRA_SIGNAL narrowing landed in canon
// only and drifted for days with both suites passing. This block is the forcing gate.
{
  const { extractFactoryRoles, extractPortRoles, namedConstantSource, parityGaps } = await import('./port-parity.mjs');
  // --- pure-function coverage first (the helpers must be trustworthy before the gate leans on them)
  eq([...extractFactoryRoles("await call('planner', X) ... call( 'red-proof-probe' , Y)")].sort(), ['planner', 'red-proof-probe'], 'KI-E103: extractFactoryRoles finds role literals incl. whitespace-padded call sites');
  eq([...extractFactoryRoles('call(x.role, R, S)')], [], 'KI-E103: a dynamically-constructed role is deliberately NOT extracted (both sides build gates/review-flows the same dynamic way from shared tables, so there is no literal to drift)');
  eq([...extractPortRoles("{ role: 'fixer' } { role: 'gate-' + g } { role: 'gate-po' }")].sort(), ['fixer', 'gate-po'], 'KI-E103: extractPortRoles filters the bare `gate-` template fragment but keeps the real gate-po role');
  eq(namedConstantSource('export const A = /x/;', 'A'), '/x/', 'KI-E103: namedConstantSource normalises the `export` prefix and trailing semicolon (style, not semantics)');
  eq(namedConstantSource("const A = ['x']", 'A'), "['x']", 'KI-E103: a semicolon-less canonical-style declaration reads identically');
  eq(namedConstantSource('const B = 1', 'A'), null, 'KI-E103: an absent constant returns null, never a partial read');
  {
    const g = parityGaps(new Set(['a', 'b', 'c', 'd']), new Set(['a']), { mechanical: { b: 'why' }, unported: { c: 'why' } });
    eq(g.undeclared, ['d'], 'KI-E103: a canonical stage that is neither dispatched nor declared is reported — the silent-fork class this gate exists for');
    eq(g.staleDeclared, [], 'KI-E103: nothing stale in the healthy case');
    const g2 = parityGaps(new Set(['a']), new Set(['a']), { mechanical: { a: 'why' }, unported: { gone: 'why' } });
    eq(g2.staleDeclared, ['a'], 'KI-E103: declaring a stage the port actually DISPATCHES is reported — the manifest cannot claim a gap that no longer exists');
    eq(g2.deadDeclared, ['gone'], 'KI-E103: declaring a stage factory.js no longer has is reported — dead manifest entries cannot accumulate');
    eq(parityGaps(new Set(['a']), new Set(), { mechanical: { a: 'x' }, unported: { a: 'y' } }).doubleDeclared, ['a'], 'KI-E103: a stage declared BOTH mechanical and unported is contradictory and reported');
  }
  // --- the live gate against the real files
  const facSrc103 = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const rtSrc103 = readFileSync(new URL('../opencode/runtime.mjs', import.meta.url), 'utf8');
  const routeSrc103 = readFileSync(new URL('../opencode/routing.mjs', import.meta.url), 'utf8');
  const { STAGE_PARITY, SHARED_CONSTANTS } = await import('../opencode/stage-parity.mjs');
  const facRoles103 = extractFactoryRoles(facSrc103);
  const gaps103 = parityGaps(facRoles103, extractPortRoles(rtSrc103), STAGE_PARITY);
  ok(facRoles103.size >= 15, 'KI-E103: the extractor actually finds factory.js\'s agent stages (guard against a silent regex break making this whole gate vacuous) — found ' + facRoles103.size);
  eq(gaps103.undeclared, [], 'KI-E103 PARITY GATE: every factory.js agent stage is either dispatched by the port, or declared MECHANICAL/UNPORTED in _workflow/opencode/stage-parity.mjs. Undeclared stage(s) found — implement it in runtime.mjs planNext/applyPhaseResults, or add it to that manifest with a reason');
  eq(gaps103.staleDeclared, [], 'KI-E103 PARITY GATE: no manifest entry claims a gap for a stage the port now dispatches (delete the stale entry)');
  eq(gaps103.deadDeclared, [], 'KI-E103 PARITY GATE: no manifest entry names a stage factory.js no longer has (delete the dead entry)');
  eq(gaps103.doubleDeclared, [], 'KI-E103 PARITY GATE: no stage is declared both MECHANICAL and UNPORTED');
  // every declared entry carries a REAL reason — an empty/placeholder string would satisfy the key
  // check above while disclosing nothing, which is the failure mode this whole file guards against
  for (const [bucket, entries] of Object.entries(STAGE_PARITY)) {
    for (const [role, why] of Object.entries(entries)) {
      ok(typeof why === 'string' && why.trim().length >= 40, 'KI-E103: stage-parity ' + bucket + '.' + role + ' states a substantive reason, not a placeholder');
    }
  }
  // the three genuinely-absent stages are named explicitly, so closing one is a visible manifest edit
  // KI-E112: the UNPORTED set is now EMPTY — every canonical agent stage is either dispatched by the
  // port or implemented mechanically. This assertion is deliberately an equality against `[]` rather
  // than a "<= N" bound: re-opening a gap must be a visible, arguable edit to this line, not a
  // quietly-growing list. If a future stage genuinely cannot be ported, add it to UNPORTED with a
  // reason AND change this assertion in the same commit.
  eq(Object.keys(STAGE_PARITY.unported), [], 'KI-E112: NO canonical stage is unported — the four KI-E103 disclosed gaps (red-proof KI-E83, plan-commitment/plan-step KI-E87+E101, ledger-anchor KI-E91, rootcause KI-E104) are all closed');
  ok(Object.keys(STAGE_PARITY.mechanical).length >= 5, 'KI-E112: the mechanical set carries the stages implemented deterministically instead of via an agent (runner, marker, comment, red-proof, rootcause)');
  // --- shared-constant byte parity (the KI-E97 drift class)
  for (const name of SHARED_CONSTANTS) {
    const a = namedConstantSource(facSrc103, name);
    const b = namedConstantSource(routeSrc103, name);
    ok(a !== null, 'KI-E103: factory.js declares ' + name + ' on a single line (comparable)');
    ok(b !== null, 'KI-E103: opencode/routing.mjs declares ' + name + ' on a single line (comparable)');
    eq(b, a, 'KI-E103 CONSTANT PARITY: opencode/routing.mjs ' + name + ' is byte-identical to factory.js — this is the exact check that would have caught the KI-E97 REALINFRA_SIGNAL drift the day it happened');
  }
  // regression pin on the specific KI-E97 shapes: the port must now agree with canon on all of them
  {
    const sig = (await import('../opencode/routing.mjs')).REALINFRA_SIGNAL;
    const fresh = () => new RegExp(sig.source, sig.flags);
    ok(!fresh().test('~10 concurrent 100mb downloads cause oom'), 'KI-E103/KI-E97: the port no longer false-fires on a volume/OOM concern (live incident 1)');
    ok(!fresh().test('do not group concurrently with item x'), 'KI-E103/KI-E97: no false fire on file-lock batch-scheduling prose (live incident 2)');
    ok(!fresh().test('file-lock will serialize against any concurrent work'), 'KI-E103/KI-E97: no false fire on scheduling prose (live incident 3)');
    ok(!fresh().test('semaphoreslim cap (e.g. max 10 concurrent).'), 'KI-E103/KI-E97: no false fire on the dangling-adjective throttle-cap shape (live incident 4)');
    ok(fresh().test('enforce the unique-constraint on tenantid'), 'KI-E103/KI-E97: the hyphenated unique-constraint shape now DOES match (the port previously false-negatived it, losing the real-infra floor)');
    ok(fresh().test('handle dbupdateconcurrencyexception on save'), 'KI-E103/KI-E97: concurrencyexception matches (alternative absent from the stale copy)');
    ok(fresh().test('genuine race condition in settlement'), 'KI-E103/KI-E97: a real concurrency defect still matches — the narrowing did not cost a true positive');
  }
}

// KI-E112 (2026-09-02) — the LAST disclosed port gaps, closed. Every canonical agent stage is now
// dispatched or implemented mechanically; UNPORTED is empty (asserted in the KI-E103 block above).
{
  const rt112 = readFileSync(new URL('../opencode/runtime.mjs', import.meta.url), 'utf8');
  const cp112 = readFileSync(new URL('../opencode/compose.mjs', import.meta.url), 'utf8');
  const bt112 = readFileSync(new URL('../opencode/buildtest.mjs', import.meta.url), 'utf8');
  // (a) the three verify-side mechanical guards
  ok(rt112.includes('RED-proof marker (KI-E83)') && rt112.includes('parseRedRaw(decodeTranscript('), 'KI-E112: the port re-reads verify-red-raw.txt from DISK (KI-E83) rather than trusting the test-author self-report until fold time');
  ok(rt112.includes('progress.verificationOnly ? !exitIsZero : exitIsZero'), 'KI-E112: ... including KI-L55\'s INVERTED verificationOnly contract (a pinning test must PASS)');
  ok(rt112.includes('debrisFiles(changed112, itemFiles112)'), 'KI-E112: the debris check (KI-D1) is ported — debrisFiles was previously not even imported');
  ok(rt112.includes("progress.res.gates['mech:rootcause-touch']") && rt112.includes('nonTestChanged(changed112)'), 'KI-E112: the pre-band P9 root-cause touch check (KI-E104) is ported using the SAME lib/verify.mjs derivation the fold applies');
  ok(rt112.includes("gates['mech:rootcause-touch'] = 'SKIPPED'"), 'KI-E112: ... and announces SKIPPED on an unreadable worktree rather than reading as clean');
  // (b) plan-commitment / plan-step trio
  ok(rt112.includes("phase === 'plancommit'") && rt112.includes("phase === 'plancommit_amend'") && rt112.includes("phase === 'plancommit_reprobe'"), 'KI-E112: the plan-commitment trio (probe / ONE bounded amend / one re-probe) is dispatched, mirroring the acceptance trio');
  ok(rt112.includes('normalizePlanSteps(pl.steps, 8)') && rt112.includes('hasPlanCommitmentLanguage(commitmentText)'), 'KI-E112: both KI-E101 STEP mode and KI-E87 PROSE mode are wired — the port previously ACCEPTED plan.steps and never read it');
  ok(rt112.includes('progress.plan = plan;'), 'KI-E112: the plan is RETAINED on progress so the scan has something to check (the canon equivalent of KI-E87 hoisting `plan` to function scope) — without this the whole stage silently no-ops');
  ok(rt112.includes("gates['probe:plan-commitment-scan']"), 'KI-E112: both modes share canon\'s EXISTING gate key — a second key would orphan the telemetry/recover/feedback consumers');
  ok(rt112.includes("(progress._planStepMode ? 'STEP' : 'PROSE') + ' mode]'"), 'KI-E112: the mode is stamped into the headline, as in canon');
  // (c) ledger-anchor
  ok(rt112.includes('function ledgerAnchorNext') && rt112.includes("runBuildTest(progress.ctx.factoryRoot, 'ledger-anchor'"), 'KI-E112: the ledger-anchor mechanical STEP-1 (KI-E91) runs the engine-owned lint');
  ok(rt112.includes('STANDARDS-DIVERGENCE-LEDGER\\.md$'.replace('\\\\', '\\')) || /STANDARDS-DIVERGENCE-LEDGER/.test(rt112), 'KI-E112: ... gated exactly as canon gates it — only when the item declares such a ledger path, so it is a free no-op for hosts without one');
  ok(rt112.includes("phase === 'ledger_anchor_classify'"), 'KI-E112: ... with the STEP-2 classify phase mirroring leftover_classify');
  // (d) the phase chain actually REACHES the new stages (a stage nothing routes to is dead code)
  ok(rt112.includes("progress.phase = 'plancommit'"), 'KI-E112: the acceptance phase advances INTO plancommit — the new stage is reachable, not orphaned');
  ok(rt112.includes('ledgerAnchorNext(progress, itemsDirFor(progress.ctx, progress.id))'), 'KI-E112: leftover_classify advances INTO the ledger-anchor check');
  // (e) the dead-code / dropped-field cleanups
  ok(!/import \{[^}]*\btouchedRootCause\b[^}]*\} from '\.\/buildtest\.mjs'/.test(rt112), 'KI-E112: the dead touchedRootCause import is gone (it was imported and never called)');
  ok(!/import \{[^}]*\bappendRaw\b[^}]*\} from '\.\/buildtest\.mjs'/.test(rt112), 'KI-E112: the dead appendRaw import is gone');
  ok(rt112.includes('progress.item.verifyNote = caveats112.join'), 'KI-E112: the KI-E74B verify-note channel is now POPULATED — compose.mjs had rendered it since KI-E74B with nothing ever setting it (a dead render)');
  ok(cp112.replace(/^\s*\/\/\s?/gm, '').replace(/\s+/g, ' ').includes('no longer a dead render'), 'KI-E112: ... and compose.mjs\'s disclosure comment is corrected rather than left claiming a gap that is closed (comment markers stripped then whitespace-flattened — the phrase straddles a comment line wrap)');
  ok(rt112.includes('if (integ.branch) progress.res.branch = integ.branch;'), 'KI-E112: the integrator\'s branch reaches the folded result — the hand-off the human is meant to commit (KI-E1)');
  ok(rt112.includes('function configuredGateSet()') && !rt112.includes('gateRolesFor(progress.item, progress.band, null)'), 'KI-E112: the host\'s configured gateSet is READ — both call sites passed null, silently ignoring a host that customised it');
  ok(bt112.includes('flakeSuspects'), 'KI-E112: buildtest re-exports flakeSuspects so the port can record the KI-E108 caveat');
}

// KI-E111 (2026-09-02) — writeJsonAtomic survives a transient Windows rename failure. This is the
// engine's ONLY durable-write primitive (ledger, reports, run-args, and the opencode checkpoint), so
// a dropped write here strands real state — live-observed as an intermittent EPERM on the port's
// opencode-progress.json rename, disclosed in KI-E102.
{
  const { writeJsonAtomic, readJson } = await import('./ledger.mjs');
  const wdir = mkdtempSync(join(tmpdir(), 'atomicw-'));
  const target = join(wdir, 'sub', 'state.json');
  // happy path — still creates parent dirs and round-trips
  writeJsonAtomic(target, { a: 1 });
  eq(readJson(target), { a: 1 }, 'KI-E111: writeJsonAtomic still writes + creates parent dirs (no behaviour change on the success path)');
  // overwrite of an EXISTING target is the case that fails on Windows under a sharing violation
  writeJsonAtomic(target, { a: 2, b: 'x' });
  eq(readJson(target), { a: 2, b: 'x' }, 'KI-E111: overwriting an existing target succeeds (the rename-over-existing path the retry protects)');
  // no temp debris survives a successful write — a stray <path>.tmp.<pid> is exactly what KI-E42's
  // relaunch scanner flags as non-canonical, so it would poison the next resume
  const { readdirSync: rd111, rmSync: rm111 } = await import('node:fs');
  eq(rd111(join(wdir, 'sub')).filter((f) => f.includes('.tmp.')), [], 'KI-E111: no .tmp.<pid> debris remains after a successful write');
  // a REAL error still propagates rather than being retried into a silent delay
  let threw111 = false;
  try { writeJsonAtomic(join(wdir, 'sub', 'state.json', 'cannot', 'nest', 'under', 'a', 'file.json'), { x: 1 }); } catch { threw111 = true; }
  ok(threw111, 'KI-E111: a genuine, non-transient failure still THROWS — the retry must never swallow a real error');
  const lsrc111 = readFileSync(new URL('./ledger.mjs', import.meta.url), 'utf8');
  ok(lsrc111.includes("if (process.platform !== 'win32') break;"), 'KI-E111: POSIX takes the pre-existing single-attempt path byte-for-byte — the retry is a win32-only addition, never a behaviour change on the platform CI runs');
  ok(lsrc111.includes("['EPERM', 'EACCES', 'EBUSY'].includes(e && e.code)"), 'KI-E111: only the three transient sharing-violation codes are retried; any other error breaks out immediately');
  ok(lsrc111.includes('rmSync(tmp, { force: true })'), 'KI-E111: a FAILED write cleans up its temp so it cannot become KI-E42 debris for the next resume');
  ok(/Atomics\.wait/.test(lsrc111), 'KI-E111: the backoff is a real synchronous sleep (zero-dep Atomics.wait), not a busy-wait burning CPU inside a retry loop');
  rm111(wdir, { recursive: true, force: true });
}

// KI-E110 (2026-09-02) — projected batch cost, in the same unit KI-E107 measures actuals in.
{
  const { projectedCalls, projectBatch, renderProjection } = await import('./band-cost.mjs');
  const nonMech = { id: 'A', fixType: 'non-trivial' };
  const mech = { id: 'B', fixType: 'mechanical' };
  ok(projectedCalls(nonMech, 'FULL') > projectedCalls(nonMech, 'LIGHT'), 'KI-E110: FULL projects more calls than LIGHT');
  eq(projectedCalls(nonMech, 'FULL') - projectedCalls(nonMech, 'LIGHT'), 7, 'KI-E110: the FULL premium is the 3 extra role gates + 4 extra review/refute/lens calls the band actually dispatches — derived from the pipeline, not invented');
  eq(projectedCalls(nonMech, 'LIGHT') - projectedCalls(mech, 'LIGHT'), 1, 'KI-E110: a mechanical item skips exactly the planner call (factory.js: crit = fixType !== "mechanical")');
  eq(projectedCalls(nonMech, 'nonsense'), projectedCalls(nonMech, 'LIGHT'), 'KI-E110: an unknown band falls back to LIGHT rather than throwing or inventing a tier');
  {
    const p = projectBatch([nonMech, nonMech, mech], (wi) => (wi.fixType === 'mechanical' ? 'LIGHT' : 'FULL'));
    eq(p.byBand.FULL.items, 2, 'KI-E110: the roll-up buckets by band');
    eq(p.byBand.LIGHT.items, 1, 'KI-E110: ... both ways');
    eq(p.total, p.byBand.FULL.calls + p.byBand.LIGHT.calls, 'KI-E110: the total is the sum of the buckets (no double-count)');
  }
  eq(projectBatch([], () => 'FULL').total, 0, 'KI-E110: an empty batch projects zero');
  eq(projectBatch(null, () => 'FULL').total, 0, 'KI-E110: a null batch never throws');
  eq(renderProjection({ total: 0, byBand: {} }), '', 'KI-E110: nothing to project renders nothing — no "~0 calls" noise line');
  {
    const line = renderProjection(projectBatch([nonMech, mech], (wi) => (wi.fixType === 'mechanical' ? 'LIGHT' : 'FULL')));
    ok(line.includes('agent calls'), 'KI-E110: the line names the unit explicitly');
    ok(line.includes('a floor'), 'KI-E110: ... and states it is a FLOOR — retries/amends/adjudication add more, so the estimate under-promises (the safe direction for a planning aid)');
    ok(line.includes('KI-E107'), 'KI-E110: ... and points at the report that measures the same unit, so the projection can actually be calibrated rather than becoming folklore');
  }
  const dsrc110 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc110.includes("import { projectBatch, renderProjection } from './lib/band-cost.mjs'"), 'KI-E110: driver imports the projection');
  ok(dsrc110.includes('renderProjection(projectBatch(ready, bandFor))'), 'KI-E110: suggest projects the READY pool using the SAME bandFor the scheduler uses — projection and scheduling cannot disagree about a band');
  ok(dsrc110.indexOf('band mix (KI-E88') < dsrc110.indexOf('renderProjection(projectBatch'), 'KI-E110: the size line follows the KI-E88 shape line (mix, then magnitude)');
}

// KI-E107 / KI-E108 / KI-E109 (2026-09-02) — cost-yield reporting, flake suspicion, and main-drift
// prevention as a host policy.
{
  // --- KI-E107: agent-call spend by outcome (the yield number)
  const { renderCallsByOutcome, aggregateEvents } = await import('./telemetry.mjs');
  const r107 = renderCallsByOutcome({ CLOSED: { calls: 300, items: 15 }, FAILED: { calls: 100, items: 4 } });
  ok(r107.includes('75.0%') && r107.includes('(300/400)'), 'KI-E107: the yield ratio is calls-on-CLOSED over total calls');
  ok(r107.includes('FAILED spend: 25.0%'), 'KI-E107: FAILED spend is reported as the waste figure');
  ok(/\| CLOSED \| 15 \| 300 \| 75\.0% \| 20\.0 \|/.test(r107), 'KI-E107: per-outcome row carries items, calls, share AND calls/item — the last column is what exposes a FAILED item costing more than a CLOSED one');
  ok(!/\| ESCALATED \|/.test(r107), 'KI-E107: an outcome with no calls gets no table ROW (the word still appears in the footnote explaining why ESCALATED spend is not counted as waste — assert on the row, not the prose)');
  {
    const withEsc = renderCallsByOutcome({ CLOSED: { calls: 50, items: 5 }, ESCALATED: { calls: 50, items: 5 } });
    ok(withEsc.includes('FAILED spend: 0.0%'), 'KI-E107: ESCALATED spend is deliberately NOT counted as waste — it reached a human with the analysis intact, which is the system working');
  }
  eq(renderCallsByOutcome({}), '_none — needs item_folded events carrying a cost map (KI-E23)._', 'KI-E107: empty input renders a self-explaining placeholder, never a fake 0%');
  eq(renderCallsByOutcome(null), '_none — needs item_folded events carrying a cost map (KI-E23)._', 'KI-E107: null never throws');
  eq(renderCallsByOutcome({ CLOSED: { calls: 0, items: 3 } }), '_none — needs item_folded events carrying a cost map (KI-E23)._', 'KI-E107: zero total calls cannot divide — placeholder, never NaN%');
  {
    const agg = aggregateEvents([
      { event: 'item_folded', item: 'A', cycle: 1, attrs: { toState: 'CLOSED', cost: { 'claude-opus-4-8': 8, 'claude-haiku-4-5': 4 } } },
      { event: 'item_folded', item: 'B', cycle: 1, attrs: { toState: 'FAILED', cost: { 'claude-opus-4-8': 10 } } },
    ]);
    eq(agg.callsByOutcome.CLOSED, { calls: 12, items: 1 }, 'KI-E107: aggregation sums calls ACROSS models per item and buckets by the item outcome');
    eq(agg.callsByOutcome.FAILED, { calls: 10, items: 1 }, 'KI-E107: ... and keeps outcomes separate');
    eq(agg.models['claude-opus-4-8'], 18, 'KI-E107: the pre-existing by-model tally is unchanged (purely additive)');
  }
  // --- KI-E108: flake suspicion
  const { flakeSuspects } = await import('./verify.mjs');
  const T = (pairs) => pairs.map(([c, e]) => `FACTORY::TEST::FILTER::START Svc.sln :: ${c}\nFACTORY::TEST::FILTER::RESULT exit=${e}`).join('\n');
  eq(flakeSuspects(T([['FooTests', 1], ['FooTests', 0]])), ['FooTests'], 'KI-E108: a class that both FAILED and PASSED in one transcript is a flake suspect');
  eq(flakeSuspects(T([['FooTests', 0], ['BarTests', 1]])), [], 'KI-E108: two DIFFERENT classes with different outcomes is not a flake — that is the ordinary KI-E70 multi-class shape');
  eq(flakeSuspects(T([['FooTests', 1], ['FooTests', 1]])), [], 'KI-E108: a consistently failing class is a real failure, not a flake');
  eq(flakeSuspects(T([['FooTests', 0], ['FooTests', 0]])), [], 'KI-E108: a consistently passing class is not a flake');
  eq(flakeSuspects(T([['B', 1], ['B', 0], ['A', 1], ['A', 0]])), ['A', 'B'], 'KI-E108: multiple suspects are returned sorted (stable output)');
  eq(flakeSuspects(''), [], 'KI-E108: empty text -> []');
  eq(flakeSuspects(null), [], 'KI-E108: null never throws');
  eq(flakeSuspects('FACTORY::TEST::FILTER::START Svc.sln :: OnlyStart'), [], 'KI-E108: an unpaired START (truncated transcript) is ignored, never half-counted');
  {
    // the ADVISORY bound: the verdict must be unchanged by a flake pattern (last-wins, cycle-8 retry shape)
    const { parseVerifyRaw, verdictFromParse } = await import('./verify.mjs');
    const retryShape = T([['FooTests', 1], ['FooTests', 0]]) + '\nFACTORY::BUILD::RESULT exit=0 errors=0';
    ok(verdictFromParse(parseVerifyRaw(retryShape), []).pass, 'KI-E108: a fail-then-pass retry still PASSES — the flake signal is advisory and must never change the last-wins verdict the engine deliberately supports');
    ok(flakeSuspects(retryShape).length === 1, 'KI-E108: ... while still being NAMED, so a human can tell a retry from an unstable test');
  }
  const dsrc108 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc108.includes('flakeSuspects') && dsrc108.includes('KI-E108 ${id}: FLAKE SUSPECT'), 'KI-E108: the fold reports suspects');
  ok(/catch \{ \/\* advisory only/.test(dsrc108), 'KI-E108: the scan is wrapped — a flake scan must never affect a fold');
  // --- KI-E109: main-drift prevention as a policy
  const { loadPolicies } = await import('./policy.mjs');
  ok('failLaneOnMainDrift' in loadPolicies('/nonexistent-path-for-defaults'), 'KI-E109: the policy exists in the shared loadPolicies seam (same KI-E57/E58 mechanism, not a bespoke flag)');
  eq(loadPolicies('/nonexistent-path-for-defaults').failLaneOnMainDrift, false, 'KI-E109: OFF in the shipped engine — default behaviour is byte-for-byte the historical warn-only posture');
  const fsrc109 = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  ok(fsrc109.includes('A.policies && A.policies.failLaneOnMainDrift'), 'KI-E109: factory.js gates the fail on the policy, never unconditionally');
  ok(/MAIN-DRIFT/.test(fsrc109) && fsrc109.includes('failing the lane NOW instead of spending the gate band'), 'KI-E109: the lane fails on the ⚠ MAIN-DRIFT marker the KI-E50 verifyHint already has the runner paste into its note — reusing an existing signal, adding no new detection');
  ok(fsrc109.indexOf('failLaneOnMainDrift') < fsrc109.indexOf('// 5. REVIEW band'), 'KI-E109: it fails BEFORE the gate band — the entire point is not paying for a run that already wrote outside its worktree');
  const cfg109 = JSON.parse(readFileSync(new URL('../../config/factory.config.json', import.meta.url), 'utf8'));
  eq(cfg109.policies.failLaneOnMainDrift, false, 'KI-E109: shipped config default is OFF');
}

// KI-E144/KI-E144B (ported from a host-mount session) — main-drift detection reads a STRUCTURED
// boolean (`mainDriftOwnFiles`), never prose. Live there, cycle 93: a single genuine stray file from
// ONE item's agent made `driver.mjs main-check`'s separate, always-appended, repo-wide "unclaimed"
// sweep (KI-E89) non-empty; every OTHER concurrently-running item's runner dutifully pasted the WHOLE
// main-check output (per its own brief) into its own note, and a regex over that text could not tell
// "MY declared files drifted" from "an unrelated stray path exists somewhere else nobody has
// claimed" — six items across five unrelated services all failed off ONE incident. The FIRST fix
// anchored the regex to the item's own id — better, but the very next retry broke it a different way
// (KI-E144B): a runner correctly found nothing wrong and wrote "No `⚠ MAIN-DRIFT <id> (` line...
// printed" to PROVE it — and the anchored regex matched its own quoted negation anyway. The durable
// fix drops prose-parsing entirely: `mainDriftOwnFiles` is a closed boolean the runner sets directly,
// so no wording can misrepresent it.
{
  const src = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const wt = (id) => ({ path: '/tmp/exec-smoke-wt/' + id, branch: 'factory/' + id });
  const base = { target: 'X', layer: 'service', dependsOn: [], gateSet: [], autonomyTier: 'auto', source: 'smoke', solution: 'X/X.sln', peers: [] };
  const batchFor = (id) => ({
    cycle: 0, concurrency: 2, attempts: 1, repoRoot: '.', templatesDir: '_bmad-output/ai-factory/agents', config: {}, dryRun: false,
    policies: { failLaneOnMainDrift: true },
    items: [{ ...base, id, title: 'x', severity: 'HIGH', theme: 'money-correctness', fixType: 'non-trivial', files: ['X/src/Some.cs'], acceptance: 'x', regressionTest: 'test', realInfra: false, worktree: wt(id) }],
  });
  const runVerify = async (id, verifyExtra) => {
    const { result } = await execSmoke(src, batchFor(id), {
      agentOverride: (prompt, opts) => {
        if ((opts && opts.label) === id + ':runner') return Object.assign({ build: 'pass', targetedTest: 'pass', suite: { passed: 2, failed: 0, skipped: 0 }, realInfraExercised: false, debris: [], evidence: 'stub', note: 'stub' }, verifyExtra);
        return undefined;
      },
    });
    return (result.results || []).find((r) => r.id === id);
  };
  // (a) an UNRELATED item's genuine drift + the repo-wide unclaimed sweep, described in prose,
  //     mainDriftOwnFiles correctly false — the exact live cycle-93 (first retry) shape — must NOT fail.
  const codeInnocent = await runVerify('SMOKE-INNOCENT', {
    mainDriftOwnFiles: false,
    note: '⚠ MAIN-DRIFT SMOKE-GUILTY (KI-E50/KI-L65): main-tree file(s) changed mid-run.\n⚠ MAIN-DRIFT unclaimed (KI-E89): a stray path exists, could be leaked contamination OR unrelated work-in-progress.',
  });
  ok(codeInnocent && codeInnocent.toState !== 'FAILED', 'KI-E144 innocent: mainDriftOwnFiles=false must NOT fail me, regardless of what unrelated drift text appears in my own note');
  // (b) THIS item's own drift, mainDriftOwnFiles correctly true — must fail.
  const codeGuilty = await runVerify('SMOKE-GUILTY', {
    mainDriftOwnFiles: true,
    note: '⚠ MAIN-DRIFT SMOKE-GUILTY (KI-E50/KI-L65): main-tree file(s) changed mid-run — X/src/Some.cs (present -> changed/present)',
  });
  eq(codeGuilty && codeGuilty.toState, 'FAILED', 'KI-E144 guilty: mainDriftOwnFiles=true fails the lane — the real detection is preserved');
  ok(String(codeGuilty.note || '').includes('mainDriftOwnFiles=true'), 'KI-E144 guilty: the message cites the structured field, not a prose match');
  // (c) KI-E144B's exact failure shape: the runner's PROSE contains a quoted negation of its own
  //     item's drift marker (proving absence), but mainDriftOwnFiles is correctly false — must NOT
  //     fail, unlike the live incident this reproduces.
  const codeNegation = await runVerify('SMOKE-NEGATION', {
    mainDriftOwnFiles: false,
    note: 'MAIN-CHECK SMOKE-NEGATION: clean. No `⚠ MAIN-DRIFT SMOKE-NEGATION (` line and no `⚠ MAIN-DRIFT unclaimed (KI-E89)` line printed.',
  });
  ok(codeNegation && codeNegation.toState !== 'FAILED', 'KI-E144B: a runner correctly proving absence by quoting the marker format in negation must NOT fail — the boolean field is immune to whatever the prose says, unlike the live incident it reproduces');
  ok(![codeInnocent, codeGuilty, codeNegation].some((r) => String((r && r.note) || '').startsWith('runItem threw')), 'KI-E144/144B: no runItem crash across all three scenarios');
}

// KI-E106 (2026-09-02) — ITEM READINESS: the deterministic input-contract gate at group time.
{
  const { itemReadiness, unreadyItems } = await import('./readiness.mjs');
  const good = { id: 'A', acceptance: 'The ItemsController clamps pageSize to 100 and returns 400 above it.', regressionTest: 'A request with pageSize=500 must return 400; today it returns 200.', files: ['Svc/src/ItemsController.cs'] };
  ok(itemReadiness(good).ready, 'KI-E106: a well-formed item is ready');
  eq(itemReadiness(good).problems, [], 'KI-E106: ... with no problems reported');
  // acceptance
  eq(itemReadiness({ ...good, acceptance: '' }).problems.map((p) => p.code), ['acceptance-missing'], 'KI-E106: an empty acceptance is caught');
  eq(itemReadiness({ ...good, acceptance: 'TBD' }).problems.map((p) => p.code), ['acceptance-missing'], 'KI-E106: a placeholder acceptance ("TBD") is ABSENT, not stated — it must not pass on length alone');
  eq(itemReadiness({ ...good, acceptance: 'fix it' }).problems.map((p) => p.code), ['acceptance-uncheckable'], 'KI-E106: acceptance too short to yield ANY clause the KI-E18 splitter would probe is caught as a DISTINCT problem from absent');
  // the "uncheckable" rule must agree with the real splitter, not a second definition
  {
    const { splitAcceptanceClauses } = await import('./acceptance.mjs');
    const short = 'fix it';
    eq(splitAcceptanceClauses(short, 8).length, 0, 'KI-E106: the SAME splitter the KI-E18 probe runs yields zero clauses for that text — the gate and the probe cannot disagree about what "checkable" means');
  }
  // regressionTest
  eq(itemReadiness({ ...good, regressionTest: '' }).problems.map((p) => p.code), ['regression-test-missing'], 'KI-E106: a missing regressionTest is caught');
  eq(itemReadiness({ ...good, regressionTest: 'n/a' }).problems.map((p) => p.code), ['regression-test-missing'], 'KI-E106: "n/a" is a placeholder, not a red->green contract');
  eq(itemReadiness({ ...good, regressionTest: 'a test' }).problems.map((p) => p.code), ['regression-test-missing'], 'KI-E106: a too-short description is not a stated contract');
  // files
  eq(itemReadiness({ ...good, files: [] }).problems.map((p) => p.code), ['files-empty'], 'KI-E106: an empty files[] is caught (it silently disables the KI-E14 lock AND short-circuits the fold\'s P9 to PASS)');
  eq(itemReadiness({ ...good, files: undefined }).problems.map((p) => p.code), ['files-empty'], 'KI-E106: a missing files[] is caught the same way');
  // multiple problems are all reported, in stable order (so the operator fixes them in one pass)
  eq(itemReadiness({ id: 'B' }).problems.map((p) => p.code), ['acceptance-missing', 'regression-test-missing', 'files-empty'], 'KI-E106: every problem is reported at once, in a stable order — never one-at-a-time whack-a-mole');
  // never throws on junk
  ok(!itemReadiness(null).ready && itemReadiness(null).problems.length === 3, 'KI-E106: a null item never throws and reports every problem');
  ok(!itemReadiness({}).ready, 'KI-E106: an empty object is not ready');
  // batch helper + the blocked-tier exemption
  eq(unreadyItems([good, { id: 'C' }]).map((r) => r.id), ['C'], 'KI-E106: unreadyItems returns only the failing items');
  eq(unreadyItems([{ id: 'D', autonomyTier: 'blocked' }]), [], 'KI-E106: a `blocked` item is SKIPPED — it awaits an owner ruling and is not scheduled anyway, so reporting it would be noise the operator cannot act on');
  eq(unreadyItems([]), [], 'KI-E106: an empty batch is trivially ready');
  eq(unreadyItems(null), [], 'KI-E106: a null batch never throws');
  // driver wiring
  const dsrc106 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc106.includes("import { unreadyItems } from './lib/readiness.mjs'"), 'KI-E106: driver imports the gate');
  ok(dsrc106.includes('const unready106 = unreadyItems(picked)'), 'KI-E106: the gate runs against the PICKED batch');
  ok(dsrc106.includes("if (!flags['force-unready'])") && dsrc106.includes('process.exit(1)'), 'KI-E106: the gate BLOCKS by default (unlike the KI-E29/KI-E90 scheduling warns) — an unready item is defective in itself, and no batch composition rescues it');
  ok(dsrc106.includes('--force-unready'), 'KI-E106: ... with an explicit operator override, printed in the refusal message');
  ok(dsrc106.indexOf('const unready106') > dsrc106.indexOf('const picked'), 'KI-E106: the gate runs after the pick (it grades the batch that would actually be scheduled)');
}

// KI-E105 (2026-09-02) — stall detection: the missing SHORTENING half of KI-L41's retry economics.
{
  const { isNotConverging, applyStallDetection, isStalled, gateFindingsSummary } = await import('./convergence.mjs');
  const S = (findings, blockingGates = 1, maxRank = 1) => ({ findings, blockingGates, maxRank });
  // the predicate — strict complement of PROGRESS, not of isStrictlyNarrower
  ok(isNotConverging(S(5), S(5)), 'KI-E105: an identical finding count two rounds running is a stall');
  ok(isNotConverging(S(7), S(5)), 'KI-E105: a GROWING finding count is a stall');
  ok(!isNotConverging(S(3), S(5)), 'KI-E105: fewer findings is progress, never a stall');
  ok(!isNotConverging(S(3, 1, 0), S(5, 1, 2)), 'KI-E105: findings shrank but max severity got WORSE — earns no bonus (not strictly narrower) yet is NOT a stall either; real progress was made, so the two directions are deliberately not complements');
  ok(!isNotConverging(S(5), null), 'KI-E105: no prior round -> never a stall (nothing to compare)');
  ok(!isNotConverging(S(5, 0), S(5)), 'KI-E105: a round with no blocking gates is not comparable — same guard isStrictlyNarrower uses');
  // the accounting: streak accumulates, progress resets, bound is respected
  {
    const cfg = { maxStallRounds: 2 };
    const led = { items: { A: { state: 'FAILED' } } };
    const res = (findings) => [{ id: 'A', toState: 'FAILED', gateDetails: { 'gate:qa': { verdict: 'CHANGES_REQUIRED', findings: new Array(findings).fill({ severity: 'HIGH' }) } } }];
    const out = applyStallDetection(led, cfg, res(5), { A: S(5) });
    eq(led.items.A.stallRounds, 1, 'KI-E105: a FIRST flat round increments the streak to 1');
    eq(out.length, 0, 'KI-E105: ... but is NOT reported — one flat round is noise, the bound is 2 consecutive. A single bad round must never park work that would still have closed');
    ok(!isStalled(cfg, led.items.A), 'KI-E105: ... and the row is not yet stall-parked');
  }
  {
    const cfg = { maxStallRounds: 2 };
    const led = { items: { A: { state: 'FAILED', stallRounds: 1 } } };
    const res = [{ id: 'A', toState: 'FAILED', gateDetails: { 'gate:qa': { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH' }, { severity: 'HIGH' }] } } }];
    const out = applyStallDetection(led, cfg, res, { A: S(2) });
    eq(led.items.A.stallRounds, 2, 'KI-E105: a second consecutive flat round reaches the bound');
    eq(out.length, 1, 'KI-E105: ... and is reported to the driver for logging');
    ok(isStalled(cfg, led.items.A), 'KI-E105: isStalled agrees with the accounting — one definition drives both');
  }
  {
    const cfg = { maxStallRounds: 2 };
    const led = { items: { A: { state: 'FAILED', stallRounds: 1 } } };
    const res = [{ id: 'A', toState: 'FAILED', gateDetails: { 'gate:qa': { verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH' }] } } }];
    applyStallDetection(led, cfg, res, { A: S(4) });
    eq(led.items.A.stallRounds, 0, 'KI-E105: ANY reduction in findings RESETS the streak — one bad round is noise, only a consecutive pattern parks');
  }
  {
    const led = { items: { A: { state: 'FAILED', stallRounds: 5 } } };
    eq(applyStallDetection(led, { maxStallRounds: 0 }, [], {}).length, 0, 'KI-E105: maxStallRounds 0 disables the mechanism (host opt-out)');
    ok(!isStalled({ maxStallRounds: 0 }, led.items.A), 'KI-E105: ... and isStalled honours the same opt-out even on an already-high counter');
  }
  {
    // a pre-gate failure carries no gateDetails -> not a judgeable trajectory, counter untouched
    const cfg = { maxStallRounds: 2 };
    const led = { items: { A: { state: 'FAILED', stallRounds: 1 } } };
    applyStallDetection(led, cfg, [{ id: 'A', toState: 'FAILED' }], { A: S(3) });
    eq(led.items.A.stallRounds, 1, 'KI-E105: a pre-gate failure (test/verify/fold stage — no gateDetails) neither increments nor resets: nothing was adjudicated, so there is no trajectory to judge');
    eq(gateFindingsSummary({ toState: 'FAILED' }), null, 'KI-E105: gateFindingsSummary returns null for that shape (the guard this relies on)');
  }
  // driver wiring
  const dsrc105 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  ok(dsrc105.includes('applyStallDetection, isStalled') || (dsrc105.includes('applyStallDetection') && dsrc105.includes('isStalled')), 'KI-E105: driver imports both stall helpers from the single convergence module');
  ok(dsrc105.indexOf('const priorConvergence = {}') < dsrc105.indexOf('applyConvergenceBonus(ledger, cfg, arr)'), 'KI-E105: the prior-round summary is captured BEFORE the bonus pass overwrites row.convergence — otherwise the stall pass compares a round against itself');
  ok(dsrc105.includes('applyStallDetection(ledger, cfg, arr, priorConvergence)'), 'KI-E105: the stall pass receives that snapshot');
  ok(dsrc105.includes('const stalled = isStalled(cfg, row)') && dsrc105.includes('row.attempts > bound || stalled'), 'KI-E105: escalateExhausted parks on EITHER stop condition — one decision point, so scheduling and parking cannot disagree');
  ok(/NO-PROGRESS on \$\{row\.stallRounds\}/.test(dsrc105), 'KI-E105: the parked row records WHY it was parked (stall, not budget exhaustion) in its transition note');
  const cfg105 = JSON.parse(readFileSync(new URL('../../config/factory.config.json', import.meta.url), 'utf8'));
  eq(cfg105.maxStallRounds, 2, 'KI-E105: the shipped default is 2 consecutive no-progress rounds');
}

// KI-E104 (2026-09-02) — PRE-BAND P9: the shared isTest predicate, the non-test diff derivation, the
// deterministic lint CLI contract, and the factory.js probe wiring. P9 used to run ONLY at fold, so a
// tests-only diff cost a FULL gate band before rejection; this is the same hoist KI-E83 did for P1.
{
  const { isTestPath, nonTestChanged, touchedRootCause } = await import('./verify.mjs');
  // the predicate, both shapes it recognises
  ok(isTestPath('Svc/Tests/FooTests.cs'), 'KI-E104: a *Tests.cs filename is a test path');
  ok(isTestPath('Svc/Foo.Test.cs'), 'KI-E104: the singular *Test.cs form counts too');
  ok(isTestPath('Svc/Svc.Tests/Helper.cs'), 'KI-E104: any file under a .Tests/ project dir is a test path');
  ok(!isTestPath('Svc/src/OrderService.cs'), 'KI-E104: ordinary source is not a test path');
  ok(!isTestPath('k8s/base/deploy.yaml'), 'KI-E104: config is not a test path (P9 accepts config-only fixes — the KI-L24 class)');
  ok(!isTestPath('Svc/src/Contests.cs'), 'KI-E104: a source file whose name merely ENDS in those letters is NOT a test path — `Contests.cs` used to match (/i + `[^/]*Tests?\\.cs$`), which would make P9 read a fix touching only it as "tests-only" and FAIL a correct fix');
  ok(!isTestPath('Svc/src/Manifests.cs'), 'KI-E104: same false-positive class — Manifests.cs is source');
  ok(isTestPath('Svc/Tests.cs'), 'KI-E104: a file named exactly Tests.cs is still a test path (the narrowing did not over-correct)');
  ok(isTestPath('Svc/svc.tests/helper.cs'), 'KI-E104: the DIRECTORY arm stays case-insensitive — a lowercase test-project dir still classifies, which is the backstop for repos not using PascalCase filenames');
  // the derivation
  eq(nonTestChanged(['a/FooTests.cs', 'a/src/Foo.cs', 'b/Bar.Tests/X.cs', 'k8s/x.yaml']), ['a/src/Foo.cs', 'k8s/x.yaml'], 'KI-E104: nonTestChanged returns exactly the non-test files, preserving order');
  eq(nonTestChanged([]), [], 'KI-E104: empty diff -> empty');
  eq(nonTestChanged(null), [], 'KI-E104: a null diff never throws');
  // REGRESSION GUARD on the refactor: touchedRootCause is now DEFINED in terms of nonTestChanged;
  // its externally-observable behaviour (which the fold's P9 depends on) must be unchanged.
  ok(touchedRootCause(['a/src/Foo.cs'], ['a/src/Foo.cs']), 'KI-E104: touchedRootCause still true when a non-test file changed');
  ok(!touchedRootCause(['a/FooTests.cs'], ['a/src/Foo.cs']), 'KI-E104: touchedRootCause still FALSE for a tests-only diff (the P9 signal itself)');
  ok(touchedRootCause(['a/FooTests.cs'], []), 'KI-E104: an empty rootCauseFiles set still short-circuits true (config/doc item — nothing to assert)');
  ok(touchedRootCause(['a/FooTests.cs'], null), 'KI-E104: a null rootCauseFiles set still short-circuits true');
  // the lint CLI's own contract + INVERTED exit polarity vs its leftovers/comments siblings
  const rcli = readFileSync(new URL('../rootcause-lint.mjs', import.meta.url), 'utf8');
  ok(rcli.includes('FACTORY::ROOTCAUSE::') && rcli.includes('FACTORY::ROOTCAUSE-FILE::'), 'KI-E104: the lint emits the count marker and the per-file markers');
  ok(rcli.includes('FACTORY::ROOTCAUSE-SKIP'), 'KI-E104: an unreadable worktree emits a DISTINCT skip marker — "could not look" must never read as "looked and found nothing"');
  ok(rcli.includes('process.exit(nonTest.length ? 0 : 1)'), 'KI-E104: exit polarity is INVERTED vs leftovers/comments (zero non-test files is the FAILURE here)');
  ok(rcli.includes("import { nonTestChanged } from './lib/verify.mjs'") && rcli.includes("import { changedFiles } from './lib/worktree.mjs'"), 'KI-E104: the lint IMPORTS the same predicate + the same git reader the fold uses — no second derivation to drift');
  // factory.js wiring
  const fsrc104 = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  ok(fsrc104.includes("const ROOTCAUSE_SCHEMA = { type: 'object'") && fsrc104.includes("required: ['nonTestCount']"), 'KI-E104: ROOTCAUSE_SCHEMA is defined with the non-colliding nonTestCount field');
  ok(!/ROOTCAUSE_SCHEMA[^\n]*required: \['count'\]/.test(fsrc104), 'KI-E104: the schema does NOT use a bare `count` — COMMENT_SCHEMA already owns that name with the OPPOSITE polarity (zero=good), and shape-sniffing consumers collide on it');
  const rcBlock = fsrc104.slice(fsrc104.indexOf('4a4. ROOT-CAUSE TOUCH PROBE'), fsrc104.indexOf('Editorial (Band C)'));
  ok(rcBlock.length > 200, 'KI-E104: the probe block exists between the RED-proof probe and the editorial pass');
  ok(rcBlock.includes("if (codeChange && !verificationOnly && (res.rootCauseFiles || []).length) {"), 'KI-E104: gated exactly as the fold gates P9 — code items, never verificationOnly (KI-L55), only when a non-test touch-set was predicted');
  eq((rcBlock.match(/finish\('FAILED'/g) || []).length, 1, 'KI-E104: exactly one finish(\'FAILED\') call site in the probe block');
  ok(rcBlock.includes("res.gates['probe:rootcause-touch'] = 'SKIPPED'"), 'KI-E104: a probe that could not run ANNOUNCES itself on the gates map — silence never reads as clean (KI-E20/KI-E41 posture)');
  ok(fsrc104.indexOf('4a2. RED-PROOF') < fsrc104.indexOf('4a4. ROOT-CAUSE TOUCH PROBE') && fsrc104.indexOf('4a4. ROOT-CAUSE TOUCH PROBE') < fsrc104.indexOf('// 5. REVIEW band'), 'KI-E104: the probe runs after the RED-proof probe and strictly BEFORE the review/gate band (the whole point of the hoist)');
}

// KI-E101 (2026-09-02) — STEP mode for the plan-scan: normalizePlanSteps (the structured sibling of
// KI-E87's coarse prose prefilter), its factory.js inline-copy parity, the PLAN_SCHEMA `steps` field
// (optional — backward compatibility is the whole point), the two-mode factory.js wiring, and the
// planner brief that actually produces the field.
{
  const { normalizePlanSteps } = await import('./plan-commitment.mjs');
  // shape / fail-open
  eq(normalizePlanSteps(undefined), [], 'KI-E101: undefined steps -> [] (a plan without the new field degrades to PROSE mode, never throws)');
  eq(normalizePlanSteps(null), [], 'KI-E101: null steps -> []');
  eq(normalizePlanSteps('not an array'), [], 'KI-E101: a non-array steps value -> [], never throws');
  eq(normalizePlanSteps([]), [], 'KI-E101: empty array -> []');
  eq(normalizePlanSteps([{ step: 'an object, not a string' }, 42, null]), [], 'KI-E101: non-string entries are skipped, never thrown on');
  // normalization
  eq(normalizePlanSteps(['  Thread the token through   SubmitAsync  ']), ['Thread the token through SubmitAsync'], 'KI-E101: whitespace is collapsed and trimmed');
  eq(normalizePlanSteps(['1. Thread the token through SubmitAsync']), ['Thread the token through SubmitAsync'], 'KI-E101: a hand-written "1. " ordinal is stripped so the probe numbering does not double up');
  eq(normalizePlanSteps(['2) Thread the token through SubmitAsync']), ['Thread the token through SubmitAsync'], 'KI-E101: a "2) " ordinal is stripped');
  eq(normalizePlanSteps(['(3) Thread the token through SubmitAsync']), ['Thread the token through SubmitAsync'], 'KI-E101: a "(3) " ordinal is stripped');
  eq(normalizePlanSteps(['- Thread the token through SubmitAsync']), ['Thread the token through SubmitAsync'], 'KI-E101: a "- " bullet is stripped');
  eq(normalizePlanSteps(['* Thread the token through SubmitAsync']), ['Thread the token through SubmitAsync'], 'KI-E101: a "* " bullet is stripped');
  eq(normalizePlanSteps(['Add a guard clause to Foo', 'add a guard clause to FOO']), ['Add a guard clause to Foo'], 'KI-E101: dedupe is case-insensitive — a repeated step never inflates the gap count or re-spends probe budget');
  // length floor: 12, deliberately BELOW splitAcceptanceClauses' 20 (dropping an authored step is a
  // silent miss — the exact class this entry closes — so the floor errs low and only kills stubs).
  eq(normalizePlanSteps(['TODO']), [], 'KI-E101: a sub-12-char stub entry is dropped as not a real step');
  eq(normalizePlanSteps(['Wire the DI seam']), ['Wire the DI seam'], 'KI-E101: a genuine SHORT step (16 chars) survives — splitAcceptanceClauses\' 20-char floor would have silently dropped it');
  eq(normalizePlanSteps(['Add the null guard']), ['Add the null guard'], 'KI-E101: an 18-char genuine step survives the floor (regression guard on the 12-vs-20 decision)');
  // cap + tail merge (mirrors splitAcceptanceClauses: nothing is silently sliced away)
  {
    const ten = [];
    for (let i = 1; i <= 10; i++) ten.push('Step number ' + i + ' does a real thing');
    const capped = normalizePlanSteps(ten, 4);
    eq(capped.length, 4, 'KI-E101: output honours the cap');
    ok(capped[3].includes('Step number 4') && capped[3].includes('Step number 10'), 'KI-E101: the over-cap tail MERGES into the last entry — every authored step still reaches the probe, none is silently unchecked');
    eq(normalizePlanSteps(ten).length, 8, 'KI-E101: the default cap is 8, matching splitAcceptanceClauses');
  }
  // factory.js inline-copy byte-parity (the KI-E2 split: the Workflow runtime cannot import)
  const fsrc101 = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const asrc101 = readFileSync(new URL('./plan-commitment.mjs', import.meta.url), 'utf8');
  const bodyOf101 = (s) => { const m = s.match(/function normalizePlanSteps[\s\S]*?\n\}/); return m ? m[0] : null; };
  ok(bodyOf101(fsrc101) !== null, 'KI-E101: factory.js carries an inlined normalizePlanSteps');
  eq(bodyOf101(fsrc101), bodyOf101(asrc101.replace('export function normalizePlanSteps', 'function normalizePlanSteps')), 'KI-E101: factory.js inline copy is byte-identical to lib/plan-commitment.mjs');
  // PLAN_SCHEMA — the field exists on BOTH copies and is OPTIONAL on both (backward compatibility:
  // a planner that omits it, and a KI-E69 reused prior-attempt plan, must validate exactly as before)
  const osrc101 = readFileSync(new URL('../opencode/schemas.mjs', import.meta.url), 'utf8');
  ok(fsrc101.includes("steps: { type: 'array', items: { type: 'string' } }"), 'KI-E101: factory.js PLAN_SCHEMA declares steps as a string array');
  ok(osrc101.includes("steps: { type: 'array', items: { type: 'string' } }"), 'KI-E101: opencode/schemas.mjs PLAN_SCHEMA mirrors the steps field (the schema-parity gate requires deep-equality)');
  {
    const planReq = (src) => { const i = src.indexOf('PLAN_SCHEMA = '); const j = src.indexOf('required:', i); return src.slice(j, src.indexOf(']', j) + 1); };
    ok(!planReq(fsrc101).includes('steps'), 'KI-E101: steps is NOT in factory.js PLAN_SCHEMA.required — a planner omitting it still validates (backward compatible)');
    ok(!planReq(osrc101).includes('steps'), 'KI-E101: steps is NOT in the opencode PLAN_SCHEMA.required either');
  }
  // two-mode wiring in the 4c-bis block
  const pcBlock101 = fsrc101.slice(fsrc101.indexOf('4c-bis. PLAN-COMMITMENT SCAN'), fsrc101.indexOf('4d-pre. COMMENT SCAN'));
  ok(pcBlock101.includes('const planSteps = normalizePlanSteps(plan.steps, 8)'), 'KI-E101: the block derives its steps deterministically from plan.steps');
  ok(pcBlock101.includes('const stepMode = planSteps.length >= 2'), 'KI-E101: STEP mode needs >= 2 checkable steps (a 1-step plan is not a decomposition — falls back to PROSE)');
  ok(pcBlock101.includes('if (stepMode || proseGated) {'), 'KI-E101: STEP mode runs regardless of prose phrasing; PROSE mode still requires the KI-E87 prefilter — neither path was dropped');
  ok(pcBlock101.includes("const axis = stepMode ? 'plan step' : 'plan commitment'"), 'KI-E101: one `axis` noun renders both modes through the shared tail');
  ok(pcBlock101.includes('PLAN-STEP SCAN (KI-E101') && pcBlock101.includes('PLAN-COMMITMENT SCAN (KI-E87'), 'KI-E101: both probe prompts are present — the KI-E87 prose prompt is preserved verbatim as the fallback');
  ok(pcBlock101.includes('PLAN-STEP AMEND (KI-E101') && pcBlock101.includes('PLAN-COMMITMENT AMEND (KI-E87'), 'KI-E101: both amend prompts are present');
  eq((pcBlock101.match(/finish\('FAILED'/g) || []).length, 1, 'KI-E101: the two modes still share ONE finish(\'FAILED\') call site — the KI-E87 fail-open invariant is not duplicated per mode');
  eq((pcBlock101.match(/call\('plan-commitment-probe'/g) || []).length, 2, 'KI-E101: still exactly one probe + one bounded re-probe across both modes (no extra call was introduced)');
  eq((pcBlock101.match(/call\('fixer'/g) || []).length, 1, 'KI-E101 scope bound: exactly ONE fixer call in the block — steps decompose CHECKING, never EXECUTION (a per-step fixer would defeat fixer.md\'s whole-diff SIBLING-PATTERN/DEAD-CODE/ADJACENT-CLAIM/CANCELLATIONTOKEN self-checks, KI-E94/E95/E96, which guard the #1 rejection class KI-E51)');
  ok(pcBlock101.includes("res.gates['probe:plan-commitment-scan']") && !pcBlock101.includes("res.gates['probe:plan-step-scan']"), 'KI-E101: both modes share the EXISTING gate key — a second key would silently orphan telemetry/recover/feedback consumers keyed off it');
  ok(pcBlock101.includes("+ ' [' + (stepMode ? 'STEP' : 'PROSE') + ' mode]'"), 'KI-E101: the headline stamps which mode fired, so gateDetails/feedback.md is self-describing');
  ok(fsrc101.slice(0, 2500).includes('STEP mode probes the planner'), 'KI-E101: factory.js\'s own meta.description names STEP mode, matching what the code actually runs');
  // the brief that produces the field. Prose assertions match against a whitespace-FLATTENED copy:
  // planner.md is hand-wrapped markdown, so a phrase can straddle a line break (it already did once
  // here) — pinning the semantic phrase rather than the current wrapping keeps a harmless reflow
  // from reading as a regression.
  const plannerMd101 = readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'planner.md'), 'utf8');
  const plannerFlat101 = plannerMd101.replace(/\s+/g, ' ');
  ok(plannerFlat101.includes('Decompose the approach into `steps` (KI-E101)'), 'KI-E101: planner.md carries the step-authoring instruction');
  ok(/2[–-]8/.test(plannerFlat101), 'KI-E101: planner.md states the 2-8 step bound the code actually enforces (>=2 for STEP mode, cap 8)');
  ok(plannerFlat101.includes('This list is machine-checked.'), 'KI-E101: planner.md warns the planner its steps are probed against the diff — an aspirational step is a self-inflicted failure');
  ok(plannerFlat101.includes('put it in `ruleRisks`, never in `steps`'), 'KI-E101: planner.md routes deferred/out-of-scope work to ruleRisks, keeping steps to what this item must actually deliver');
  ok(plannerFlat101.includes('RETURN: `rootCause`, `approach`, `steps`'), 'KI-E101: planner.md\'s return contract lists steps (the brief and the schema agree)');
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

// Ported from a host-mount session (2026-08-29) — findMissingClaims flagged a line HONESTLY stating a
// path does NOT exist yet as if it were a fabricated-existence claim, the opposite of what the linter
// exists to catch. Origin evidence: a doc-drift fix's own added line — "**No K8s manifest yet**:
// `k8s/base/services/a-service.yaml` is Wave 5 (deploy gates the full sprint)." — a true statement
// about the current tree, flagged anyway because the linter only checked "does this path resolve",
// never whether the surrounding prose asserts existence or absence.
{
  const D99 = await import('./doclint.mjs');
  const notYetLine = '6. **No K8s manifest yet**: `k8s/base/services/a-service.yaml` is Wave 5 (deploy gates the full sprint).';
  const entries99 = new Set(['scripts/services.json', 'scripts/', 'scripts']); // deliberately does NOT contain the k8s manifest — it genuinely doesn't exist yet
  eq(D99.findMissingClaims([notYetLine], entries99), [], 'KI-E99: origin-incident line — honestly-absent path is not flagged as fabricated');
  // Line-granularity check: a "not yet" line does not blind the linter to a genuine phantom claim on
  // a SEPARATE line in the same call — NOT_YET_EXISTS_RE only skips the line it actually matches.
  eq(D99.findMissingClaims([notYetLine, 'wired up in `Api/Controllers/Support/`'], entries99), ['Api/Controllers/Support/'],
    'KI-E99: a genuine phantom-path claim on a DIFFERENT line still catches, even in the same call as a not-yet-exists line');
  // Other real phrasings the same regex is designed to cover (not yet built/created/implemented, is Wave N).
  eq(D99.findMissingClaims(['The retry queue does not exist yet in this service.'], entries99), [], 'KI-E99: "does not exist yet" phrasing is recognized');
  eq(D99.findMissingClaims(['`Infra/dr-failover.yaml` is not yet built; tracked for Wave 3.'], entries99), [], 'KI-E99: "not yet built" phrasing is recognized');
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
  // KI-E104: pin MEMBERSHIP in the engine-owned lint case, not the exact alternation literal. The
  // literal form broke on every lint added to it (KI-E91's ledger-anchor, then KI-E104's rootcause) —
  // a pin that fails for a purely additive, correct change trains readers to edit pins reflexively,
  // which is how a real regression eventually gets waved through.
  ok(/^\s*[a-z|-]*\bleftovers\b[a-z|-]*\)/m.test(bts) && bts.includes('leftover-lint.mjs'), 'KI-D12: build-test.sh leftovers subcommand wired to the CLI (engine-owned dispatch BEFORE the local-override seam — PR#9)');
  // KI-E104: this ordering assertion had been silently VACUOUS since KI-E91 extended the case pattern
  // — `indexOf('leftovers|comments)')` returned -1, and `-1 < indexOf(...)` is trivially true, so it
  // passed for the wrong reason and would no longer have caught a host override placed before the
  // lints. Re-anchored on the real dispatch line, with an explicit guard that both anchors EXIST.
  {
    const iLintCase = bts.search(/^\s*[a-z|-]*\bleftovers\b[a-z|-]*\)/m);
    const iOverride = bts.indexOf('build-test.local.sh"');
    ok(iLintCase >= 0 && iOverride >= 0 && iLintCase < iOverride, 'PR#9: the diff-lint dispatch precedes the build-test.local.sh override exec (a stale host override can never swallow the lints) — both anchors must exist, so a renamed anchor fails loudly instead of passing on -1');
  }
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
  ok(/^\s*[a-z|-]*\bcomments\b[a-z|-]*\)/m.test(bts) && bts.includes('comment-lint.mjs'), 'KI-E59: build-test.sh comments subcommand wired to the CLI (membership-pinned, KI-E104)');
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
  eq(loadPolicies(pd), { noNewComments: false, noSchemaChanges: false, failLaneOnMainDrift: false }, 'policy: no config at all -> all OFF (shipped-engine default; KI-E109 added failLaneOnMainDrift)');
  mkdirSync(join(pd, 'config'), { recursive: true });
  fsWrite(join(pd, 'config', 'factory.config.json'), JSON.stringify({ policies: { noNewComments: false, noSchemaChanges: false } }));
  fsWrite(join(pd, 'config', 'factory.config.local.json'), JSON.stringify({ policies: { noNewComments: true } }));
  eq(loadPolicies(pd), { noNewComments: true, noSchemaChanges: false, failLaneOnMainDrift: false }, 'policy: gitignored local overlay flips a policy per host (KI-E17 seam)');
  fsWrite(join(pd, 'config', 'factory.config.local.json'), '{ broken json');
  eq(loadPolicies(pd), { noNewComments: false, noSchemaChanges: false, failLaneOnMainDrift: false }, 'policy: an unreadable overlay never throws — falls back to the committed config');
  eq(renderPolicies({ noNewComments: true }), 'noNewComments=on noSchemaChanges=off failLaneOnMainDrift=off', 'policy: renderPolicies one-liner for the driver status prints');
  // Committed config ships BOTH policies OFF — a public engine must not default to one owner's rules.
  const shipped = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'config', 'factory.config.json'), 'utf8'));
  eq(!!(shipped.policies && shipped.policies.noNewComments), false, 'policy: shipped config has noNewComments OFF');
  eq(!!(shipped.policies && shipped.policies.noSchemaChanges), false, 'policy: shipped config has noSchemaChanges OFF');
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
  const { sameTargetPairs } = await import('./ledger.mjs');
  eq(sameTargetPairs([{ id: 'A', target: 'Svc1' }, { id: 'B', target: 'Svc1' }]), [{ target: 'Svc1', ids: ['A', 'B'] }], 'KI-E90: two picked items on the same target -> one pair, ids in pick order');
  eq(sameTargetPairs([{ id: 'A', target: 'Svc1' }, { id: 'B', target: 'Svc2' }]).length, 0, 'KI-E90: disjoint targets -> no pair');
  eq(sameTargetPairs([{ id: 'A', target: 'Svc1' }, { id: 'B' }, { id: 'C', target: 'Svc1' }]), [{ target: 'Svc1', ids: ['A', 'C'] }], 'KI-E90: an item with no target is ignored, not grouped under undefined');
  eq(sameTargetPairs([]), [], 'KI-E90: empty batch -> no pairs');
  eq(sameTargetPairs(null), [], 'KI-E90: null picked -> no throw, empty result');
  ok(dsrc20.includes('sameTargetPairs(picked)') && dsrc20.includes('KI-E90 WARN'), 'KI-E90: cmdGroup wires the pure same-target warn core');
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
  // KI-E111: the mode-bit half is POSIX-only. On Windows NTFS has no execute attribute — Node
  // synthesises `mode` from the read-only flag, so EVERY file reads as non-executable and the old
  // unconditional check made shimAvailable() always false there (the KI-E72 false-negative, one
  // platform over). The win32 contract is "an existing file is usable", because Git Bash runs a .sh
  // regardless of NTFS attributes; assert the REAL contract per platform rather than skipping.
  if (process.platform === 'win32') {
    ok(shimAvailable(nonExecShim), 'KI-E111: on win32 a present shim is available regardless of mode bits (NTFS has no exec bit; Git Bash runs the .sh anyway) — the pre-fix code returned false for every file, reporting "dotnet: ABSENT" on a host whose shim works');
  } else {
    ok(!shimAvailable(nonExecShim), 'KI-E72: shimAvailable is false for a present but non-executable file (mode bit checked, not just existence)');
  }
  ok(!shimAvailable(join(dir, 'no-such-shim.local.sh')), 'KI-E111: a nonexistent shim is unavailable on EVERY platform (the win32 relaxation must not degrade into "always true")');
  ok(!shimAvailable(dir), 'KI-E111: a DIRECTORY is never a usable shim on any platform (isFile guard — win32 existence alone would otherwise accept it)');
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
  // KI-E113 — `.claude/` is per-host session state and/or generated install output, never engine
  // content, and was missed by the original KI-E26 sweep. Three independent reasons it must stay
  // out, each pinned below by intent rather than by the current directory contents (which change):
  ok(/^\.claude\/$/m.test(gi), 'KI-E113: .claude/ is gitignored — it holds per-host settings.local.json (KI-E33/E52 write OTLP endpoints there), REGISTERED git worktrees (a checkout of this repo inside itself), and setup/init.mjs\'s generated copy of claude-assets/');
  ok(!/^claude-assets/m.test(gi), 'KI-E113: claude-assets/ — the engine\'s SHIPPED Claude assets and the source init.mjs installs FROM — is NOT ignored; only the generated destination is');
  ok(/^telemetry\/\.env$/m.test(gi), 'KI-E52: per-host telemetry/.env is gitignored (E2E-caught — upgrades must see a clean tree)');
  // Deep-review hardening pins (2026-07-27) — behaviors are exercised end to end by setup/_e2e.sh.
  const { execFileSync: exf52 } = await import('node:child_process');
  // KI-E111: probe bash SEPARATELY first. The old form wrapped the three `bash -n` calls in one
  // try/catch and reported any throw as "the shipped install scripts do not parse" — conflating a
  // real syntax error with a host that simply has no usable bash, and printing a scary false failure
  // about shipped release tooling. On Windows `bash` typically resolves to the WSL launcher stub,
  // which does NOT throw ENOENT: it runs and exits non-zero ("execvpe(/bin/bash) failed"), so even an
  // errno check would not have separated the two. A trivial `bash -c "exit 0"` does. Announced SKIP,
  // matching the git-unavailable fixtures in this file — silence never reads as a pass.
  let bashUsable52 = true;
  try { exf52('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); } catch { bashUsable52 = false; }
  if (bashUsable52) {
    let parse52 = true;
    let parseErr52 = '';
    try { for (const s of ['install.sh', 'release.sh', '_e2e.sh']) exf52('bash', ['-n', join(ROOT, 'setup', s)], { stdio: 'pipe' }); } catch (e) { parse52 = false; parseErr52 = String((e && e.stderr) || (e && e.message) || ''); }
    ok(parse52, 'KI-E52: install.sh / release.sh / _e2e.sh all parse (bash -n)' + (parse52 ? '' : ' — ' + parseErr52.slice(0, 300)));
  } else {
    console.log('  SKIP KI-E52 bash -n syntax check (1 assert — no usable bash on this host; on Windows `bash` resolves to the WSL stub and exits non-zero rather than ENOENT). CI runs ubuntu-latest, so the shipped scripts are still syntax-gated on every push.');
  }
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

// Ported from a host-mount session (2026-08-29) — neither KI-E67's nor KI-E74C's marker match
// understood negation: a phrase preceded by "No"/"Not"/"Zero"/"None" asserts the OPPOSITE of what the
// bare marker text implies, but neither detector's match logic ever looked at what preceded the
// match. Origin evidence: an item's own verify.json wrote "No findings from the prior round remain
// unaddressed." — a genuine, correct completion claim on a CLOSED result — and
// detectUnresolvedCaveatOnClose's `findings…remain unaddressed` marker fired anyway, reading a
// correct claim as an admission of failure. The negation guard must NOT suppress the real ITEM-H1
// admission this detector exists to catch (see the KI-E74C block above) — its outer "does NOT mean X"
// negates a different clause than the inner "findings…remain unaddressed" marker, so the two must be
// told apart, not both suppressed by a blanket negation scan.
{
  const N98 = await import('./narrative-check.mjs');
  const itemH2Note = 'GREEN now. No findings from the prior round remain unaddressed. FIX-MANIFEST CROSS-CHECK: git status shows 3 tracked changes.';
  const itemH1Note = "Build+targeted-test green here does NOT mean round 2's findings are resolved — they are not, and are unaddressed in this worktree as of this pass";
  eq(N98.detectUnresolvedCaveatOnClose('CLOSED', { 'verify.json': itemH2Note }), [], 'KI-E98: a negated admission ("No findings … remain unaddressed") is NOT flagged — it is a correct completion claim');
  eq(N98.detectUnresolvedCaveatOnClose('CLOSED', { 'verify.json': itemH1Note }), [{ file: 'verify.json', marker: "does NOT mean round 2's findings are resolved — they are not, and are unaddressed" }], 'KI-E98: the ITEM-H1 admission still fires — its outer negation targets a different clause than the inner "findings…remain unaddressed" marker, so blanket suppression must not eat it too');
  // Direct unit coverage of the negation primitive itself, independent of which detector calls it.
  ok(/const NEGATION_BEFORE_RE = \/\\b\(no\|not\|zero\|none\|never\|nothing\)\\s\*\$\/i;/.test(readFileSync(join(import.meta.dirname, 'narrative-check.mjs'), 'utf8')),
    'KI-E98: narrative-check.mjs defines the shared negation-lookbehind window used by both detectors');
  // KI-E67's forward detector: pre-emptive hardening, no live incident, but same mechanism — a
  // negated strong-completion marker on a FAILED/ESCALATED item must not misfire either.
  eq(N98.detectNarrativeVerdictContradiction('FAILED', { 'x.md': 'Status is not yet complete; 3 findings remain open.' }), [], 'KI-E67/KI-E98: a negated completion marker ("not … complete") does not false-positive on a FAILED item');
  ok(N98.detectNarrativeVerdictContradiction('FAILED', { 'x.md': 'Status: fully complete' }).length === 1, 'KI-E67/KI-E98: the un-negated genuine marker still fires (regression guard against the E98 fix over-suppressing E67)');
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
  // {recommendScopeStop:false, recommendEscalate:false} stand-in for the two structured flags
  // (never a PARSE of the prose file — no attempt to extract structured fields from markdown), PLUS
  // (fix, multi-lens review 2026-08-25, ported) the raw plan.md text carried verbatim as `approach`
  // so the KI-E87 PLAN-COMMITMENT SCAN has real text to check on a relaunch, instead of silently
  // never firing (see lib/prior-attempt.mjs's fix comment).
  const d2 = join(pdir, 'd2'); mkdirSync(d2, { recursive: true });
  fsWrite(join(d2, 'plan.md'), '# Plan\nproceed.');
  fsWrite(join(d2, 'test.json'), JSON.stringify({ red: false, verificationOnly: true }));
  fsWrite(join(d2, 'fix.json'), JSON.stringify({ applied: true, scopeStop: false, summary: 'did it' }));
  const pa2 = P.loadPriorAttempt(d2, beforeWrite);
  eq(pa2.plan, { recommendScopeStop: false, recommendEscalate: false, approach: '# Plan\nproceed.' }, 'KI-E69/E87: plan reuses the safe scope/escalate stand-in PLUS the verbatim plan.md text as approach (not a structured-field parse) once test.json is ALSO present');
  eq(pa2.test.verificationOnly, true, 'KI-E69: test.json reused verbatim');
  eq(pa2.fix.applied, true, 'KI-E69: fix.json reused verbatim');
  eq(P.priorAttemptStages(pa2), ['plan', 'test', 'fix'], 'KI-E69: all three stages report reused');
  // KI-E87 fix regression proof: a plan.md carrying real commitment language IS now visible to
  // hasPlanCommitmentLanguage through the reused stand-in — this is the exact gap that was silently
  // open before (the pre-fix stand-in had no text fields at all).
  const { hasPlanCommitmentLanguage: hpclE69 } = await import('./plan-commitment.mjs');
  const dCommit = join(pdir, 'd-commit'); mkdirSync(dCommit, { recursive: true });
  fsWrite(join(dCommit, 'plan.md'), '# Plan\nThe fix MUST include the brownfield note.');
  fsWrite(join(dCommit, 'test.json'), JSON.stringify({ red: true, testFiles: ['a.cs'] }));
  const paCommit = P.loadPriorAttempt(dCommit, beforeWrite);
  ok(hpclE69(paCommit.plan.approach), 'KI-E87 fix: a relaunched item\'s reused plan stand-in carries real plan.md commitment language the pre-fix stub would have silently hidden from hasPlanCommitmentLanguage');

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

// KI-E81 (2026-08-16): auto-detect the narrow "died on exactly one late-pipeline stage, nothing
// to remediate" recovery shape and generate its prompt — the manual work a controller session did
// repeatedly by hand (pull the finding spec, write near-identical boilerplate, remember the tee
// paths) after a spend-limit outage killed a review band mid-run for several items needing only a
// fresh re-auditor, and several others needing only a fresh integrator.
{
  // -- pure missingStageFrom: the decision table --
  eq(missingStageFrom(['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED'], {}).stage,
    'integrator', 'KI-E81: last stage reached is REAUDITED -> only integrator is missing');
  eq(missingStageFrom(['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK'], { reaudit: 'code=NULL' }).stage,
    're-auditor', 'KI-E81: last stage reached is REFUTE_OK -> re-auditor is missing');
  eq(missingStageFrom(['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK'], { reaudit: 'code=NULL' }).lenses,
    ['code'], 'KI-E81: the single-lens case reads the lens name directly from the already-recorded gates.reaudit string, never re-derived');
  eq(missingStageFrom(['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK'], { reaudit: 'code=ok edge-case=NULL' }).lenses,
    ['code', 'edge-case'], 'KI-E81: a multi-lens reaudit string parses every lens name, in order, not just the first');
  eq(missingStageFrom(['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK'], {}).stage,
    null, 'KI-E81: reached REFUTE_OK but gates.reaudit was never even started (no string at all) -> refuses to guess, stage:null (falls back to a normal re-group)');
  eq(missingStageFrom(['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED'], {}).stage,
    null, 'KI-E81: died at GATED (refuter/reaudit both still missing) -> stage:null, deliberately NOT auto-recovered (too much needed, a normal re-group is the honest choice)');
  eq(missingStageFrom(['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED'], {}).stage,
    null, 'KI-E81: died before any gate ran -> stage:null (full re-group is correct, not wasteful, since the review band never even started)');
  eq(missingStageFrom([], {}).stage, null, 'KI-E81: empty/missing transitions never throws, just returns stage:null');
  eq(missingStageFrom(undefined, undefined).stage, null, 'KI-E81: undefined transitions/gates never throws, just returns stage:null');

  // -- wiring: cmdFold writes the structured last-failure.json sidecar cmdRecover reads (NOT
  // result.json, which a checkpoint-writer that died to the SAME infra outage never gets to write) --
  const dsrc81 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc81.includes("join(dir, 'last-failure.json')"), 'KI-E81: cmdFold writes state/items/<id>/last-failure.json alongside last-failure.md');
  ok(dsrc81.includes('id: r.id, cycle: cyc, transitions: r.transitions'),
    'KI-E81: the sidecar carries transitions + gates + infraSuspect — exactly what missingStageFrom needs');
  ok(dsrc81.indexOf("join(dir, 'last-failure.json')") > dsrc81.indexOf("join(dir, 'last-failure.md')"),
    'KI-E81: the JSON sidecar is written in the SAME loop right after last-failure.md, not a separate untested pass');

  // -- wiring: cmdRecover actually calls missingStageFrom and gates the auto-generated prompt
  // behind "no structured dissent" (never fires alongside a real regate-*.md prompt) --
  ok(dsrc81.includes('missingStageFrom(lastFailure.transitions, lastFailure.gates)'), 'KI-E81: cmdRecover calls missingStageFrom with the last-failure.json fields');
  ok(dsrc81.includes('if (!dissent.length) {') && dsrc81.indexOf('if (!dissent.length) {') < dsrc81.indexOf('missingStageFrom(lastFailure.transitions'),
    'KI-E81: the missing-stage detection is gated behind "no dissent" — never overrides a real regate-*.md prompt with a stage-prompt guess');
  ok(dsrc81.includes("join(recDir, `recover-stage-${missing.stage}.md`)"), 'KI-E81: the generated prompt file is named recover-stage-<role>.md, distinct from regate-<role>.md');
  ok(dsrc81.includes('solutionFor(wi.target'), 'KI-E81: the integrator prompt reuses the EXISTING solutionFor() resolver (services.json + <Target>/<Target>.sln convention) rather than a second, divergent lookup');
  ok(dsrc81.includes('VERDICT: converged=<true|false> findingGone=<true|false>') && dsrc81.includes('VERDICT: globalGreen=<true|false> regressionDelta=<integer>'),
    'KI-E81: both generated prompt shapes end with the same parseable VERDICT line convention');
  ok(dsrc81.includes('stagePrompt.file'), 'KI-E81: cmdRecover surfaces the generated stage-prompt path in both the README and the console summary, not just silently on disk');
}

// KI-E82 (2026-08-16): `main-check <id>` already existed (KI-E50) but required the caller to
// already know which ids to suspect. fold's KI-L65 auto-repair is scoped to "items in THIS fold,"
// never a sweep of everything the factory has ever touched, so contamination left by an EARLIER
// round's item — that no LATER fold's batch happens to include — is never re-checked by anything
// automatic. `--all` (or a bare `main-check` with no ids) removes the "already know which ids"
// precondition: it lists every item directory carrying a claim-time `main-snapshot.json` (any
// cycle, ever) and checks all of them in one read-only pass, reusing the EXACT SAME
// `driftAgainstSnapshot`/`splitDriftByStatus` decision logic the targeted form already used — no
// new drift-classification logic, purely a wider id list.
{
  const dsrc82 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(dsrc82.includes('function cmdMainCheck(rest, flags)'), 'KI-E82: cmdMainCheck now receives flags (for --all), not just the positional id list');
  ok(dsrc82.includes('flags?.all') || dsrc82.includes('flags.all'), 'KI-E82: an explicit --all flag triggers the sweep');
  ok(dsrc82.includes('!ids.length || flags'), 'KI-E82: a BARE `main-check` with no ids ALSO sweeps (not just --all) — matches the live incident, where nobody thought to pass any ids at all');
  ok(dsrc82.includes("existsSync(join(itemsRoot, d.name, 'main-snapshot.json'))"),
    'KI-E82: the sweep set is derived from which item directories actually carry a claim-time snapshot — never a guess, never the full findings-graph (an item that was never claimed has nothing to compare against)');
  ok(dsrc82.includes('cmdMainCheck(rest, flags)') && dsrc82.indexOf("case 'main-check': return cmdMainCheck(rest, flags)") > 0,
    'KI-E82: the CLI dispatch actually threads flags through to cmdMainCheck (not just a function signature nobody calls with the new arg)');
  ok(!/function driftAgainstSnapshot|function splitDriftByStatus/.test(dsrc82.slice(dsrc82.indexOf('function cmdMainCheck'), dsrc82.indexOf('function cmdMainCheck') + 2500)),
    'KI-E82: the sweep does NOT reimplement drift classification — it reuses the existing imported driftAgainstSnapshot/splitDriftByStatus, only widening which ids get checked');
}

// KI-O5 (2026-08-17): the third controller seam. `setup/init.mjs` installed host pointers for
// Claude Code (KI-E17) and Copilot (KI-O4), but an OpenCode controller in a host repo had NO
// installed pointer at all — `_workflow/opencode/` was reachable only by a session that already
// knew to look for it. Adds `opencode-assets/` (a copied `root/` tree + a MERGED opencode.json
// fragment) and `setup/install.mjs`, the Node twin of install.sh for hosts with no usable bash.
// The merge is the part with real failure modes, so it is a pure, injectable helper rather than
// an object spread at the call site: opencode evaluates the LAST matching permission pattern, so
// a factory rule left wherever a PREVIOUS install put it can be silently outranked by a broad
// host rule declared after it — the exact class of bug a `{...host, ...factory}` spread creates,
// since JS keeps an existing key in its ORIGINAL insertion position on overwrite.
{
  const HI = await import('./hostinstall.mjs');
  const ROOT5 = join(import.meta.dirname, '..', '..');
  const fragment = JSON.parse(readFileSync(join(ROOT5, 'opencode-assets', 'opencode.config.json'), 'utf8'));

  // --- appendRulesLast: the ordering invariant, stated directly ---
  eq(Object.keys(HI.appendRulesLast({ 'a *': 'allow', 'git commit*': 'allow', 'z *': 'ask' }, { 'git commit*': 'ask' })),
    ['a *', 'z *', 'git commit*'],
    'KI-O5: a factory rule already present is MOVED to the end, not overwritten in place (a plain spread would leave it at index 1, behind the host\'s later rules — last match wins)');
  eq(HI.appendRulesLast({ 'git *': 'allow' }, { 'git commit*': 'ask' }), { 'git *': 'allow', 'git commit*': 'ask' },
    'KI-O5: host rules keep their relative order and the factory block lands after them');
  eq(HI.appendRulesLast({}, {}), {}, 'KI-O5: empty in, empty out');
  const frozen5 = { 'git commit*': 'allow' };
  HI.appendRulesLast(frozen5, { 'git commit*': 'ask' });
  eq(frozen5, { 'git commit*': 'allow' }, 'KI-O5: appendRulesLast never mutates its inputs');

  // --- appendInstructions: idempotent union, host order preserved ---
  eq(HI.appendInstructions(['docs/style.md'], ['.opencode/ai-factory.md']), ['docs/style.md', '.opencode/ai-factory.md'], 'KI-O5: the factory instructions entry appends after the host\'s');
  eq(HI.appendInstructions(['.opencode/ai-factory.md'], ['.opencode/ai-factory.md']), ['.opencode/ai-factory.md'], 'KI-O5: re-installing never duplicates the instructions entry');
  eq(HI.appendInstructions(undefined, ['.opencode/ai-factory.md']), ['.opencode/ai-factory.md'], 'KI-O5: a host with no instructions array gets one');

  // --- mergeOpencodeConfig: fresh host ---
  const fresh5 = HI.mergeOpencodeConfig({}, fragment);
  ok(fresh5.refused === null && fresh5.changed, 'KI-O5: a host with no opencode.json gets the whole factory block');
  eq(fresh5.config.instructions, ['.opencode/ai-factory.md'], 'KI-O5: the always-on rules file is registered via instructions (a factory-owned path that cannot collide with the host\'s AGENTS.md)');
  ok(fresh5.config.$schema === 'https://opencode.ai/config.json', 'KI-O5: $schema is filled in so the host\'s editor validates the file');

  // --- idempotency: the property every re-run and every `upgrade` depends on ---
  const again5 = HI.mergeOpencodeConfig(fresh5.config, fragment);
  ok(!again5.changed, 'KI-O5: merging into an already-merged config is a no-op — init.mjs is re-runnable and `upgrade` refreshes host scaffolding on every release');
  eq(again5.config, fresh5.config, 'KI-O5: the no-op merge is byte-identical, so no spurious diff lands in the host repo');

  // --- the live failure this exists to prevent: a broad host rule declared AFTER a factory rule ---
  const shadowed5 = HI.mergeOpencodeConfig({ permission: { bash: { 'git commit*': 'deny', 'git *': 'allow' } } }, fragment);
  const bashKeys5 = Object.keys(shadowed5.config.permission.bash);
  ok(bashKeys5.indexOf('git *') < bashKeys5.indexOf('git commit*'),
    'KI-O5: an existing factory-owned rule is re-appended AFTER the host\'s broad `git *` allow — without the move, the host rule would win and the invariant would be silently off');
  ok(bashKeys5[bashKeys5.length - 1] === 'Remove-Item *STOP_REQUESTED*', 'KI-O5: the factory block occupies the tail of the rule object in fragment order');
  ok(shadowed5.notes.some((n) => /re-appended/.test(n)), 'KI-O5: the re-append is REPORTED, never a silent reordering of the host\'s file');

  // --- per-tool string shorthand is documented-equivalent, so promoting it is safe ---
  const shorthand5 = HI.mergeOpencodeConfig({ permission: { bash: 'allow' } }, fragment);
  ok(shorthand5.refused === null && shorthand5.config.permission.bash['*'] === 'allow',
    'KI-O5: `bash: "allow"` expands to {"*":"allow"} (its documented meaning) and keeps the catch-all FIRST, so the factory rules still win');
  eq(Object.keys(shorthand5.config.permission.bash)[0], '*', 'KI-O5: the promoted catch-all leads the object — broad first, narrow last');

  // --- a BARE top-level string covers tools the factory names no rules for: refuse, never narrow ---
  const bare5 = HI.mergeOpencodeConfig({ permission: 'allow' }, fragment);
  ok(bare5.refused && !bare5.changed, 'KI-O5: a bare-string top-level `permission` is REFUSED — expanding it would silently change read/glob/grep/list/task posture too (same no-silent-damage posture as install.sh\'s settings.local.json guard)');
  eq(bare5.config, { permission: 'allow' }, 'KI-O5: a refused merge returns the host config untouched');

  // --- host settings the factory says nothing about are preserved verbatim ---
  const rich5 = HI.mergeOpencodeConfig({ model: 'anthropic/claude-sonnet-4-6', mcp: { pw: { type: 'local', command: ['npx'] } }, permission: { edit: { 'secrets/**': 'deny' } } }, fragment);
  ok(rich5.config.model === 'anthropic/claude-sonnet-4-6' && rich5.config.mcp.pw.type === 'local', 'KI-O5: the host\'s own model/mcp settings survive the merge — the factory merges INTO their file, it does not own it');
  ok(rich5.config.permission.edit['secrets/**'] === 'deny', 'KI-O5: an unrelated host permission rule is preserved');

  // --- the shipped fragment satisfies opencode's own Config schema constraints ---
  eq(Object.keys(fragment).sort(), ['$schema', 'instructions', 'permission'], 'KI-O5: the fragment carries ONLY keys opencode\'s Config allows (its schema sets additionalProperties:false — an unknown key is a hard startup failure, not a warning)');
  for (const [tool, rules] of Object.entries(fragment.permission)) {
    ok(Object.values(rules).every((v) => ['allow', 'ask', 'deny'].includes(v)), 'KI-O5: every ' + tool + ' rule value is one of allow/ask/deny');
  }
  // The shape of the policy itself: repo-wide `deny` on bare git would block ordinary
  // OpenCode-assisted development in the host repo, which the factory's own rules explicitly
  // permit — so bare verbs ASK (the human authors every commit) and only worktree-scoped
  // mutations are a hard DENY.
  for (const verb of ['commit', 'add', 'checkout', 'restore', 'stash', 'reset', 'clean', 'push']) {
    eq(fragment.permission.bash['git ' + verb + '*'], 'ask', 'KI-O5: bare `git ' + verb + '` asks — a visible human decision, not a broken host repo');
    eq(fragment.permission.bash['git -C *worktrees* ' + verb + '*'], 'deny', 'KI-O5: `git ' + verb + '` against a factory worktree is a hard deny — there is no legitimate case for it');
  }
  ok(!Object.keys(fragment.permission.bash).some((k) => /^git worktree/.test(k)),
    'KI-O5: `git worktree add` is NOT denied — lib/worktree.mjs invokes it WITHOUT -C, and every factory pattern is anchored on `git -C ` or a bare mutating verb, so the factory can still create its own worktrees');
  ok(Object.keys(fragment.permission.bash).filter((k) => /STOP_REQUESTED/.test(k)).length >= 3
    && Object.entries(fragment.permission.bash).filter(([k]) => /STOP_REQUESTED/.test(k)).every(([, v]) => v === 'deny'),
    'KI-O5: deleting the owner-controlled drain marker is denied for rm/del/Remove-Item alike (POSIX and PowerShell hosts)');
  ok(Object.values(fragment.permission.edit).every((v) => v === 'deny') && Object.keys(fragment.permission.edit).some((k) => /ledger\.json$/.test(k)),
    'KI-O5: state/ledger.json is edit-denied — the single-writer invariant becomes a machine gate, not just a sentence in a brief');

  // --- the three controller asset trees exist at exactly the paths init.mjs maps them to ---
  for (const [ctl, p] of [
    ['claude', ['claude-assets', 'skills', 'ai-factory', 'SKILL.md']],
    ['copilot', ['copilot-assets', 'copilot-instructions.md']],
    ['opencode(agents)', ['opencode-assets', 'root', 'AGENTS.md']],
    ['opencode(rules)', ['opencode-assets', 'root', '.opencode', 'ai-factory.md']],
    ['opencode(skill)', ['opencode-assets', 'root', '.opencode', 'skill', 'ai-factory', 'SKILL.md']],
    ['opencode(config)', ['opencode-assets', 'opencode.config.json']],
  ]) ok(existsSync(join(ROOT5, ...p)), 'KI-O5: the ' + ctl + ' host asset ships in-tree at ' + p.join('/'));
  const ocSkill5 = readFileSync(join(ROOT5, 'opencode-assets', 'root', '.opencode', 'skill', 'ai-factory', 'SKILL.md'), 'utf8');
  ok(/^---\nname: ai-factory\n/.test(ocSkill5) && /^description: /m.test(ocSkill5),
    'KI-O5: the OpenCode skill carries the frontmatter opencode\'s loader requires — a skill with no description is filtered out and never surfaced to the model, i.e. installed but permanently invisible');
  ok(/runtime\.mjs/.test(ocSkill5) && !/Workflow tool/.test(ocSkill5),
    'KI-O5: the OpenCode skill drives the _workflow/opencode/ binding — it must NOT tell a session with no Workflow tool to launch a run-script (the Claude skill\'s loop is not portable)');
  ok(/Task/.test(ocSkill5) && /never played inline/.test(ocSkill5),
    'KI-O5: the skill mandates independent Task subagents per role — the invariant KI-O4 records Copilot as unable to honour, and the reason OpenCode is a stronger controller than Copilot for this engine');

  // --- init.mjs actually wires step 4c (a lib nobody calls installs nothing) ---
  const init5 = readFileSync(join(ROOT5, 'setup', 'init.mjs'), 'utf8');
  ok(init5.includes("flags['no-opencode-assets']") && init5.includes("join(src, 'root'), repoRoot"),
    'KI-O5: init.mjs installs opencode-assets/root onto the HOST ROOT and honours --no-opencode-assets');
  ok(init5.includes('mergeOpencodeConfig') && init5.includes('OPENCODE_CONFIG_CANDIDATES'),
    'KI-O5: init.mjs merges the fragment through the pinned helper rather than re-implementing the ordering rule at the call site');
  ok(/REFUSING to touch/.test(init5) && init5.includes(".factory-new'"),
    'KI-O5: an unparseable or unmergeable host opencode.json is refused with the factory block written alongside — never clobbered');
  ok(init5.includes('--no-opencode-assets') && init5.includes('--no-copilot-assets') && init5.includes('--no-claude-assets'),
    'KI-O5: all three controller seams are independently skippable, and --help says so');

  // --- BOM tolerance: live-caught before shipping, on a host file this repo's own test wrote ---
  // readFileSync(p,'utf8') does not strip a UTF-8 BOM and JSON.parse rejects one, so a host
  // opencode.json saved by PowerShell 5.1 / older Visual Studio / Notepad read as "unparseable"
  // and got the REFUSING-to-touch path — the factory's OpenCode policy would then silently never
  // install on exactly the Windows hosts install.mjs exists to serve.
  eq(HI.stripBom('\uFEFF{"a":1}'), '{"a":1}', 'KI-O5: stripBom removes a leading UTF-8 BOM');
  eq(HI.stripBom('{"a":1}'), '{"a":1}', 'KI-O5: stripBom is identity on a BOM-less body');
  eq(HI.parseJsonFile('\uFEFF{"model":"x"}'), { model: 'x' }, 'KI-O5: a BOM-prefixed host config parses instead of being refused as corrupt');
  ok((() => { try { HI.parseJsonFile('{nope'); return false; } catch { return true; } })(),
    'KI-O5: genuinely malformed JSON still THROWS — BOM tolerance must not swallow a real parse failure into a silent clobber');
  ok(readFileSync(join(ROOT5, 'setup', 'init.mjs'), 'utf8').includes('parseJsonFile(readFileSync(found'),
    'KI-O5: init.mjs reads the HOST config through the BOM-tolerant parser (the fix has to be at the call site that actually reads host files)');

  // --- pickLatestReleaseTag: the resolution install.mjs shares with install.sh's grep|sort -V ---
  const refs5 = ['abc\trefs/tags/v1.0.0', 'abc\trefs/tags/v1.10.0', 'abc\trefs/tags/v1.9.0', 'abc\trefs/tags/v2.0.0-rc1', 'abc\trefs/tags/v20250101', 'abc\trefs/tags/1.2.3'].join('\n');
  eq(HI.pickLatestReleaseTag(refs5), 'v1.10.0', 'KI-O5: strict vX.Y.Z only, semver-ordered — v1.10.0 beats v1.9.0 (a lexical sort would not), and a pre-release / date-like / unprefixed tag never wins (KI-E52 parity)');
  eq(HI.pickLatestReleaseTag(''), null, 'KI-O5: no strict release tags -> null (the caller falls back to main with a notice, never to a guess)');
  eq(HI.pickLatestReleaseTag('abc\trefs/tags/v2.0.0-rc1'), null, 'KI-O5: a repo with ONLY pre-releases resolves to null, not to the rc');
  ok(HI.compareSemver('v1.2.0', 'v1.10.0') < 0 && HI.compareSemver('v2.0.0', 'v1.99.99') > 0 && HI.compareSemver('v1.2.3', 'v1.2.3') === 0,
    'KI-O5: compareSemver orders by numeric component, which is what the upgrade downgrade-guard keys off');

  // --- install.mjs: the Node twin keeps install.sh's safety contracts ---
  const inst5 = readFileSync(join(ROOT5, 'setup', 'install.mjs'), 'utf8');
  ok(inst5.includes('runSelftest(mount)') && (inst5.match(/runSelftest\(mount\)/g) || []).length >= 2,
    'KI-O5: install AND upgrade are both selftest-gated (install.sh parity)');
  ok(inst5.includes('ROLLING BACK') && inst5.includes("'checkout', '--quiet', prev"),
    'KI-O5: a red selftest on upgrade ROLLS BACK to the previous ref rather than leaving the host on a broken engine');
  ok(inst5.includes('VENDORED'), 'KI-O5: a vendored (.git-less) mount is refused, never half-upgraded');
  ok(inst5.includes('already installed at') && inst5.includes('rmSync(created'),
    'KI-O5: a failed install removes the mount it created, so the "already installed" check cannot block the corrective re-run');
  ok(inst5.includes('runInit(mount, hostOfMount(mount))'),
    'KI-O5: upgrade re-runs init.mjs — an engine upgrade that skipped it would leave every host on new code behind old controller pointers');
  ok(inst5.includes("if (flags.host)") && /never the tree it happens to live in/.test(inst5),
    'KI-O5: an explicit --host beats the script\'s own location (the E2E-caught redirect bug install.sh documents)');
  ok(!/execFileSync\(\s*['"]bash/.test(inst5) && !inst5.includes("run('bash'"),
    'KI-O5: install.mjs never shells bash — that is the entire reason it exists (Windows hosts without Git Bash/WSL)');
  ok(inst5.includes("'--no-claude-assets'") && inst5.includes("'--no-copilot-assets'") && inst5.includes("'--no-opencode-assets'"),
    'KI-O5: install.mjs delegates every host-side install to init.mjs — one implementation of the three controller seams, not two that can drift');
  ok(/telemetry/i.test(inst5) && inst5.includes('install.sh telemetry-up'),
    'KI-O5: the telemetry gap is DISCLOSED and points at the bash path, rather than silently omitted (KI-E40 posture: a missing capability must announce itself)');
}

// KI-E91 (2026-08-28, ported from a host-mount session) — LedgerAnchor pure-function coverage +
// pipeline wiring pins. This repo has no schema-parity forcing test and no registration-drift
// precedent (KI-E77 was never ported here), so the opencode side ships as a disclosed gap
// (LEDGER_ANCHOR_SCHEMA exported for documentation, not routed) — see schemas.mjs's own comment.
{
  const { extractAddedAnchors, findAnchorBody, findDuplicateAnchors, extractTagClaims, fileHasStandardsEvolutionTag, findLedgerAnchorCandidates } = await import('./ledger-anchor.mjs');
  eq(extractAddedAnchors('+### cps-in-suite-host\n+some prose\n').map((a) => a.anchor), ['cps-in-suite-host'], 'KI-E91: extractAddedAnchors finds a top-level (###) added heading');
  eq(extractAddedAnchors('+#### cps-stub\n').map((a) => a.level), [4], 'KI-E91: a #### heading is level 4 (a per-service stub, never compared against a top-level entry)');
  eq(extractAddedAnchors('-### removed-one\n unchanged line\n').length, 0, 'KI-E91: only + (added) lines count — a removed or unchanged heading is not "added or edited"');
  eq(extractAddedAnchors('+++ b/some/STANDARDS-DIVERGENCE-LEDGER.md\n+### real-anchor\n').map((a) => a.anchor), ['real-anchor'], 'KI-E91: the diff\'s own "+++ b/file" header line is never mistaken for a heading');
  const LEDGER_A = '# Ledger A\n\n### cps-ef-persistence-row-poco\n\n- **Created:** 2026-06-03\n- **Standard:** rule-a\n\n---\n';
  const LEDGER_B = '# Ledger B\n\n### cps-ef-persistence-row-poco\n\n- **Created:** 2026-06-05\n- **Standard:** rule-b\n\n---\n';
  eq(findAnchorBody(LEDGER_A, 'cps-ef-persistence-row-poco', 3).includes('2026-06-03'), true, 'KI-E91: findAnchorBody extracts the full body from the heading to the next heading/EOF');
  eq(findAnchorBody(LEDGER_A, 'no-such-anchor', 3), null, 'KI-E91: an absent anchor returns null, not an empty string or throw');
  eq(findAnchorBody(LEDGER_A, 'cps-ef-persistence-row-poco', 4), null, 'KI-E91: a level mismatch (### vs ####) is treated as absent — the sanctioned stub-vs-top-level pattern is never a candidate');
  const dupCPS = findDuplicateAnchors('A.md', extractAddedAnchors('+### cps-ef-persistence-row-poco\n'), { 'A.md': LEDGER_A, 'B.md': LEDGER_B }, ['A.md', 'B.md']);
  eq(dupCPS, [{ anchor: 'cps-ef-persistence-row-poco', level: 3, fileA: 'A.md', fileB: 'B.md' }], 'KI-E91: live-incident-shaped repro — the same anchor added as a top-level entry in one ledger, already present at the same level in the sibling, IS a duplicate candidate');
  eq(findDuplicateAnchors('A.md', extractAddedAnchors('+### cps-ef-persistence-row-poco\n'), { 'A.md': LEDGER_A }, ['A.md']), [], 'KI-E91: a SINGLE configured ledger path always yields zero duplicate candidates (this repo\'s current reality — correct degrade, not a bug)');
  const stubBody = '#### cps-per-service-stub\n\nSee `### cps-ef-persistence-row-poco` above.\n';
  eq(findDuplicateAnchors('A.md', [{ anchor: 'cps-ef-persistence-row-poco', level: 4 }], { 'A.md': stubBody, 'B.md': LEDGER_B }, ['A.md', 'B.md']), [], 'KI-E91: a #### stub in one file vs a ### top-level entry in the sibling (different levels) is the SANCTIONED pattern, never a duplicate candidate');
  const legacySitesBody = '### some-entry\n\n- **Legacy sites:** `saas/Foo/Bar.cs:12` and `saas/Foo/Baz.cs`\n- **Status:** all call-site references carry the `standards-evolution:` tag\n';
  eq(extractTagClaims(legacySitesBody).sort(), ['saas/Foo/Bar.cs', 'saas/Foo/Baz.cs'], 'KI-E91: extractTagClaims pulls path tokens from a Legacy sites bullet, stripping a trailing :line');
  eq(extractTagClaims('### x\n\nNo claim here, just prose about `some/file.cs` in passing.\n'), [], 'KI-E91: a bare backtick-quoted path with no Legacy-sites context and no "carries the tag" claim phrase is NOT extracted (avoids over-triggering on incidental file mentions)');
  eq(extractTagClaims(''), [], 'KI-E91: empty body -> no claims, no throw');
  eq(fileHasStandardsEvolutionTag('/// EF Core (ADR-CPS-11 / ledger cps-x). Append-only.'), false, 'KI-E91: a narrative XML-doc mention is NOT the canonical tag (this IS the live CPS-H-15 defect: prose citing an anchor is not the same as the standards-evolution: tag)');
  eq(fileHasStandardsEvolutionTag('// standards-evolution: legacy of code-style.md — see LEDGER.md#x'), true, 'KI-E91: the real canonical tag string is detected');
  eq(fileHasStandardsEvolutionTag(null), false, 'KI-E91: a missing/unreadable file (null text) reads as tag-absent, never throws');
  const orch = findLedgerAnchorCandidates('A.md', '+### cps-ef-persistence-row-poco\n', { 'A.md': LEDGER_A, 'B.md': LEDGER_B }, ['A.md', 'B.md']);
  eq(orch.dup.length, 1, 'KI-E91: findLedgerAnchorCandidates orchestrates dup-finding end to end');
  eq(orch.tagClaims, [], 'KI-E91: the synthetic LEDGER_A fixture makes no tag claim in this entry, so tagClaims is empty — not a false positive');

  const fsrc91 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(fsrc91.includes('const LEDGER_ANCHOR_SCHEMA') && fsrc91.includes("call('ledger-anchor-probe'"), 'KI-E91: factory declares LEDGER_ANCHOR_SCHEMA + runs the haiku ledger-anchor-probe');
  ok(fsrc91.includes("' ledger-anchor ' + wtPath"), 'KI-E91: the probe invokes build-test.sh ledger-anchor on the worktree');
  ok(fsrc91.includes('typeof la.clean'), 'KI-E91: only an EXPLICIT boolean verdict acts (a malformed/unavailable probe never sinks an item)');
  ok(fsrc91.indexOf("call('leftover-probe'") < fsrc91.indexOf("call('ledger-anchor-probe'"), 'KI-E91: the ledger-anchor probe call runs AFTER the leftover-probe call');
  ok(fsrc91.indexOf("call('ledger-anchor-probe'") < fsrc91.indexOf('// 5. REVIEW band'), 'KI-E91: the ledger-anchor probe runs strictly BEFORE the review/gate band');
  ok(fsrc91.includes('const ledgerTouch = (item.files || []).some'), 'KI-E91: ledgerTouch is computed from declared item.files, gating the probe off for non-ledger-touching items at zero cost');

  const btsrc91 = readFileSync(join(import.meta.dirname, '..', '..', 'verify', 'build-test.sh'), 'utf8');
  ok(btsrc91.includes('ledger-anchor-lint.mjs'), 'KI-E91: build-test.sh wires the ledger-anchor subcommand to the CLI');
  ok(/^\s*[a-z|-]*\bledger-anchor\b[a-z|-]*\)/m.test(btsrc91), 'KI-E91: ledger-anchor joins the engine-owned lint case (runs before the host-override seam, same as leftovers/comments; membership-pinned, KI-E104)');

  // KI-E112: this used to assert the OPPOSITE — that schemas.mjs still carried a 'NOT yet ported'
  // disclosure for this stage. That was a disclosure gate (enforce the gap is admitted), correct
  // while the gap existed. The gap is now closed, so the honest assertion is that the stage is
  // actually DISPATCHED; leaving the old pin would have required keeping a false comment alive to
  // satisfy it. The KI-E103 parity gate is the durable check — this one just pins the wiring.
  const schsrc91 = readFileSync(join(import.meta.dirname, '..', 'opencode', 'schemas.mjs'), 'utf8');
  const rtsrc91 = readFileSync(join(import.meta.dirname, '..', 'opencode', 'runtime.mjs'), 'utf8');
  ok(schsrc91.includes('export const LEDGER_ANCHOR_SCHEMA') && !schsrc91.includes('NOT yet ported'), 'KI-E91/KI-E112: opencode schemas.mjs exports LEDGER_ANCHOR_SCHEMA and no longer carries a stale not-yet-ported disclosure');
  ok(rtsrc91.includes("phase === 'ledger_anchor_classify'") && rtsrc91.includes("'ledger-anchor'"), 'KI-E91/KI-E112: the opencode runtime actually DISPATCHES the ledger-anchor stage (mechanical lint + classify), so the schema is live input rather than documentation');
}

// KI-E93/94/95/96 (2026-08-28, ported from a host-mount session) — five defect classes that
// shipped past every gate/probe currently in the pipeline get a PREVENTION self-check in the
// authoring briefs, not just another detection layer. Pin the new guidance text so it can't
// silently regress out of the briefs.
{
  const fixerMd93 = readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'fixer.md'), 'utf8');
  const testAuthorMd93 = readFileSync(join(import.meta.dirname, '..', '..', 'agents', 'test-author.md'), 'utf8');
  ok(testAuthorMd93.includes('MULTI-TARGET COVERAGE SELF-CHECK (KI-E93)'), 'KI-E93: test-author brief carries the multi-target coverage self-check');
  ok(fixerMd93.includes('SIBLING-PATTERN SWEEP (KI-E94)'), 'KI-E94: fixer brief carries the sibling-pattern sweep');
  ok(fixerMd93.includes('DEAD-CODE SELF-CHECK (KI-E94)'), 'KI-E94: fixer brief carries the dead-code self-check');
  ok(fixerMd93.includes('NO-INVENTION SELF-CHECK (KI-E95)'), 'KI-E95: fixer brief carries the no-invention self-check');
  ok(fixerMd93.includes('ADJACENT-CLAIM RE-CHECK (KI-E95)'), 'KI-E95: fixer brief carries the adjacent-claim re-check');
  ok(fixerMd93.includes('CANCELLATIONTOKEN CHAIN SELF-CHECK (KI-E96)'), 'KI-E96: fixer brief carries the CancellationToken chain self-check');
  ok(fixerMd93.indexOf('9. **RE-FIX') < fixerMd93.indexOf('10. **SIBLING-PATTERN SWEEP'), 'KI-E94: sibling-pattern sweep is numbered AFTER the existing RE-FIX step, not spliced ahead of it');
  ok(fixerMd93.indexOf('10. **SIBLING-PATTERN SWEEP') < fixerMd93.indexOf('11. **CANCELLATIONTOKEN'), 'KI-E96: CancellationToken self-check follows the sibling-pattern sweep in list order');
}

// KI-E132 (ported from a host-mount session, 2026-09-04) — fold's P1 verificationOnly branch read
// r.verificationOnly, a copy embedded in the checkpoint/result object at whatever point it was
// captured. It goes STALE when an item is re-claimed for a later, redundant re-verification round:
// that round's fresh test.json/verify-red-raw.txt overwrite the very files P1 reads, but nothing
// ever updates the embedded r.verificationOnly it also reads — so a fully-gate-APPROVED item's
// legitimate "still passes, exit=0" re-confirmation gets folded as if it were a normal lane's
// vacuous test. Live on the origin host: three fully-approved closes folded to FAILED by this bug
// alone. Fix: re-derive from the on-disk test.json (same freshness tier as verify-red-raw.txt, read
// via the same readIf) and prefer it on disagreement. driver.mjs has no exports (a CLI script, not
// a module) — this pins the corrected SHAPE at the source level, the same convention every other
// driver.mjs-internal behavior in this suite already uses.
{
  const dsrc132 = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  const p1Start = dsrc132.indexOf('// P1 — RED proof:');
  ok(p1Start > 0, 'KI-E132: the P1 RED-proof block is still findable by its own comment anchor');
  const p1Block = dsrc132.slice(p1Start, p1Start + 4200);
  ok(p1Block.includes("readIf('test.json')"), 'KI-E132: P1 re-reads test.json fresh from disk, the same freshness tier as verify-red-raw.txt');
  ok(/const diskVO = !!\(tj\.verificationOnly === true && !tj\.red\)/.test(p1Block), 'KI-E132: the on-disk verificationOnly is recomputed with the SAME formula factory.js uses in the first place (test.verificationOnly===true && !test.red), not trusted as a bare flag');
  ok(/if \(diskVO !== effectiveVO\)/.test(p1Block), 'KI-E132: a mismatch between the embedded flag and the on-disk file is DETECTED and logged, not silently overwritten');
  ok(p1Block.includes('effectiveVO = diskVO;'), 'KI-E132: and the on-disk value WINS the disagreement — it is the live test-author attestation, the embedded copy is not');
  ok(!/if \(r\.verificationOnly === true\)/.test(p1Block), 'KI-E132: the branch condition no longer reads the possibly-stale r.verificationOnly directly');
  ok(p1Block.includes('if (effectiveVO) {'), 'KI-E132: the branch now decides on the re-derived value');
  ok(p1Block.includes('r.verificationOnly = effectiveVO;'), 'KI-E132: the embedded flag is written back so the LATER P9/filesChanged checks (which also read r.verificationOnly) see the corrected value too');
  ok(p1Block.includes('try {') && p1Block.includes('catch { /* unparseable test.json'), 'KI-E132: an unparseable/absent test.json falls back to the embedded flag rather than throwing or defaulting to false');
}

// KI-E134 (ported from a host-mount session, 2026-09-04) — PREVENTION guard: every build-test.sh
// subcommand that takes a worktree-rooted path and invokes dotnet now refuses to run unless that
// path resolves under state/worktrees/<id>/. Real behavioral tests (actual script invocation, real
// exit codes / stderr), not source-text pins — this is the mechanism directly motivated by the
// origin session's repeated main-tree contamination incidents.
{
  const { mkdtempSync: mkH, mkdirSync: mdH, rmSync: rmH } = await import('node:fs');
  const { tmpdir: tdH } = await import('node:os');
  const { join: jH } = await import('node:path');
  const { execFileSync: exH } = await import('node:child_process');
  const btPathH = join(import.meta.dirname, '..', '..', 'verify', 'build-test.sh');
  const runBt = (args, cwd) => {
    try { const out = exH('bash', [btPathH, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }); return { code: 0, stdout: out, stderr: '' }; }
    catch (e) { return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
  };

  // A cwd OUTSIDE any state/worktrees/ tree — the four dotnet-invoking subcommands must refuse
  // before touching anything.
  const outsideH = mkH(jH(tdH(), 'bt134-outside-'));
  for (const args of [['build', 'SomeProject.sln'], ['red', 'SomeProject.sln', 'SomeFilter'], ['filter', 'SomeProject.sln', 'SomeFilter'], ['suite', 'SomeProject.sln']]) {
    const r = runBt(args, outsideH);
    eq(r.code, 65, `KI-E134: '${args[0]}' from OUTSIDE any worktree refuses with exit 65, not a silent wrong-tree operation`);
    ok(r.stderr.includes('FACTORY::WORKTREE-GUARD::REFUSED'), `KI-E134: '${args[0]}'s refusal is announced on stderr with the guard marker`);
  }
  // `claims` (a read-only git/node lint, not a dotnet invocation) is DELIBERATELY not guarded — a
  // placeholder/non-worktree path is a legitimate way to exercise its wiring, and it fails (or
  // degrades) for its own reason, never the guard's. Confirm the narrower scope is pinned, not just
  // documented.
  const rClaims = runBt(['claims', 'SomeNonexistentWorktree'], outsideH);
  ok(!rClaims.stderr.includes('WORKTREE-GUARD'), 'KI-E134: `claims` (a read-only lint, no dotnet invocation) is NOT guarded — it fails for its own reason, never the guard\'s');

  // A cwd INSIDE a (fake) state/worktrees/<id>/ tree — the guard passes; whatever happens next is a
  // REAL dotnet failure (bogus project), never the guard's exit 65.
  const insideParentH = jH(tdH(), 'bt134-fake-mount', 'state', 'worktrees');
  mdH(insideParentH, { recursive: true });
  const insideH = mkH(jH(insideParentH, 'FAKE-ITEM-'));
  const rBuild = runBt(['build', 'NoSuchProject.sln'], insideH);
  ok(rBuild.code !== 65 || !rBuild.stderr.includes('WORKTREE-GUARD'), 'KI-E134: from INSIDE a state/worktrees/<id>/ tree, the guard passes (a bogus project fails for its OWN reason, not the guard)');

  // An explicit ABSOLUTE state/worktrees/... path is accepted even when cwd is OUTSIDE any worktree —
  // this is the controller's own usage pattern (invoked from the factory root).
  const rAbs = runBt(['build', jH(insideH, 'NoSuchProject.sln')], outsideH);
  ok(rAbs.code !== 65 || !rAbs.stderr.includes('WORKTREE-GUARD'), 'KI-E134: an absolute state/worktrees/-rooted target passes the guard regardless of cwd — the controller\'s own invocation style stays supported');

  rmH(outsideH, { recursive: true, force: true });
  rmH(jH(tdH(), 'bt134-fake-mount'), { recursive: true, force: true });
}

// KI-E134 exec-smoke (ported from a host-mount session, 2026-09-04) — the plan-steps nudge must
// ACTUALLY fire and feed into STEP mode, not just pin as source text (a TDZ/reference/shape crash
// in a newly-added branch is invisible to `node --check` and to every source-text assertion). Live
// motivation on the origin host: two items in one batch both died in PROSE mode with "no evidence
// in the diff after one bounded amend" — a STEP-mode probe would have named the exact missing piece
// instead of a vague prose match.
{
  const src134 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  let planCallCount134 = 0;
  const { result: res134, calls: calls134 } = await execSmoke(src134, smokeBatch(), {
    agentOverride: (prompt, opts) => {
      if ((opts && opts.label) === 'SMOKE-CODE:planner') {
        planCallCount134++;
        if (planCallCount134 === 1) {
          // the INITIAL call: commitment language present, but steps under the 2-entry floor.
          return { rootCause: 'stub', approach: 'The fix MUST thread the CancellationToken through the repository call.', steps: [], files: [], testStrategy: 'stub', blastRadius: 'stub', ruleRisks: 'stub', recommendEscalate: false, recommendScopeStop: false };
        }
        // the NUDGE call: supply real decomposition.
        return { steps: ['Thread the CancellationToken through OrderService.SubmitAsync', 'Thread it through the downstream repository call', 'Add a regression test asserting cancellation propagates'], note: 'decomposed on request' };
      }
      return undefined;
    },
  });
  eq(planCallCount134, 2, 'KI-E134 exec-smoke: a plan with commitment language and no steps triggers exactly ONE nudge call (never a loop)');
  const plannerCalls134 = calls134.filter((c) => c.label === 'SMOKE-CODE:planner');
  eq(plannerCalls134.length, 2, 'KI-E134 exec-smoke: exactly two SMOKE-CODE:planner calls are recorded — the initial plan plus the one nudge follow-up');
  const by134 = Object.fromEntries((res134.results || []).map((r) => [r.id, r]));
  ok(by134['SMOKE-CODE'] && by134['SMOKE-CODE'].gateDetails && by134['SMOKE-CODE'].gateDetails['probe:plan-commitment-scan'] && by134['SMOKE-CODE'].gateDetails['probe:plan-commitment-scan'].headline.includes('[STEP mode]'),
    'KI-E134 exec-smoke: the nudged steps feed into the SAME plan object the probe reads — STEP mode engages instead of falling through to the weaker PROSE mode');
  ok(!(res134.results || []).some((r) => String(r.note || '').startsWith('runItem threw')), 'KI-E134 exec-smoke: no runItem crash (KI-L36 class) — the new branch is shape-safe under the Workflow AsyncFunction execution model');

  // The common case (default stub already returns 2+ steps, no commitment language needed to trigger
  // it either way) must NOT spend a second call — every pre-existing exec-smoke call-count assertion
  // elsewhere in this suite already regression-covers this: if the nudge over-fired on an unrelated
  // item/lane, those counts would shift and this suite would fail elsewhere.
  ok(!/if \(plan && item\.priorAttempt\)/.test(src134), 'KI-E134: sanity — the nudge gate reads freshPlanCall, not a re-derived priorAttempt check (avoids two sources of truth for the same condition)');
  ok(/const freshPlanCall = !\(item\.priorAttempt && item\.priorAttempt\.plan\)/.test(src134), 'KI-E134: a KI-E69 reused plan is excluded from the nudge — re-asking about a PRIOR call\'s authorship makes no sense, and reuse exists specifically to skip the planner call for cost');

  // Ported to the opencode runtime too (the schema-parity gate — Fix #20 in opencode/_selftest.mjs —
  // requires every factory.js *_SCHEMA to have a byte-identical schemas.mjs counterpart, COMMENT_SCHEMA
  // being the one sanctioned exception for a genuine architectural reason that does not apply here).
  // That runtime has no KI-E69 reuse concept at all (grepped: zero priorAttempt references), so every
  // plan call there is inherently "fresh" — no equivalent guard needed on that side.
  const rt134 = readFileSync(join(import.meta.dirname, '..', 'opencode', 'runtime.mjs'), 'utf8');
  const sc134 = readFileSync(join(import.meta.dirname, '..', 'opencode', 'schemas.mjs'), 'utf8');
  ok(sc134.includes('export const PLAN_STEPS_NUDGE_SCHEMA') && sc134.includes('PLAN_SCHEMA, PLAN_STEPS_NUDGE_SCHEMA,'), 'KI-E134: opencode/schemas.mjs exports PLAN_STEPS_NUDGE_SCHEMA and registers it in SCHEMAS');
  ok(/if \(phase === 'plan-steps-nudge'\)/.test(rt134), 'KI-E134: opencode/runtime.mjs dispatches the nudge as its own phase (this runtime is an external-dispatch state machine, not a single async function — a new phase is the correct shape, not a nested await)');
  ok(/if \(normalizePlanSteps\(plan\.steps\)\.length < 2 && hasPlanCommitmentLanguage/.test(rt134), 'KI-E134: opencode\'s plan-result handler checks the SAME condition as factory.js before routing to the nudge phase');
  ok(/progress\.phase = 'plan-steps-nudge'/.test(rt134) && /if \(phaseKey === 'plan-steps-nudge'\)/.test(rt134), 'KI-E134: the nudge phase is both entered (on the plan side) and its result consumed (merged into progress.plan) — not a dead-end phase');
  ok(rt134.indexOf("if (phaseKey === 'plan-steps-nudge')") > rt134.indexOf("if (phaseKey === 'plan')"), 'KI-E134: the nudge result-handler is wired AFTER the plan result-handler in source order, matching the phase transition direction');
}

// KI-E146 (ported from a host-mount session) — the KI-E89 unclaimed-drift sweep now also runs at fold
// time, not just when an operator remembers to invoke `main-check` by hand. Source-text pin (matching
// the established rigor for this exact class of WARN-only, never-blocking fold-time detection aid —
// cmdMainCheck's own KI-E89 wiring above is pinned the same way, not with a filesystem-fixture
// integration test): confirms the new block exists inside cmdFold, wires the real REPO_ROOT/MOUNT_REL
// through the same pure helper unclaimedMainDrift (no hand-rolled reimplementation), aggregates
// claimedPaths from every item's OWN main-snapshot.json (not just the one item cmdMainCheck was asked
// about), fails safe (never crashes a fold on a missing/corrupt items dir), and runs BEFORE
// foldResults so a drifting fold's output is never truncated by an exception in the new code.
{
  const drv146 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  const cmdFoldStart146 = drv146.indexOf('function cmdFold(file, flags)');
  ok(cmdFoldStart146 !== -1, 'KI-E146: cmdFold still exists under its expected signature');
  const foldResultsCall146 = drv146.indexOf('const { applied, rejected, skipped } = foldResults(ledger, arr)', cmdFoldStart146);
  ok(foldResultsCall146 !== -1 && foldResultsCall146 > cmdFoldStart146, 'KI-E146: sanity — foldResults call still exists after cmdFold\'s start');
  const cfBody146 = drv146.slice(cmdFoldStart146, foldResultsCall146 + 100);
  ok(cfBody146.includes('KI-E146'), 'KI-E146: the new block is labeled so a reader/grep can find why fold now scans for unclaimed drift');
  const ki146Idx = cfBody146.indexOf('KI-E146');
  const foldResultsIdxInBody = cfBody146.indexOf('const { applied, rejected, skipped } = foldResults(ledger, arr)');
  ok(ki146Idx !== -1 && foldResultsIdxInBody !== -1 && ki146Idx < foldResultsIdxInBody, 'KI-E146: the unclaimed-drift sweep runs BEFORE foldResults is applied, not after');
  ok(cfBody146.includes('unclaimedMainDrift(dirtyMainPaths(REPO_ROOT), MOUNT_REL, claimedPaths)'), 'KI-E146: reuses the real dirtyMainPaths(REPO_ROOT)/MOUNT_REL + the pure unclaimedMainDrift helper — same call shape as cmdMainCheck (KI-E89), no bespoke reimplementation');
  ok(/for \(const d of readdirSync\(itemsRoot,\s*\{\s*withFileTypes:\s*true\s*\}\)\)/.test(cfBody146), 'KI-E146: claimedPaths is aggregated by scanning EVERY item dir, not just a single id — this is the genuinely new part vs cmdMainCheck (which is only ever asked about one id at a time)');
  ok(/readJson\(join\(itemsRoot, d\.name, 'main-snapshot\.json'\)\)/.test(cfBody146), 'KI-E146: reads each item\'s OWN main-snapshot.json (the same claim-time snapshot KI-L65/KI-E50 already trust) rather than re-deriving claimed paths from the ledger or items[].files');
  ok(/catch\s*\{\s*\/\*\s*no snapshot for this item/.test(cfBody146), 'KI-E146: a missing/unreadable snapshot for one item contributes nothing and does not abort the aggregation for the rest — matches cmdMainCheck\'s own per-item tolerance');
  ok(/try\s*\{[\s\S]*unclaimedMainDrift\(dirtyMainPaths\(REPO_ROOT\), MOUNT_REL, claimedPaths\)[\s\S]*\}\s*catch\s*\{\s*\/\*\s*detection aid only/.test(cfBody146), 'KI-E146: the entire sweep is wrapped in try/catch — a fold must never fail (or worse, half-apply) because this new, purely-observational aid threw');
  ok(cfBody146.includes('MAIN-DRIFT unclaimed (KI-E89/E146)'), 'KI-E146: the fold-time warning carries BOTH ids (distinct from cmdMainCheck\'s bare KI-E89 label) so a reader can tell which call site caught it');
  ok(!cfBody146.includes('unlinkSync(') && !cfBody146.includes('rmSync(') && !/execSync\(['"]rm /.test(cfBody146), 'KI-E146: still never auto-repairs (KI-E89\'s own documented reason: cannot distinguish agent contamination from an operator\'s unrelated WIP) — detection only, no deletion path exists in this block');
}

// KI-E149 (ported from a host-mount session) — mechanical write-isolation for the two roles that
// actually mutate a worktree's tracked source (fixer, test-author). Every prior main-tree-
// contamination fix on the origin host was DETECTION after the fact; four live tests there
// established that the Agent/Workflow tool's own `isolation:'worktree'` option mechanically
// REJECTS an Edit/Write call targeting the shared main checkout, while leaving writes to any OTHER
// git worktree (this item's own included), reads anywhere, and Bash-tool writes (tee/redirect/
// heredoc) to ANY path completely unaffected — a real, disclosed gap, not a false sense of
// completeness. See the KI-E149 KNOWN-ISSUES.md entry for the four tests themselves.
{
  const src149 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  // Source-text pins: the helper exists with the right condition, and BOTH the primary and
  // fallback-model opts objects in call() get the flag — a fix that only isolated the primary path
  // would silently stop protecting the fallback route the moment a primary model fell over (KI-D10).
  ok(/function needsWriteIsolation\(role\)/.test(src149), 'KI-E149: the needsWriteIsolation(role) helper exists');
  ok(/needsWriteIsolation\(role\)\s*\{\s*return \(role === 'fixer' \|\| role === 'test-author'\)/.test(src149), 'KI-E149: scoped to exactly the two roles that mutate worktree SOURCE — not every role (a probe/gate/judge never writes source and would only pay the isolated-worktree setup cost for nothing)');
  ok(/A\.policies && A\.policies\.isolateWorktreeWrites === false/.test(src149), 'KI-E149: a host policy escape hatch exists — explicit false is the only way off, so an unset/missing policy defaults ON (this is a safety feature, not an opt-in)');
  ok((src149.match(/if \(needsWriteIsolation\(role\)\) (opts|fb)\.isolation = 'worktree'/g) || []).length === 2, 'KI-E149: BOTH the primary opts AND the KI-D10 fallback opts get the flag in call() — a fix that missed the fallback would silently stop protecting it the moment a primary model degraded');
  ok(/FILE-WRITE ISOLATION IS ACTIVE FOR YOU \(KI-E149\)/.test(src149), 'KI-E149: the role-conditional prompt hint exists, telling the isolated agent how to still reach its ARTIFACTS DIR (via Bash, since that path is outside the worktree the shared prefix already told every role about)');

  // Behavioural: run the real pipeline (execSmoke) against SMOKE-CODE (a codeChange item — fixer
  // and test-author both actually run) and inspect what call() really dispatched, not just what
  // the source text claims it does (KI-L43: a source-text pin cannot catch a TDZ/shape bug in the
  // branch it pins).
  const { calls: calls149 } = await execSmoke(src149, smokeBatch());
  const isolated149 = calls149.filter((c) => c.label === 'SMOKE-CODE:fixer' || c.label === 'SMOKE-CODE:test-author');
  ok(isolated149.length > 0, 'KI-E149 exec-smoke: sanity — SMOKE-CODE actually dispatched fixer/test-author calls');
  ok(isolated149.every((c) => c.isolation === 'worktree'), 'KI-E149 exec-smoke: every real fixer/test-author call carries opts.isolation === "worktree"');
  ok(isolated149.every((c) => /FILE-WRITE ISOLATION IS ACTIVE FOR YOU \(KI-E149\)/.test(c.prompt)), 'KI-E149 exec-smoke: every isolated call actually SEES the hint in its composed prompt (not just a flag with no explanation reaching the agent)');
  const notIsolated149 = calls149.filter((c) => c.label === 'SMOKE-CODE:planner' || /:gate-|:review-/.test(c.label));
  ok(notIsolated149.length > 0, 'KI-E149 exec-smoke: sanity — the same lane also dispatched non-fixer/test-author calls to compare against');
  ok(notIsolated149.every((c) => c.isolation === null), 'KI-E149 exec-smoke: planner/gate/review calls carry NO isolation — this is scoped to the two writer roles, not a blanket lockdown');
  ok(notIsolated149.every((c) => !/FILE-WRITE ISOLATION IS ACTIVE FOR YOU/.test(c.prompt)), 'KI-E149 exec-smoke: non-isolated roles never see the hint either — a leaked hint on a role that is not actually isolated would be actively misleading');

  // The escape hatch: an explicit host policy turns it OFF for every role, not just softens it.
  const offBatch149 = smokeBatch();
  offBatch149.policies = { ...offBatch149.policies, isolateWorktreeWrites: false };
  const { calls: callsOff149 } = await execSmoke(src149, offBatch149);
  const wouldBeIsolated149 = callsOff149.filter((c) => c.label === 'SMOKE-CODE:fixer' || c.label === 'SMOKE-CODE:test-author');
  ok(wouldBeIsolated149.length > 0, 'KI-E149 exec-smoke: sanity — the OFF-policy lane still dispatched fixer/test-author calls');
  ok(wouldBeIsolated149.every((c) => c.isolation === null), 'KI-E149 exec-smoke: isolateWorktreeWrites:false actually turns it off for the roles that would otherwise be isolated (the operator escape hatch really works, not just the source-text condition)');
  ok(wouldBeIsolated149.every((c) => !/FILE-WRITE ISOLATION IS ACTIVE FOR YOU/.test(c.prompt)), 'KI-E149 exec-smoke: with the policy off, the hint does not leak into the prompt either — an agent is never told about a guardrail that is not actually armed');
}

// KI-E150 (ported from a host-mount session) — precise PER-ITEM token attribution. Prompted directly
// by an owner question there ("how many tasks closed since Thursday, tokens per task?") that the
// origin factory could not answer: KI-E23's budget.spent() already tracked real output tokens, but
// only as ONE grand total for the whole Workflow run — every item sharing a batch was invisible
// individually, and the per-item `cost` field only ever counted agent CALLS, never tokens.
// budget.spent() is a SHARED, run-wide counter with no per-call breakdown exposed to this sandbox
// (the Workflow runtime gives a script no other token signal at all) — under concurrent items (the
// normal case, CONC>1), a naive snapshot-before/snapshot-after around one item's whole lifecycle
// would double-count or steal tokens a DIFFERENT item spent during the same wall-clock window. The
// fix: a shared "last claimed" checkpoint (lastSpentGlobal) that every successful agent() completion,
// inside call()'s recordTokens(), reads and atomically advances (no `await` between the read and the
// write, so no other item's completion can interleave inside that step — JS resolves one microtask
// fully before the next runs) — correct under REAL concurrency, not just when items happen to run
// sequentially.
{
  const src150 = readFileSync(join(import.meta.dirname, '..', 'factory.js'), 'utf8');
  ok(/let lastSpentGlobal = /.test(src150), 'KI-E150: the shared token checkpoint exists at top-level (module) scope, outside runItem, so it persists across ALL concurrently-running items in the batch');
  ok(/const recordTokens = function \(\) \{/.test(src150), 'KI-E150: the per-item recordTokens helper exists inside runItem, closing over that item\'s own res object');
  ok(/const now = budget\.spent\(\)\s*\n\s*const delta = now - lastSpentGlobal\s*\n\s*lastSpentGlobal = now/.test(src150), 'KI-E150: the read-then-write is a single synchronous block with no await between reading the counter and advancing the checkpoint — the actual atomicity the whole design depends on');
  ok((src150.match(/tryAgent\(compose\(role, item, extra\), (opts|fb), recordTokens\)/g) || []).length === 2, 'KI-E150: recordTokens is wired as tryAgent\'s onAttempt callback at BOTH call() sites (primary + KI-D10 fallback) — a fix that missed the fallback would silently under-count the moment a primary model degraded, the same gap class KI-E149 already guards against for isolation');
  ok(/if \(onAttempt\) onAttempt\(\)\s*\n\s*if \(r\) return r/.test(src150), 'KI-E150: tryAgent claims tokens for EVERY attempt as it resolves, success or not, BEFORE deciding whether to return — a call that exhausts every retry and returns null still spent real tokens on each try, and claiming only on eventual success would leak those retries\' tokens onto whichever call (quite possibly a DIFFERENT item\'s) happens to claim next');
  ok(/catch \(e\) \{\s*\n(?:[^\n]*\n){0,10}?\s*if \(onAttempt\) onAttempt\(\)/.test(src150), 'KI-E150: a throw (KI-D9 — agent() throws instead of returning null on its own retry-cap/terminal API error) ALSO claims tokens, not only the non-throwing null path — a thrown attempt still spent real tokens up to the point of failure');

  const lsrc150 = readFileSync(join(import.meta.dirname, 'ledger.mjs'), 'utf8');
  ok(/tokensUsed: 0,/.test(lsrc150), 'KI-E150: a new ledger item defaults tokensUsed to 0 (discoverable field, matching cost\'s own {} default) rather than leaving it silently absent');
  ok(/if \(typeof r\.tokensUsed === 'number'\) row\.tokensUsed = \(row\.tokensUsed \|\| 0\) \+ r\.tokensUsed;/.test(lsrc150), 'KI-E150: foldResults ACCUMULATES tokensUsed across attempts, same posture as the pre-existing cost accumulation — a relaunched item\'s lifetime total, not just its last attempt');

  const dsrc150 = readFileSync(join(import.meta.dirname, '..', 'driver.mjs'), 'utf8');
  ok(/tokensUsed: r\.tokensUsed \|\| undefined/.test(dsrc150), 'KI-E150: the item_folded telemetry event carries tokensUsed through — without this, the real per-item number would be computed and persisted to the ledger but invisible to telemetry-report/cost-history consumers');
  ok(/function topTokenItems\(ledger, n\)/.test(dsrc150), 'KI-E150: a topTokenItems helper exists for the cost report\'s new top-10-by-tokens section');

  // Behavioural: every agent() call advances a shared, deterministic counter by a FIXED amount. If the
  // atomic-claim attribution had ANY cross-item contamination, a given item's tokensUsed would NOT
  // exactly equal its own call count times that fixed amount — this discriminates a real bug, it is
  // not just a "the grand total adds up" sanity check that a broken implementation could still pass.
  const PER_CALL_TOKENS_150 = 1000;
  let mockSpent150 = 0;
  const budget150 = { total: null, spent: () => mockSpent150, remaining: () => Infinity };
  // KI-E150: a purely-synchronous override lets makeLimiter's pump() dispatch every concurrent
  // call's underlying "agent resolution" in one contiguous microtask burst — ALL of them increment
  // mockSpent150 before ANY of them reaches its own onAttempt() claim, so whichever claim happens to
  // be first in the resulting queue absorbs the whole burst. That never happens for real agent calls
  // (genuinely different wall-clock completion times mean each call's resolve-then-claim chain drains
  // fully before the next one starts) — crossing a real macrotask boundary here (a 0ms setTimeout)
  // reproduces that same one-at-a-time draining instead of the mock's artificial same-tick pile-up.
  const { result: result150, calls: calls150 } = await execSmoke(src150, smokeBatch(), {
    budget: budget150,
    agentOverride: () => new Promise((resolve) => {
      setTimeout(() => { mockSpent150 += PER_CALL_TOKENS_150; resolve(undefined); }, 0);
    }), // falls through to defaultAgentStub for the actual response shape
  });
  // KI-E150: checkpointProgress (KI-E137) / checkpointResult (KI-L40) also call tryAgent — their
  // labels are `<id>:progress:<stage>` / `<id>:checkpoint`, so they'd otherwise inflate the "expected"
  // count below even though claimTokensSilently deliberately keeps their spend OUT of any item's
  // tokensUsed (same posture as sweep mode's separately-tracked cost). Exclude them from both the
  // per-item expected tally and the grand-total reconciliation, or this test would fail for the wrong
  // reason — asserting a real item's tokensUsed against an expected value inflated by infra overhead.
  // (This repo has only checkpointResult/KI-L40 — checkpointProgress/KI-E137 was not ported here — so
  // only the `:checkpoint` shape ever actually fires below; the `:progress:` half of the predicate is
  // harmless dead weight, kept for byte-parity with the origin check rather than trimmed to what this
  // repo currently exercises.)
  const isCheckpointLabel150 = (label) => { const seg = label.split(':')[1]; return seg === 'progress' || seg === 'checkpoint'; };
  const byItem150 = {};
  for (const c of calls150) {
    if (isCheckpointLabel150(c.label)) continue;
    const id = c.label.split(':')[0]; byItem150[id] = (byItem150[id] || 0) + 1;
  }
  ok(Object.keys(byItem150).length > 1, 'KI-E150 exec-smoke: sanity — the smoke batch dispatched calls for MULTIPLE items sharing the run (the exact scenario the atomic-claim design exists for)');
  const resultsById150 = Object.fromEntries((result150.results || []).map((r) => [r.id, r]));
  let anyChecked150 = false;
  for (const [id, callCount] of Object.entries(byItem150)) {
    const r150 = resultsById150[id];
    if (!r150) continue;
    anyChecked150 = true;
    eq(r150.tokensUsed, callCount * PER_CALL_TOKENS_150, 'KI-E150 exec-smoke: ' + id + '\'s tokensUsed exactly equals its OWN call count (' + callCount + ') times the per-call amount — no cross-item contamination under concurrent Promise.all execution');
  }
  ok(anyChecked150, 'KI-E150 exec-smoke: sanity — at least one item was actually checked against its own call count');
  const checkpointCalls150 = calls150.filter((c) => isCheckpointLabel150(c.label)).length;
  ok(checkpointCalls150 > 0, 'KI-E150 exec-smoke: sanity — the smoke batch actually exercised the checkpoint writers (otherwise the exclusion above is untested)');
  const totalClaimed150 = (result150.results || []).reduce((a, r) => a + (r.tokensUsed || 0), 0);
  eq(totalClaimed150, mockSpent150 - checkpointCalls150 * PER_CALL_TOKENS_150, 'KI-E150 exec-smoke: the SUM of every item\'s tokensUsed plus the checkpoint-writer overhead (deliberately discarded by claimTokensSilently, never attributed to any item) exactly equals the total tokens spent across the whole run — checkpoint overhead is the ONLY intentionally-unattributed spend, and nothing else is lost or double-counted');

  // The default exec-smoke budget stub (spent() always 0, used by every OTHER test in this suite) must
  // stay fully inert for this new field — no existing test's result-shape assertions should ever see a
  // populated tokensUsed they were not written to expect.
  const { result: resultDefault150 } = await execSmoke(src150, smokeBatch());
  ok((resultDefault150.results || []).every((r) => r.tokensUsed === undefined), 'KI-E150 exec-smoke: with the default (non-incrementing) budget stub every OTHER test in this suite already relies on, tokensUsed stays undefined — this feature is fully inert until a host actually wires a real budget');
}

console.log(`\nself-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
