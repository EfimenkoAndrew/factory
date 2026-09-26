import { testRoot } from './_test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_VOCABULARY_VERSION, STAGE_ARTIFACTS, CONTROL_ARTIFACTS, classifyArtifact,
  verificationArtifactName, priorVerificationArtifactName, nativeReceiptArtifactName, evidenceInputArtifactName,
  checkpointInputArtifactName, stageArtifactName, nonCanonicalArtifacts, stageForArtifact } from './artifacts.mjs';
import { prepareVerificationOutput } from './verification-output.mjs';
import { deriveStageTimeline } from './telemetry.mjs';
import { verifyAttemptTranscript } from './driver-integration.mjs';

const hash = 'a'.repeat(64);
const pass = 'run-123_claim-456';
test('producer inventory and accepted historical forms are retained as data', () => {
  const inventory = [...STAGE_ARTIFACTS.map(([n]) => n), ...CONTROL_ARTIFACTS,
    ...['initial', 'integrate'].map(p => verificationArtifactName(p, pass)), verificationArtifactName('final', hash),
    nativeReceiptArtifactName(hash), evidenceInputArtifactName(hash), checkpointInputArtifactName(hash),
    'verify-recovery-recovery-123-claim-456.txt', 'verify-recovery-recovery-123-claim-456-metadata.json',
    'verify-recovery-recovery-123-claim-456-before.json', 'verify-recovery-recovery-123-claim-456-after.json',
    'verify-ProductsService-raw.txt', 'verify-src_ProductsService-raw.txt', 'efmigration-ProductsService-raw.txt',
    stageArtifactName('refute_reaudit', 're-auditor:edge-case'), stageArtifactName('native_checks', 'red-coverage-probe'),
    stageArtifactName('gates_regate', 'review-adversarial'), stageArtifactName('plan_review', 'plan-feasibility-probe'),
    stageArtifactName('shadow_scan', 'consolidated-scan-shadow'), stageArtifactName('plan-steps-nudge', 'planner'),
  ];
  for (const phase of ['initial', 'final', 'integrate']) inventory.push(priorVerificationArtifactName(verificationArtifactName(phase, phase === 'final' ? hash : pass), 12));
  assert.deepEqual(nonCanonicalArtifacts(inventory), []);
  for (const name of inventory) assert.equal(classifyArtifact(name).version, ARTIFACT_VOCABULARY_VERSION);
  for (const name of ['dispatch', 'attempts', 'quarantine-2026-09-23T12-34-56-123Z']) {
    assert.equal(classifyArtifact(name, { type: 'directory' }).canonical, true);
    assert.equal(classifyArtifact(name).canonical, false);
  }
});

test('dynamic vocabulary cannot admit instructions, arbitrary roles, traversal or near-miss digests', () => {
  const junk = ['CLAUDE.md', 'claude.local.md', 'AGENTS.md', 'GEMINI.md', 'copilot-instructions.md', 'opencode.json',
    'review-CLAUDE.md', 'gate-custom.md', 'review-.md', 'RESULT.md', 'native-evidence-no.json',
    'native-evidence-' + 'A'.repeat(64) + '.json', 'evidence-input-' + hash + '.json.bak',
    'checkpoint-input-fake.json', 'verify-final-claim.txt', 'verify-initial-.txt',
    'verify-initial-' + 'x'.repeat(222) + '.txt', 'verify-final-' + hash + '.txt.prior-0',
    'verify-final-' + hash + '.txt.prior-01', 'verify-final-' + hash + '.txt.prior-1.prior-2',
    'stage-anything-planner.json', 'stage-plan-fixer.json', '../plan.md', 'x\\plan.md',
    'plan.md:stream', 'plan.md ', 'plan.md\0', 'verify-raw.txt.tmp.123', 'progress.json.tmp.123'];
  assert.deepEqual(nonCanonicalArtifacts(junk), junk);
  assert.throws(() => verificationArtifactName('final', '../escape'));
  assert.throws(() => nativeReceiptArtifactName('bad'));
  assert.throws(() => stageArtifactName('gates', 'CLAUDE'));
  assert.equal(classifyArtifact('plan.md', { type: 'symlink' }).canonical, false);
  assert.equal(classifyArtifact('plan.md', { version: 99 }).canonical, false);
});

test('real verification archival lifecycle retains prior-N without counting it as current timing', () => {
  const dir = mkdtempSync(join(testRoot, 'archives-'));
  for (const phase of ['initial', 'final', 'integrate']) {
    const identity = phase === 'final' ? hash : pass;
    const name = verificationArtifactName(phase, identity);
    prepareVerificationOutput(dir, identity, phase);
    writeFileSync(join(dir, name), 'first');
    prepareVerificationOutput(dir, identity, phase);
    writeFileSync(join(dir, name), 'second');
    prepareVerificationOutput(dir, identity, phase);
    assert.equal(readFileSync(join(dir, name + '.prior-1'), 'utf8'), 'first');
    assert.equal(readFileSync(join(dir, name + '.prior-2'), 'utf8'), 'second');
    assert.equal(stageForArtifact(name + '.prior-2'), null);
  }
  assert.deepEqual(nonCanonicalArtifacts(readdirSync(dir)), []);
  mkdirSync(join(dir, 'plan.md'));
  const timeline = deriveStageTimeline(dir);
  assert.deepEqual(timeline.flatMap(r => r.files).sort(), readdirSync(dir).filter(n => n.endsWith('.txt')).sort());
});

test('actual resume quarantine block preserves checkpoint -> cached continuation -> fold proof', () => {
  const root = mkdtempSync(join(testRoot, 'quarantine-'));
  const dir = join(root, 'A'); mkdirSync(dir);
  const identity = { runId: 'run', claimId: 'claim', attemptNumber: 1, reservedAt: '2026-01-01T00:00:00Z' };
  const name = verificationArtifactName('integrate', 'run-claim');
  const target = join(root, 'App.sln');
  writeFileSync(target, 'fixture');
  const raw = 'FACTORY::BUILD::START ' + target + '\nFACTORY::SUMMARY::build exit=0 errors=0\n'
    + 'FACTORY::TEST::SUITE::START ' + target + '\nPassed! Failed: 0, Passed: 7, Skipped: 0, Total: 7\nFACTORY::SUMMARY::suite exit=0 failed=0 passed=7 skipped=0\n';
  const result = { id: 'A', ...identity, integrationVerification: { transcript: join(dir, name), passId: 'run-claim' } };
  const retained = { 'progress.json': JSON.stringify(result), [name]: raw,
    [verificationArtifactName('initial', 'run-claim')]: raw,
    [verificationArtifactName('final', hash)]: raw,
    [nativeReceiptArtifactName(hash)]: '{"cached":true}', [evidenceInputArtifactName(hash)]: '{}',
    [checkpointInputArtifactName(hash)]: '{}', [stageArtifactName('gates', 'gate-qa')]: '{"verdict":"APPROVED"}',
    [name + '.prior-1']: 'old', 'verification-contract-input.json': '{}', 'admission-input.json': '{}' };
  for (const [n, bytes] of Object.entries(retained)) writeFileSync(join(dir, n), bytes);
  for (const n of ['CLAUDE.md', 'RESULT.md']) writeFileSync(join(dir, n), 'unrequested');
  mkdirSync(join(dir, 'dispatch')); writeFileSync(join(dir, 'dispatch', 'cached.json'), '{}');
  mkdirSync(join(dir, 'unknown-directory'));
  const source = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    const debrisByItem = [];');
  const end = source.indexOf('    // KI-E69', start);
  assert.ok(start > 0 && end > start);
  const run = new Function('relaunchIds', 'cfg', 'abs', 'join', 'existsSync', 'readdirSync', 'statSync',
    'nonCanonicalArtifacts', 'flags', 'mkdirSync', 'renameSync', 'console', source.slice(start, end));
  run(['A'], { paths: { items: root } }, p => p, join, existsSync, readdirSync, statSync,
    nonCanonicalArtifacts, { quarantine: true }, mkdirSync, renameSync, { log() {} });
  for (const [n, bytes] of Object.entries(retained)) assert.equal(readFileSync(join(dir, n), 'utf8'), bytes, n);
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(dir, 'dispatch', 'cached.json')), true);
  assert.equal(existsSync(join(dir, 'unknown-directory')), true);
  const cached = JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8'));
  const verdict = verifyAttemptTranscript({ result: cached, row: { attemptIdentity: identity }, itemDir: dir,
    worktree: root, repoRoot: root, targets: [target], phase: 'integrate' });
  assert.equal(verdict.pass, true, verdict.reason);
  utimesSync(join(dir, name), new Date('2025-01-01'), new Date('2025-01-01'));
  assert.equal(verifyAttemptTranscript({ result: cached, row: { attemptIdentity: identity }, itemDir: dir,
    worktree: root, repoRoot: root, targets: [target], phase: 'integrate' }).pass, false);
});
