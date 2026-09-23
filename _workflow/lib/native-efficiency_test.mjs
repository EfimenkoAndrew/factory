import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, lstatSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSmoke, smokeBatch, defaultAgentStub } from './_execsmoke.mjs';
import { evidenceIdentity, canonicalJson, EVIDENCE_IDENTITY_VERSION } from './evidence-identity.mjs';
import { validate, SCHEMAS } from '../opencode/schemas.mjs';
import { collectNativeEvidence, persistNativeAdmission, hydrateNativeEvidenceMetadata } from './native-evidence.mjs';
import { completeCommand, completeVerificationTranscript } from './stage-evidence.mjs';
import { completeCommand as portCompleteCommand } from '../opencode/contracts.mjs';
import { commonPromptPrefix, isMinimalPromptRole, selectRoleProfile } from './prompt-context.mjs';
import vm from 'node:vm';
import { prepareVerificationOutput } from './verification-output.mjs';
import { nativeVerificationContract } from './native-verification-contract.mjs';
import { verifyTranscript, observeAdmission } from './driver-integration.mjs';
import { effectiveInfraRequirement } from './effective-infra.mjs';
import { loadPriorAttempt } from './prior-attempt.mjs';
import { missingStageFrom, recoveryFoldSkeleton } from './recover.mjs';
import { applyStallDetection } from './convergence.mjs';
import { nativeCheckpointSnapshot, nativeShellQuote, nativeSchemaValid, nativeJsonWriteInstruction } from './native-checkpoint.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBash } from './bash.mjs';
import { nativeEvidenceRequest, nativeRequestJson, nativeRequestSha256, nativeEvidenceInputName } from './native-evidence-request.mjs';
import { createHash } from 'node:crypto';
import { readRoleBriefs } from './promptpack.mjs';
import { loadPolicies, renderPolicies } from './policy.mjs';

const trustedBriefsDirectory = realpathSync(fileURLToPath(new URL('../../agents/', import.meta.url)));
const hydrationOptions = { trustedBriefsDirectory };
const collectorOutputs = [];

const source = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
const requestSource = readFileSync(new URL('./native-evidence-request.mjs', import.meta.url), 'utf8');
for (const name of ['nativeRequestJson', 'nativeRequestSha256', 'nativeEvidenceRequest', 'nativeEvidenceInputName']) {
  const start = requestSource.indexOf('export function ' + name);
  const end = requestSource.indexOf('\n}', start) + 2;
  assert.ok(source.includes(requestSource.slice(start, end).replace(/^export /, '')), name + ' byte parity');
}
for (const text of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(100000), nativeRequestJson({ text: 'Zażółć 😀\r\n', lone: '\ud800', omitted: undefined })]) {
  assert.equal(nativeRequestSha256(text), createHash('sha256').update(text).digest('hex'));
}
assert.ok(source.includes('const EVIDENCE_IDENTITY_VERSION = ' + EVIDENCE_IDENTITY_VERSION + ';'), 'native version constant pins shared collector version');
assert.ok(source.includes(readFileSync(new URL('./effective-infra.mjs', import.meta.url), 'utf8').trim().replace(/^export /, '')));
const helperSource = readFileSync(new URL('./prompt-context.mjs', import.meta.url), 'utf8');
for (const name of ['selectRoleProfile', 'isMinimalPromptRole', 'commonPromptPrefix']) {
  const start = helperSource.indexOf('export function ' + name);
  const end = helperSource.indexOf('\n}', start) + 2;
  assert.ok(source.includes(helperSource.slice(start, end).replace(/^export /, '')), name + ' byte parity');
}
const checkpointSource = readFileSync(new URL('./native-checkpoint.mjs', import.meta.url), 'utf8');
for (const name of ['nativeCheckpointSnapshot', 'nativeShellQuote', 'nativeSchemaValid', 'nativeJsonWriteInstruction']) {
  const start = checkpointSource.indexOf('export function ' + name);
  const end = checkpointSource.indexOf('\n}', start) + 2;
  assert.ok(source.includes(checkpointSource.slice(start, end).replace(/^export /, '')), name + ' byte parity');
}
assert.equal(completeCommand.toString(), portCompleteCommand.toString());
const pathSource = readFileSync(new URL('./repo-path.mjs', import.meta.url), 'utf8');
assert.ok(source.includes(pathSource.slice(pathSource.indexOf('export function canonicalRepoPath'), pathSource.indexOf('\n}', pathSource.indexOf('export function canonicalRepoPath')) + 2).replace(/^export /, '')));
const promptSandbox = vm.createContext({ A: { briefs: { fixer: 'FIXER-BRIEF', 'gate-qa': 'QA-BRIEF' }, policies: { noNewComments: true }, repoProfiles: { X: 'GENERAL\n## Role: fixer\nFIX-ONLY\n## Role: gate-qa\nQA-ONLY' } }, REPO: '/repo', WT: null, FDIR: '/factory', TPLDIR: 'agents', itemsDir: () => '/artifacts', needsWriteIsolation: r => r === 'fixer', commonPromptPrefix, isMinimalPromptRole, selectRoleProfile });
promptSandbox.buildCommand = () => 'node "/factory/_workflow/opencode/build-lease.mjs" "/factory"';
vm.runInContext(source.slice(source.indexOf('function compose(role, item, extra) {'), source.indexOf('\nfunction planFor(')), promptSandbox);
const pi = { id: 'a', target: 'X', worktree: { path: '/worktree' }, acceptance: 'ACCEPTANCE-CONTEXT', peers: [{ id: 'b', files: ['PEER-CONTEXT'] }] };
const composed = promptSandbox.compose('fixer', pi, 'TASK');
assert.ok(composed.indexOf('FACTORY CONTRACT') < composed.indexOf('HOST POLICY — NO NEW COMMENTS (binding)'));
assert.ok(composed.indexOf('HOST POLICY — NO NEW COMMENTS (binding)') < composed.indexOf('FIXER-BRIEF'));
assert.ok(composed.indexOf('FIXER-BRIEF') < composed.indexOf('GENERAL'));
assert.ok(composed.indexOf('FIX-ONLY') < composed.indexOf('TARGET:'));
assert.ok(!composed.includes('QA-ONLY'));
assert.ok(composed.includes('FILE-WRITE ISOLATION IS ACTIVE'));
for (const role of ['marker-probe', 'red-proof-probe', 'rootcause-probe', 'comment-probe', 'pack-hash-probe', 'main-drift-probe', 'efmigration-probe', 'checkpoint-writer', 'progress-writer']) {
  const p = promptSandbox.compose(role, pi, 'EXACT-COMMAND');
  for (const forbidden of ['ACCEPTANCE-CONTEXT', 'PEER-CONTEXT', 'GENERAL', 'FIXER-BRIEF']) assert.ok(!p.includes(forbidden), role + ' excludes ' + forbidden);
  for (const required of ['ISOLATION', 'TELEMETRY', 'stage_start', 'stage_end', 'STOP_REQUESTED.md', 'OUTPUT CONTRACT', 'EXACT-COMMAND']) assert.ok(p.includes(required), role + ' retains ' + required);
}
for (const role of ['acceptance-probe', 'plan-commitment-probe', 'leftover-probe']) assert.ok(promptSandbox.compose(role, pi, 'TASK').includes('ACCEPTANCE-CONTEXT'));

const transcript = 'FACTORY::BUILD::START X.sln\nFACTORY::SUMMARY::build exit=0 errors=0\nFACTORY::TEST::FILTER::START X.Tests.csproj :: TestClass\nPassed! - Failed: 0, Passed: 2, Skipped: 0\nFACTORY::SUMMARY::filter exit=0\nFACTORY::TEST::SUITE::START X.sln\nFACTORY::SUMMARY::suite exit=0 failed=0 passed=2 skipped=0\n';
assert.equal(completeVerificationTranscript(transcript, { band: 'FULL' }).pass, true);
assert.equal(completeVerificationTranscript(transcript + 'FACTORY::TEST::FILTER::START X.Tests.csproj :: TestClass\n', { band: 'FULL' }).pass, false);
assert.equal(completeVerificationTranscript('', { band: 'FULL' }).pass, false);
assert.equal(completeVerificationTranscript(transcript.replace('Passed: 2', 'Passed: 0'), { band: 'FULL' }).pass, false);
const hash = 'ab'.repeat(32), codeHash = 'cd'.repeat(32);
const identity = { version: EVIDENCE_IDENTITY_VERSION, hash, codeHash, shadowSnapshotHash: null, baseRevision: 'base', fileCount: 2, redProof: { markerFound: true, exitCode: 1 }, rootCause: { nonTestCount: 1, files: ['X/src/Some.cs'], skipped: false }, verification: { pass: true, reason: 'mock completed fresh invocation' }, integration: { pass: true, reason: 'mock completed fresh integration' } };
function batch() { const b = smokeBatch(); b.items = [b.items[1]]; b.policies = {}; return b; }
async function run(b = batch(), override, options = {}) {
  return execSmoke(source, b, { ...options, agentOverride: async (prompt, opts) => {
    const custom = override ? await override(prompt, opts) : undefined;
    if (opts.label.endsWith(':evidence-identity')) {
      const result = custom === undefined ? identity : custom;
      if (!result || Object.hasOwn(result, 'request')) return result;
      const metadata = hydrateNativeEvidenceMetadata(JSON.parse(prompt.split('\n').at(-1)), hydrationOptions);
      return { ...result, request: nativeEvidenceRequest(prompt.match(/^WORKTREE: (.+)$/m)[1], metadata, prompt.match(/^ARTIFACTS DIR: (.+)$/m)[1]) };
    }
    if (custom !== undefined) return custom;
    if (opts.schema?.properties.markerFound) return { markerFound: true, line: 'FACTORY::RED::1' };
  } });
}

const meta = { baseRevision: 'base', acceptance: 'accept', reviewerContract: { role: 'v1' }, entries: [{ path: 'a.cs', content: 'x'.repeat(70000) }, { path: 'a.md', content: 'doc' }] };
const original = evidenceIdentity(meta);
assert.notEqual(original.hash, evidenceIdentity({ ...meta, entries: [{ ...meta.entries[0], content: 'x'.repeat(69999) + 'y' }, meta.entries[1]] }).hash);
assert.equal(original.hash, evidenceIdentity({ ...meta, entries: [...meta.entries].reverse() }).hash);
const prose = evidenceIdentity({ ...meta, entries: [meta.entries[0], { path: 'a.md', content: 'new prose' }] });
assert.notEqual(original.hash, prose.hash);
assert.equal(original.codeHash, prose.codeHash);
assert.notEqual(original.hash, evidenceIdentity({ ...meta, policies: { noSchemaChanges: true } }).hash);
assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
const collected = collectNativeEvidence(process.cwd(), { acceptance: 'read-only fixture', reviewerContract: { version: 'test' } }, join(tmpdir(), 'factory-no-evidence-fixture'), { legacy: true });
assert.match(collected.hash, /^[0-9a-f]{64}$/);
assert.ok(collected.fileCount > 0);
assert.equal(collected.redProof.markerFound, false);

let checkpoints = [];
const first = await run(batch(), (prompt, opts) => {
  if (opts.label.includes(':progress:')) checkpoints.push(JSON.parse(prompt.split('CHECKPOINT-BEGIN\n')[1].split('\nCHECKPOINT-END')[0]));
});
assert.equal(first.result.results[0].toState, 'CLOSED');
for (const invalid of ['../outside', 'a'.repeat(64) + '/../../outside', 'a'.repeat(64) + '\n', 'A'.repeat(64), '', null, {}]) {
  assert.throws(() => nativeEvidenceInputName(invalid), /invalid native evidence request digest/);
}
const writerRun = await run(smokeBatch());
for (const id of ['SMOKE-DOC', 'SMOKE-VONLY', 'SMOKE-CODE']) {
  const prompt = writerRun.calls.find(c => c.label === id + ':test-author').prompt;
  assert.equal(prompt.includes('docker info'), id === 'SMOKE-CODE', id + ' Docker baseline applicability');
  assert.equal(prompt.includes('FULL-SUITE BASELINE (KI-E43)'), id === 'SMOKE-CODE');
  assert.equal(prompt.includes('/baseline-raw.txt'), id === 'SMOKE-CODE');
}
const infraDoc = smokeBatch(); infraDoc.items = [{ ...infraDoc.items[0], realInfra: true }];
const infraDocRun = await run(infraDoc);
assert.equal(infraDocRun.calls.find(c => c.label.endsWith(':test-author')).prompt.includes('REAL-INFRA: this finding'), false);
assert.equal(infraDocRun.calls.find(c => c.label.endsWith(':test-author')).prompt.includes('docker info'), false);
const infraCode = batch(); infraCode.items[0].realInfra = true; infraCode.items[0].reFix = true;
const infraCodeRun = await run(infraCode);
const infraCodePrompt = infraCodeRun.calls.find(c => c.label.endsWith(':test-author')).prompt;
for (const instruction of ['docker info', 'FULL-SUITE BASELINE (KI-E43)', 'RE-FIX EXCEPTION', 'REAL-INFRA: this finding']) assert.ok(infraCodePrompt.includes(instruction));
const writerCalls = writerRun.calls.filter(c => c.opts.phase === 'Checkpoint' || c.label.endsWith(':evidence-identity') || c.prompt.includes('CONTRACT-INPUT-BEGIN\n'));
const writerKinds = new Set();
function writerPayload(call) {
  const { prompt } = call;
  const match = prompt.match(/MANDATORY FILE TOOL ORDER: use the Read tool on ("(?:\\.|[^"\\])*") FIRST/);
  assert.ok(match, call.label + ' names Read before Write on the exact destination');
  const path = JSON.parse(match[1]);
  const marker = prompt.includes('CHECKPOINT-BEGIN\n') ? 'CHECKPOINT' : prompt.includes('CONTRACT-INPUT-BEGIN\n') ? 'CONTRACT-INPUT' : null;
  const json = marker ? prompt.split(marker + '-BEGIN\n')[1].split('\n' + marker + '-END')[0] : prompt.split('\n').at(-1);
  JSON.parse(json);
  const reference = marker === 'CHECKPOINT' ? 'the JSON between CHECKPOINT-BEGIN and CHECKPOINT-END (exclusive)' : marker ? 'the contract input JSON below' : 'the metadata JSON on the final line';
  assert.ok(prompt.includes(nativeJsonWriteInstruction(path, reference)), call.label + ' retains complete retry/skip/no-fallback contract');
  assert.ok(!prompt.includes('overwrite if it exists'));
  if (call.label.endsWith(':evidence-identity')) {
    const request = call.schema.properties.request;
    const digest = request.properties.digest.enum[0];
    assert.equal(path, request.properties.artifactDir.enum[0] + '/' + nativeEvidenceInputName(digest));
    assert.ok(prompt.includes('--expected-request\' \'' + digest + "'"));
    assert.equal(digest, nativeEvidenceRequest(request.properties.worktree.enum[0], hydrateNativeEvidenceMetadata(JSON.parse(json), hydrationOptions), request.properties.artifactDir.enum[0]).digest);
    writerKinds.add('evidence-input');
  } else {
    writerKinds.add(path.split('/').at(-1));
    if (marker === 'CONTRACT-INPUT') assert.ok(prompt.includes('initial "' + path + '"'), 'preparation executes with the same input path');
    if (path.endsWith('/admission-input.json')) assert.ok(prompt.includes('--persist-admission "' + path + '"'));
  }
  return { path, json };
}
const renderedWriters = writerCalls.map(writerPayload);
assert.ok([...writerKinds].some(name => /^checkpoint-input-[0-9a-f]{64}\.json$/.test(name)));
assert.ok(writerKinds.has('evidence-input'));
assert.ok(writerKinds.has('verification-contract-input.json'));
assert.ok(!writerKinds.has('progress.json') && !writerKinds.has('result.json'));
const evidenceCalls = writerCalls.filter(c => c.label === 'SMOKE-CODE:evidence-identity');
assert.ok(evidenceCalls.length >= 2, 'multiple native identity boundaries exercised');
assert.equal(new Set(evidenceCalls.map(c => writerPayload(c).path)).size, evidenceCalls.length, 'each boundary has an immutable request-specific destination');

// Tool-state simulation: a new worker has no Read history, even when a prior worker wrote the file.
const toolFiles = new Map();
function workerTools() {
  const reads = new Map();
  return {
    Read(path) { const value = toolFiles.get(path); reads.set(path, value); return value; },
    Write(path, bytes) {
      if (toolFiles.has(path) && (!reads.has(path) || reads.get(path) !== toolFiles.get(path))) throw new Error('File has not been read yet. Read it first before writing to it.');
      toolFiles.set(path, bytes);
    },
  };
}
function applyWriter({ path, json }) {
  const tools = workerTools(), events = ['Read'];
  if (tools.Read(path) !== json) { tools.Write(path, json); events.push('Write'); }
  assert.equal(toolFiles.get(path), json);
  events.push('Execute');
  return events;
}
for (const writer of renderedWriters) {
  assert.deepEqual(applyWriter(writer), ['Read', 'Write', 'Execute']);
  assert.throws(() => workerTools().Write(writer.path, writer.json), /File has not been read/);
  assert.deepEqual(applyWriter(writer), ['Read', 'Execute'], 'exact replay preserves bytes without rewrite but still executes helper');
  toolFiles.set(writer.path, '{"partial":true}');
  assert.deepEqual(applyWriter(writer), ['Read', 'Write', 'Execute'], 'retry repairs partial bytes after Read');
}
let writeRetry = 0;
const writerRetryRun = await run(batch(), (prompt, opts) => {
  if (opts.label.endsWith(':evidence-identity')) {
    writerPayload({ prompt, ...opts });
    if (writeRetry++ === 0) return { ...identity, hash: 'invalid' };
  }
});
assert.equal(writerRetryRun.result.results[0].toState, 'CLOSED');
const relayRetries = writerRetryRun.calls.filter(c => c.label.endsWith(':evidence-identity'));
assert.equal(writerPayload(relayRetries[0]).path, writerPayload(relayRetries[1]).path, 'bounded relay retry retains request path and Read prerequisite');
const fullBriefBatch = batch();
fullBriefBatch.repoRoot = process.cwd().replaceAll('\\', '/');
fullBriefBatch.templatesDir = 'agents';
fullBriefBatch.briefs = readRoleBriefs(join(process.cwd(), 'agents'));
const fullBriefRun = await run(fullBriefBatch);
assert.equal(fullBriefRun.result.results[0].toState, 'CLOSED');
const fullBriefCall = fullBriefRun.calls.find(c => c.label.endsWith(':evidence-identity'));
const compactMetadata = JSON.parse(fullBriefCall.prompt.split('\n').at(-1));
assert.deepEqual(compactMetadata.reviewerContract.briefs, {});
assert.equal(compactMetadata.relayBriefs.digest, nativeRequestSha256(nativeRequestJson(fullBriefBatch.briefs)));
assert.deepEqual(hydrateNativeEvidenceMetadata(compactMetadata, hydrationOptions).reviewerContract.briefs, fullBriefBatch.briefs);
const bindingCall = first.calls.find(c => c.label.endsWith(':evidence-identity'));
const bindingMetadata = JSON.parse(bindingCall.prompt.split('\n').at(-1));
const requestDir = mkdtempSync(join(tmpdir(), 'native-request-binding-'));
try {
  const worktree = process.cwd();
  const metadata = structuredClone(bindingMetadata);
  metadata.reviewerContract.briefsDirectory = fileURLToPath(new URL('../../agents/', import.meta.url));
  metadata.verificationTranscript = join(requestDir, 'verify-initial-current-claim.txt');
  metadata.requestIdentity.codeChange = false;
  metadata.context.verificationContract = null;
  const request = nativeEvidenceRequest(worktree, metadata, requestDir);
  writeFileSync(metadata.verificationTranscript, 'PASS: current attempt assertion\n');
  writeFileSync(join(requestDir, 'verify-raw.txt'), transcript);
  const good = collectNativeEvidence(worktree, metadata, requestDir, { expectedDigest: request.digest });
  assert.deepEqual(good.request, request);
  assert.equal(good.verification.pass, true);
  const disk = JSON.parse(readFileSync(join(requestDir, 'native-evidence-' + request.digest + '.json'), 'utf8'));
  assert.deepEqual(disk.metadata, metadata);
  assert.deepEqual(disk.result, good);
  assert.equal(good.shadowSnapshotHash, null, 'missing review pack is explicitly null in receipt and stdout');
  collectorOutputs.push(good);
  writeFileSync(join(requestDir, 'review-pack.md'), 'current review pack');
  const withShadow = collectNativeEvidence(worktree, metadata, requestDir, { expectedDigest: request.digest });
  assert.match(withShadow.shadowSnapshotHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(join(requestDir, 'native-evidence-' + request.digest + '.json'), 'utf8')).result, withShadow);
  collectorOutputs.push(withShadow);
  const briefsDirectory = metadata.reviewerContract.briefsDirectory;
  const briefs = readRoleBriefs(briefsDirectory);
  const fullMetadata = { ...metadata, reviewerContract: { ...metadata.reviewerContract, briefs } };
  const relayMetadata = { ...fullMetadata, reviewerContract: { ...fullMetadata.reviewerContract, briefs: {} }, relayBriefs: { directory: briefsDirectory, digest: nativeRequestSha256(nativeRequestJson(briefs)) } };
  assert.deepEqual(hydrateNativeEvidenceMetadata(relayMetadata, hydrationOptions), fullMetadata);
  assert.throws(() => hydrateNativeEvidenceMetadata(relayMetadata), /trustedBriefsDirectory required/);
  assert.throws(() => hydrateNativeEvidenceMetadata({ ...relayMetadata, relayBriefs: { ...relayMetadata.relayBriefs, digest: '0'.repeat(64) } }, hydrationOptions), /digest mismatch/);
  assert.throws(() => hydrateNativeEvidenceMetadata({ ...relayMetadata, relayBriefs: { ...relayMetadata.relayBriefs, directory: requestDir } }, hydrationOptions), /invalid native briefs/);
  const hydratedRequest = nativeEvidenceRequest(worktree, fullMetadata, requestDir);
  const hydratedInput = join(requestDir, nativeEvidenceInputName(hydratedRequest.digest));
  writeFileSync(hydratedInput, JSON.stringify(relayMetadata));
  const hydratedCli = spawnSync(process.execPath, [fileURLToPath(new URL('../native-evidence.mjs', import.meta.url)), worktree, hydratedInput, requestDir, '--expected-request', hydratedRequest.digest], { encoding: 'utf8' });
  assert.equal(hydratedCli.status, 0, hydratedCli.stderr);
  assert.deepEqual(JSON.parse(hydratedCli.stdout).request, hydratedRequest);
  assert.deepEqual(JSON.parse(readFileSync(join(requestDir, 'native-evidence-' + hydratedRequest.digest + '.json'), 'utf8')).metadata, fullMetadata);
  const foreignRelay = structuredClone(relayMetadata);
  foreignRelay.relayBriefs.directory = requestDir;
  foreignRelay.reviewerContract.briefsDirectory = requestDir;
  writeFileSync(hydratedInput, JSON.stringify(foreignRelay));
  const foreignCli = spawnSync(process.execPath, [fileURLToPath(new URL('../native-evidence.mjs', import.meta.url)), worktree, hydratedInput, requestDir, '--expected-request', hydratedRequest.digest], { encoding: 'utf8' });
  assert.equal(foreignCli.status, 1);
  assert.match(foreignCli.stderr, /directory mismatch/);
  assert.equal(foreignCli.stdout, '');
  for (const key of ['verificationTranscript', 'requestIdentity', 'engineMount', 'inputs']) {
    const omitted = structuredClone(metadata); delete omitted[key];
    assert.throws(() => collectNativeEvidence(worktree, omitted, requestDir), /incomplete|verificationTranscript/);
  }
  for (const key of ['routes', 'briefsDirectory', 'briefs']) {
    const omitted = structuredClone(metadata); delete omitted.reviewerContract[key];
    assert.throws(() => collectNativeEvidence(worktree, omitted, requestDir), /incomplete/);
  }
  const wrongAttempt = { ...metadata, verificationTranscript: join(requestDir, 'verify-initial-other-claim.txt') };
  writeFileSync(wrongAttempt.verificationTranscript, 'PASS: unrelated attempt\n');
  assert.throws(() => collectNativeEvidence(worktree, wrongAttempt, requestDir, { expectedDigest: request.digest }), /digest mismatch/);
  const missingFile = { ...metadata, verificationTranscript: join(requestDir, 'missing-attempt.txt') };
  assert.equal(collectNativeEvidence(worktree, missingFile, requestDir).verification.pass, false, 'existing green legacy file cannot rescue missing attempt proof');
  const changedClaim = structuredClone(metadata); changedClaim.requestIdentity.claimId = 'other-claim';
  assert.throws(() => collectNativeEvidence(worktree, changedClaim, requestDir, { expectedDigest: request.digest }), /digest mismatch/);
  const input = join(requestDir, nativeEvidenceInputName(request.digest));
  const cli = fileURLToPath(new URL('../native-evidence.mjs', import.meta.url));
  writeFileSync(input, JSON.stringify(metadata));
  const invoke = flags => spawnSync(process.execPath, [cli, worktree, input, requestDir, ...flags], { encoding: 'utf8' });
  const cliGood = invoke(['--expected-request', request.digest]);
  assert.equal(cliGood.status, 0, cliGood.stderr);
  assert.deepEqual(JSON.parse(cliGood.stdout).request, request);
  assert.equal(invoke([]).status, 1, 'legacy CLI use must be explicit');
  writeFileSync(input, JSON.stringify(wrongAttempt));
  const cliWrong = invoke(['--expected-request', request.digest]);
  assert.equal(cliWrong.status, 1); assert.match(cliWrong.stderr, /digest mismatch/); assert.equal(cliWrong.stdout, '');
  writeFileSync(input, '{');
  assert.equal(invoke(['--expected-request', request.digest]).status, 1);
  writeFileSync(input, JSON.stringify({ acceptance: 'legacy', reviewerContract: {} }));
  assert.equal(invoke(['--legacy']).status, 0);
} finally { rmSync(requestDir, { recursive: true, force: true }); }

const hydrationDir = mkdtempSync(join(tmpdir(), 'native-hydration-boundary-'));
try {
  const trusted = join(hydrationDir, 'agents'), foreign = join(hydrationDir, 'foreign');
  mkdirSync(trusted); mkdirSync(foreign);
  mkdirSync(join(trusted, 'repo-profiles'));
  writeFileSync(join(trusted, 'repo-profiles', 'private.md'), 'must not be hydrated');
  writeFileSync(join(trusted, 'ignored.txt'), 'not a brief');
  const fullBriefs = { fixer: '{ complete 😀 brief }\n'.repeat(3000), runner: 'runner { nested: { full: true } }' };
  for (const [role, text] of Object.entries(fullBriefs)) writeFileSync(join(trusted, role + '.md'), text);
  writeFileSync(join(foreign, 'external.md'), 'external content');
  const relay = directory => ({ reviewerContract: { briefsDirectory: directory, briefs: {} }, relayBriefs: { directory, digest: nativeRequestSha256(nativeRequestJson(fullBriefs)) } });
  let reads = 0;
  const io = { readFileSync: (...args) => { reads++; return readFileSync(...args); } };
  const options = { trustedBriefsDirectory: trusted, io };
  const rejectsUnread = (metadata, override = {}, pattern = /directory mismatch|invalid native brief|outside trusted/) => {
    reads = 0;
    assert.throws(() => hydrateNativeEvidenceMetadata(metadata, { ...options, io: { ...io, ...override } }), pattern);
    assert.equal(reads, 0, 'all paths validated before any brief content read');
  };
  rejectsUnread(relay(foreign));
  rejectsUnread(relay(join(trusted, 'repo-profiles')));
  rejectsUnread(relay(trusted), { readdirSync: () => ['../foreign/external.md'] });
  rejectsUnread(relay(trusted), { realpathSync: path => path === join(trusted, 'runner.md') ? join(foreign, 'external.md') : realpathSync(path) });
  const linkedFile = join(trusted, 'runner.md');
  rejectsUnread(relay(trusted), { lstatSync: path => path === linkedFile ? { isSymbolicLink: () => true } : lstatSync(path) });
  rejectsUnread(relay(trusted), { lstatSync: path => path === trusted ? { isSymbolicLink: () => true } : lstatSync(path) });
  const alias = join(hydrationDir, 'alias');
  symlinkSync(foreign, alias, process.platform === 'win32' ? 'junction' : 'dir');
  rejectsUnread(relay(alias));
  assert.throws(() => hydrateNativeEvidenceMetadata(relay(alias), { trustedBriefsDirectory: alias, io }), /invalid native briefs directory/);
  assert.equal(reads, 0);
  const hydrated = hydrateNativeEvidenceMetadata(relay(trusted), options);
  assert.deepEqual(hydrated.reviewerContract.briefs, fullBriefs);
  assert.equal(reads, 2);
  assert.deepEqual(nativeEvidenceRequest('/worktree', hydrated, '/artifacts'), nativeEvidenceRequest('/worktree', { reviewerContract: { briefsDirectory: trusted, briefs: fullBriefs } }, '/artifacts'));
  assert.throws(() => hydrateNativeEvidenceMetadata(relay(trusted), { ...options, io: { readFileSync: () => { throw new Error('unreadable brief'); } } }), /unreadable brief/);
  let fileLinkCreated = false;
  try { symlinkSync(join(foreign, 'external.md'), join(trusted, 'z-link.md'), 'file'); fileLinkCreated = true; }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  if (fileLinkCreated) rejectsUnread(relay(trusted));

  mkdirSync(join(hydrationDir, 'config'));
  const defaultRendering = renderPolicies({});
  assert.equal(defaultRendering.includes('isolateWorktreeWrites'), false);
  for (const value of [false, true]) {
    writeFileSync(join(hydrationDir, 'config', 'factory.config.local.json'), JSON.stringify({ policies: { isolateWorktreeWrites: value } }));
    assert.equal(renderPolicies(loadPolicies(hydrationDir)), defaultRendering + ' isolateWorktreeWrites=' + (value ? 'on' : 'off'));
  }
  assert.equal(renderPolicies({ isolateWorktreeWrites: undefined }), defaultRendering + ' isolateWorktreeWrites=on');
} finally { rmSync(hydrationDir, { recursive: true, force: true }); }
for (const mutation of [
  r => { delete r.verificationTranscript; },
  r => { r.verificationTranscript = 'wrong-attempt.txt'; },
  r => { r.digest = '01'.repeat(32); },
  r => { r.worktree += '-sibling'; },
  r => { r.artifactDir += '-sibling'; },
]) {
  const mismatch = await run(batch(), (prompt, opts) => {
    if (!opts.label.endsWith(':evidence-identity')) return;
    const request = nativeEvidenceRequest(prompt.match(/^WORKTREE: (.+)$/m)[1], JSON.parse(prompt.split('\n').at(-1)), prompt.match(/^ARTIFACTS DIR: (.+)$/m)[1]);
    mutation(request);
    return { ...identity, request };
  });
  assert.equal(mismatch.result.results[0].toState, 'FAILED');
  assert.equal(mismatch.calls.some(c => /:(gate-|review-)/.test(c.label)), false, 'valid hashes cannot admit mismatched request to expensive reviews');
}
const docBatch = smokeBatch(); docBatch.items = [docBatch.items[0]];
for (const reply of [null, { ...identity, request: null }, { ...identity, verification: { pass: false, reason: 'missing attempt transcript' } }]) {
  const rejected = await run(docBatch, (_p, o) => o.label.endsWith(':evidence-identity') ? reply : undefined);
  assert.equal(rejected.result.results[0].toState, 'FAILED');
  assert.equal(rejected.calls.some(c => /:(gate-|review-)/.test(c.label)), false, 'doc-only evidence failure must also stop before editorial/gates');
}
const obsoleteIdentity = await run(batch(), (_p, o) => o.label.endsWith(':evidence-identity') ? { ...identity, version: 1 } : undefined);
assert.equal(obsoleteIdentity.result.results[0].toState, 'FAILED');
assert.equal(obsoleteIdentity.calls.some(c => c.label.endsWith(':gate-developer')), false);
const identitySchema = first.calls.find(c => c.label.endsWith(':evidence-identity')).schema;
const schemaIdentity = { ...identity, request: nativeEvidenceRequest(bindingCall.prompt.match(/^WORKTREE: (.+)$/m)[1], bindingMetadata, bindingCall.prompt.match(/^ARTIFACTS DIR: (.+)$/m)[1]) };
assert.equal(validate(identitySchema, schemaIdentity).ok, true);
const collectorSchema = structuredClone(identitySchema);
for (const key of Object.keys(collected.request)) delete collectorSchema.properties.request.properties[key].enum;
assert.equal(validate(collectorSchema, collected).ok, true, 'real collector output matches relay schema structure');
function assertExactRelayShape(value, schema) {
  assert.equal(validate(schema, value).ok, true);
  assert.equal(nativeSchemaValid(value, schema), true);
  if (!value || Array.isArray(value) || typeof value !== 'object') return;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort(), 'no optional collector output keys');
  assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort(), 'collector emits every required key');
  for (const key of schema.required) {
    const missing = { ...value }; delete missing[key];
    assert.equal(validate(schema, missing).ok, false, 'relay cannot drop ' + key);
    assert.equal(nativeSchemaValid(missing, schema), false);
    assertExactRelayShape(value[key], schema.properties[key]);
  }
  assert.equal(nativeSchemaValid({ ...value, invented: true }, schema), false);
  assert.equal(validate(schema, { ...value, invented: true }).ok, false);
}
for (const output of [collected, ...collectorOutputs]) assertExactRelayShape(output, collectorSchema);
for (const shadowSnapshotHash of [null, hash]) {
  assertExactRelayShape({ ...schemaIdentity, shadowSnapshotHash, integration: null }, identitySchema);
}
for (const shadowSnapshotHash of ['', 'a'.repeat(40), 'g'.repeat(64), 0, false, {}]) {
  const bad = { ...schemaIdentity, shadowSnapshotHash };
  assert.equal(nativeSchemaValid(bad, identitySchema), false);
  assert.equal(validate(identitySchema, bad).ok, false);
}
const omittedShadow = { ...identity }; delete omittedShadow.shadowSnapshotHash;
const omittedShadowRun = await run(batch(), (_p, o) => o.label.endsWith(':evidence-identity') ? omittedShadow : undefined);
assert.equal(omittedShadowRun.result.results[0].toState, 'FAILED');
assert.equal(omittedShadowRun.calls.some(c => /:(gate-|review-)/.test(c.label)), false);
for (const malformed of [
  { ...identity, hash: 'a'.repeat(40), codeHash: '' },
  { ...identity, hash: 'A'.repeat(64) },
  { ...identity, codeHash: 'g'.repeat(64) },
  { ...identity, verification: { pass: 'true', reason: 'invented' } },
  { ...identity, unexpected: true },
  ...identitySchema.required.map(key => Object.fromEntries(Object.entries(schemaIdentity).filter(([k]) => k !== key))),
]) {
  assert.equal(validate(identitySchema, malformed).ok, false);
  assert.equal(nativeSchemaValid(malformed, identitySchema), false, 'native/port validator parity');
}
assert.equal(nativeSchemaValid({ ...identity, integration: { pass: true } }, identitySchema), false);
for (const version of [1, 2]) {
  assert.equal(validate(identitySchema, { ...identity, version }).ok, false);
  const oldCollector = await run(batch(), (_p, o) => o.label.endsWith(':evidence-identity') ? { ...identity, version } : undefined);
  assert.equal(oldCollector.result.results[0].toState, 'FAILED');
}
assert.equal(first.calls.some(c => /:(red-proof-probe|rootcause-probe)$/.test(c.label)), false);
assert.equal(first.result.attemptObservations.length, first.calls.length);
assert.equal(first.result.attemptObservations.filter(o => o.overhead).length, first.calls.filter(c => c.label.includes(':progress:') || c.label.endsWith(':checkpoint')).length);
const progress = checkpoints.find(c => c.progressStage === 'post-gates');
assert.equal(progress.evidenceIdentity.hash, hash);
assert.ok(progress.attemptObservations.some(o => o.stage.endsWith(':progress:post-gates') && o.outcome === 'started' && o.overhead));
const bReuse = batch(); bReuse.items[0].priorProgress = progress;
const reused = await run(bReuse);
assert.equal(reused.result.results[0].gateBandReused, true);
assert.equal(reused.calls.filter(c => /:gate-(developer|architect)$/.test(c.label)).length, 0);
const obsoleteReuse = batch(); obsoleteReuse.items[0].priorProgress = { ...progress, evidenceIdentity: { ...identity, version: 1 } };
assert.notEqual((await run(obsoleteReuse)).result.results[0].gateBandReused, true);
obsoleteReuse.items[0].priorProgress.evidenceIdentity.version = 2;
assert.notEqual((await run(obsoleteReuse)).result.results[0].gateBandReused, true);
const bMiss = batch(); bMiss.items[0].priorProgress = { ...progress, evidenceIdentity: { ...identity, hash: 'ff'.repeat(32) } };
assert.notEqual((await run(bMiss)).result.results[0].gateBandReused, true);

const planner = { ...checkpoints.find(c => c.progressStage === 'post-plan').planner, recommendEscalate: true };
const dir = mkdtempSync(join(tmpdir(), 'factory-native-contract-'));
try {
  const output = join(dir, 'verify-final-' + hash + '.txt');
  writeFileSync(output, transcript);
  assert.equal(prepareVerificationOutput(dir, hash).written, true);
  assert.equal(readFileSync(output, 'utf8'), '');
  assert.equal(readFileSync(output + '.prior-1', 'utf8'), transcript);
  writeFileSync(join(dir, 'plan.md'), 'legacy prose cannot prove signoff');
  writeFileSync(join(dir, 'test.json'), JSON.stringify({ red: true }));
  writeFileSync(join(dir, 'fix.json'), JSON.stringify({ applied: true }));
  assert.equal(loadPriorAttempt(dir).plan, null);
  writeFileSync(join(dir, 'progress.json'), JSON.stringify({ planner }));
  const prior = loadPriorAttempt(dir);
  assert.equal(prior.plan.recommendEscalate, true);
  assert.deepEqual(prior.plan.steps, planner.steps);
  const b = batch(); b.items[0].priorAttempt = { plan: prior.plan };
  assert.equal((await run(b)).result.results[0].toState, 'ESCALATED');
} finally { rmSync(dir, { recursive: true, force: true }); }

const bInfra = batch(); bInfra.items[0].realInfra = true;
const infra = await run(bInfra, (prompt, opts) => {
  if (opts.label.endsWith(':test-author')) return { ...defaultAgentStub(opts), realInfraOverride: 'pure logic, no database semantics' };
  if (opts.label.endsWith(':marker-probe')) return { markerFound: false };
});
const ir = infra.result.results[0];
assert.equal(ir.toState, 'CLOSED');
assert.equal(ir.infraClassification.original, true);
assert.equal(effectiveInfraRequirement(ir), false);
assert.equal(effectiveInfraRequirement(recoveryFoldSkeleton(ir.id, {}, ir, 1)), false);
assert.equal(effectiveInfraRequirement({ needsRealInfra: false, infraClassification: { version: 1, original: true, effective: false } }), true);
assert.equal(effectiveInfraRequirement({ ...ir, gates: {}, gateDetails: {} }, true), true);
assert.equal(effectiveInfraRequirement({ needsRealInfra: false, infraClassification: { version: 1, original: false, effective: false } }, true), true);

const missing = await run(batch(), (_prompt, opts) => opts.label.endsWith(':integrator') ? null : undefined);
const mr = missing.result.results[0];
assert.equal(mr.toState, 'FAILED');
assert.deepEqual(missingStageFrom(mr.transitions, mr.gates, mr.failure), { stage: 'integrator', lenses: [] });
const failed = await run(batch(), (_prompt, opts) => opts.label.endsWith(':integrator') ? { globalGreen: false, regressionDelta: 1 } : undefined);
assert.equal(missingStageFrom(failed.result.results[0].transitions, {}, failed.result.results[0].failure).stage, null);
assert.deepEqual(missingStageFrom(['GATED', 'REFUTE_OK', 'FAILED'], { reaudit: 'code=NULL security=ok' }, { kind: 'unavailable', stage: 're-auditor' }), { stage: 're-auditor', lenses: ['code'] });
assert.equal(missingStageFrom(['REFUTE_OK', 'FAILED'], { reaudit: 'code=NULL security=no' }).stage, null);

let edge = 0, finalVerify = 0;
const amend = await run(batch(), (prompt, opts) => {
  if (opts.label.endsWith(':evidence-identity') && !prompt.includes('Boundary post-verify.')) return { ...identity, hash: 'ef'.repeat(32), codeHash: 'aa'.repeat(32) };
  if (opts.label.endsWith(':review-edgecase') && edge++ === 0) return { gate: 'edge', verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH', title: 'boundary' }] };
  if (opts.label.endsWith(':fixer') && prompt.includes('EARLY EDGE-SCAN AMEND')) return { applied: false, scopeStop: false, summary: 'explanation', note: 'scope already satisfied; inspect the guard' };
  if (opts.label.endsWith(':runner') && prompt.includes('FINAL INDEPENDENT')) { finalVerify++; return { ...defaultAgentStub(opts), build: 'fail' }; }
});
assert.equal(edge, 2);
assert.equal(finalVerify, 1);
assert.equal(amend.result.results[0].toState, 'FAILED');
assert.equal(amend.calls.some(c => c.label.endsWith(':gate-developer')), false);

const clean = await run();
assert.equal(clean.calls.filter(c => c.label.endsWith(':runner')).length, 1);
let proseHint = '';
const proseRun = await run(batch(), (prompt, opts) => {
  if (opts.label.endsWith(':evidence-identity') && !prompt.includes('Boundary post-verify.')) return { ...identity, hash: 'ee'.repeat(32) };
  if (opts.label.endsWith(':runner') && prompt.includes('FINAL INDEPENDENT')) proseHint = prompt;
});
assert.equal(proseRun.result.results[0].toState, 'CLOSED');
assert.ok(proseHint.includes('do not repeat the full suite'));
const reviewMutation = await run(batch(), (prompt, opts) => opts.label.endsWith(':evidence-identity') && prompt.includes('Boundary post-review.') ? { ...identity, hash: 'ee'.repeat(32) } : undefined);
assert.equal(reviewMutation.result.results[0].toState, 'FAILED');
assert.equal(reviewMutation.calls.some(c => c.label.endsWith(':integrator')), false);
let semanticCalls = 0;
const staleScan = await run(batch(), (prompt, opts) => {
  if (opts.label.endsWith(':evidence-identity') && !prompt.includes('Boundary post-verify.')) return { ...identity, hash: 'ee'.repeat(32) };
  if (opts.label.endsWith(':plan-commitment-probe') && ++semanticCalls > 1) return { honored: false, gaps: [{ commitment: 'step lost', why: 'later mutation' }] };
});
assert.equal(staleScan.result.results[0].toState, 'FAILED');
assert.ok(staleScan.result.results[0].note.includes('final semantic scan unresolved'));
assert.ok(semanticCalls > 1);
const staleProof = await run(batch(), (prompt, opts) => {
  if (opts.label.endsWith(':evidence-identity') && !prompt.includes('Boundary post-verify.')) return { ...identity, hash: 'ee'.repeat(32), codeHash: 'aa'.repeat(32), verification: { pass: false, reason: 'missing fresh filter' } };
});
assert.equal(staleProof.result.results[0].toState, 'FAILED');
assert.ok(staleProof.result.results[0].note.includes('final machine verification incomplete'));
assert.ok(staleProof.calls.some(c => c.label.endsWith(':progress-writer')));
assert.equal(staleProof.calls.some(c => c.label.endsWith(':gate-developer')), false);

const crashed = await run(batch(), (_prompt, opts) => opts.label.endsWith(':fixer') ? { applied: true, scopeStop: false, filesChanged: 17, summary: 'malformed simulation' } : undefined);
assert.equal(crashed.result.results[0].toState, 'FAILED');
assert.ok(crashed.result.results[0].note.includes('runItem threw'));
assert.ok(Object.keys(crashed.result.results[0].cost).length > 0);
assert.ok(crashed.result.results[0].planner);
assert.equal(crashed.result.attemptObservations.length, crashed.calls.length);
assert.equal(crashed.result.results[0].attemptObservations.length, crashed.calls.length);

let remaining = 100000;
const budgetRun = await run(batch(), (_prompt, opts) => { if (opts.label.endsWith(':test-author')) remaining = 100; }, { budget: { total: 100000, remaining: () => remaining, spent: () => 100000 - remaining } });
assert.equal(budgetRun.result.results[0].failure.kind, 'budget');
assert.equal(budgetRun.calls.some(c => c.label.endsWith(':fixer')), false);
assert.equal(budgetRun.calls.some(c => c.label.endsWith(':checkpoint')), true);

// Execute the production serializer, including tryAgent's last-moment observation injection.
const replayBatch = batch(); replayBatch.items[0].fixType = 'mechanical';
let spent = 0;
const counted = await run(replayBatch, () => { spent += 1 + Math.floor(Math.random() * 1000); }, {
  budget: { total: 1000000, spent: () => spent, remaining: () => 1000000 - spent },
});
const replayZero = await run(replayBatch, undefined, {
  budget: { total: 1000000, spent: () => 0, remaining: () => 1000000 },
});
assert.equal(counted.result.results[0].toState, 'CLOSED');
assert.equal(replayZero.result.results[0].toState, 'CLOSED');
assert.deepEqual(counted.calls, replayZero.calls, 'all completed prompts and complete options remain byte-stable at zero replay usage');
assert.ok(counted.result.results[0].tokensUsed > 0);
assert.equal(counted.result.usage.outputTokens, spent);
assert.equal(replayZero.result.usage.outputTokens, 0);
assert.ok(counted.result.attemptObservations.every(o => o.outcome === 'completed'));
const savedSnapshots = counted.calls.filter(c => c.opts.phase === 'Checkpoint').map(c => JSON.parse(c.prompt.split('CHECKPOINT-BEGIN\n')[1].split('\nCHECKPOINT-END')[0]));
for (const snapshot of savedSnapshots) {
  assert.equal('tokensUsed' in snapshot, false);
  assert.equal('tokenAttributionConfidence' in snapshot, false);
  assert.ok(snapshot.attemptObservations.every(o => o.outcome === 'started' && !('outputTokens' in o) && !('completedAt' in o)));
}
assert.ok(savedSnapshots.some(s => s.progressStage === 'post-test'));
assert.ok(savedSnapshots.some(s => s.progressStage === 'post-gates'));
const observationalChanges = structuredClone(counted.result.results[0]);
observationalChanges.tokensUsed = 0;
observationalChanges.attemptObservations.forEach(o => Object.assign(o, { outcome: 'malformed', error: 'runtime-only error', startedAt: 'later', completedAt: 'later', outputTokens: 99, actualModel: 'runtime-observed' }));
assert.deepEqual(nativeCheckpointSnapshot(observationalChanges), nativeCheckpointSnapshot(counted.result.results[0]));
const changedReply = await run(replayBatch, (_p, o) => o.label.endsWith(':test-author') ? { ...defaultAgentStub(o), note: 'changed saved reply' } : undefined);
const firstMismatch = counted.calls.findIndex((c, i) => JSON.stringify(c) !== JSON.stringify(changedReply.calls[i]));
assert.ok(firstMismatch > 0);
assert.ok(counted.calls[firstMismatch].label.endsWith(':progress:post-test'), 'real reply changes still invalidate the first affected call');

let malformedRelayCount = 0;
const correctedRelay = await run(batch(), (_p, o) => o.label.endsWith(':evidence-identity') && malformedRelayCount++ === 0 ? { ...identity, hash: 'a'.repeat(40), codeHash: '' } : undefined);
assert.equal(correctedRelay.result.results[0].toState, 'CLOSED');
assert.equal(correctedRelay.calls.filter(c => c.prompt.includes('IDENTITY RELAY RETRY')).length, 1);
assert.equal(correctedRelay.calls.filter(c => c.label.endsWith(':fixer')).length, first.calls.filter(c => c.label.endsWith(':fixer')).length);
assert.ok(correctedRelay.result.attemptObservations.some(o => o.stage.endsWith(':evidence-identity') && o.outcome === 'malformed'));
const permanentlyMalformed = await run(batch(), (_p, o) => o.label.endsWith(':evidence-identity') ? { ...identity, codeHash: '' } : undefined);
assert.equal(permanentlyMalformed.calls.filter(c => c.label.endsWith(':evidence-identity')).length, 2);
assert.equal(permanentlyMalformed.result.results[0].toState, 'FAILED');
assert.equal(permanentlyMalformed.result.results[0].failure.kind, 'malformed');
assert.ok(permanentlyMalformed.calls.at(-1).label.endsWith(':checkpoint'));
assert.equal(permanentlyMalformed.calls.some(c => c.label.endsWith(':gate-developer')), false);
let thrownRelayCount = 0;
const thrownRelay = await run(batch(), (_p, o) => {
  if (o.label.endsWith(':evidence-identity') && thrownRelayCount++ === 0) throw new Error('StructuredOutput retry cap (2) exceeded');
});
assert.equal(thrownRelay.result.results[0].toState, 'CLOSED');
const deniedRelay = await run(batch(), (_p, o) => { if (o.label.endsWith(':evidence-identity')) throw new Error('permission denied'); });
assert.equal(deniedRelay.calls.filter(c => c.label.endsWith(':evidence-identity')).length, 1);
const hostilePaths = ["C:/work/a b/O'Brien/$HOME/`echo nope`", 'C:\\work\\a b\\test', 'x; echo no', 'a"b'];
const quoteCommand = ['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...hostilePaths].map(nativeShellQuote).join(' ');
assert.deepEqual(JSON.parse(execFileSync(resolveBash(), ['-c', quoteCommand], { encoding: 'utf8' })), hostilePaths);
const quotedBatch = batch(); quotedBatch.items[0].worktree.path = hostilePaths[0];
const quotedRun = await run(quotedBatch);
assert.ok(quotedRun.calls.find(c => c.label.endsWith(':evidence-identity')).prompt.includes(nativeShellQuote(hostilePaths[0])));

let n = 0;
const bRetry = batch(); bRetry.attempts = 3;
const retry = await run(bRetry, (_prompt, opts) => opts.label.endsWith(':test-author') && n++ < 2 ? null : undefined);
assert.equal(retry.result.attemptObservations.filter(o => o.stage.endsWith(':test-author')).length, 3);
assert.equal(Object.values(retry.result.results[0].cost).reduce((a, b) => a + b, 0), retry.calls.filter(c => !c.label.includes(':progress:') && !c.label.endsWith(':checkpoint')).length);
const terminal = await run(bRetry, (_prompt, opts) => { if (opts.label.endsWith(':test-author')) throw new Error('invalid schema request 400'); });
assert.equal(terminal.calls.filter(c => c.label.endsWith(':test-author')).length, 1);
assert.equal(terminal.result.results[0].infraSuspect, false);

const win = batch(); win.items[0].worktree.path = 'C:\\work\\item';
let pathRetries = 0;
const paths = await run(win, (prompt, opts) => {
  if (opts.label.endsWith(':test-author')) {
    if (prompt.includes('PATH-CORRECTION RETRY')) { pathRetries++; return { ...defaultAgentStub(opts), testFiles: ['c:/WORK/item/test.cs'] }; }
    return { ...defaultAgentStub(opts), testFiles: ['C:/work/item-sibling/test.cs'] };
  }
});
assert.equal(pathRetries, 1);
assert.equal(paths.result.results[0].toState, 'CLOSED');

const sw = { ...batch(), runId: 'sweep-run-1', items: [], worktree: { path: '/fixture' }, sweep: { index: 1, label: 'pattern', verificationTranscript: '/artifacts/sweep-run-1-verify.txt', verificationTargets: ['X/X.sln'], sites: [{ findingId: 'x', target: 'X', claimId: 'claim-x', attemptNumber: 2, files: ['X/a.cs'] }] } };
const noVerify = await run(sw, (_prompt, opts) => opts.label === 'sweep:verify' ? null : undefined);
assert.equal(noVerify.result.sweep.execution.verificationPassed, false);
assert.equal(noVerify.calls.some(c => c.label === 'sweep:gate-architect'), false);
const noReview = await run(sw, (_prompt, opts) => opts.label === 'sweep:gate-architect' ? null : undefined);
assert.equal(noReview.result.sweep.execution.reviewsCompleted, false);
const badVerify = await run(sw, (_prompt, opts) => opts.label === 'sweep:verify' ? { ...defaultAgentStub(opts), targetedTest: 'fail' } : undefined);
assert.equal(badVerify.result.sweep.execution.verificationPassed, false);
const isolatedDissent = await run(sw, (_prompt, opts) => opts.label === 'sweep:gate-architect' ? { ...defaultAgentStub(opts), verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH', title: 'site bug', file: 'X/a.cs' }] } : undefined);
assert.equal(isolatedDissent.result.sweep.execution.reviewsCompleted, true);
assert.equal(isolatedDissent.result.sweep.sites[0].gateFlagged, true);

// Effective portfolio changes invalidate both the hash contract and required verdict coverage.
const bPortfolio = batch();
bPortfolio.items[0].reviewFlows = [{ skill: 'bmad-code-review', routeKey: 'review.code', band: 'method', blocking: false }];
let savedPortfolio;
let originalPortfolioInput;
await run(bPortfolio, (prompt, opts) => {
  if (opts.label.endsWith(':evidence-identity')) originalPortfolioInput = JSON.parse(prompt.split('\n').at(-1)).reviewerContract.portfolio;
  if (opts.label.endsWith(':progress:post-gates')) savedPortfolio = JSON.parse(prompt.split('CHECKPOINT-BEGIN\n')[1].split('\nCHECKPOINT-END')[0]);
});
const changedPortfolio = structuredClone(bPortfolio);
changedPortfolio.items[0].reviewFlows[0].blocking = true;
changedPortfolio.items[0].priorProgress = savedPortfolio;
let nextPortfolioInput;
const portfolioRun = await run(changedPortfolio, (prompt, opts) => {
  if (opts.label.endsWith(':evidence-identity')) nextPortfolioInput = JSON.parse(prompt.split('\n').at(-1)).reviewerContract.portfolio;
});
assert.notDeepEqual(originalPortfolioInput, nextPortfolioInput);
assert.notEqual(portfolioRun.result.results[0].gateBandReused, true);
assert.ok(portfolioRun.calls.some(c => c.label.endsWith(':review-code')));
const missingVerdict = batch(); missingVerdict.items[0].priorProgress = structuredClone(progress);
delete missingVerdict.items[0].priorProgress.gateDetails['gate-qa'];
delete missingVerdict.items[0].priorProgress.gateDetails['gate:qa'];
assert.notEqual((await run(missingVerdict)).result.results[0].gateBandReused, true);

// A corrected reFix gets an isolated pass output; historical failures remain archived.
const freshDir = mkdtempSync(join(tmpdir(), 'factory-fresh-verify-'));
try {
  writeFileSync(join(freshDir, 'verify-raw.txt'), transcript.replace('errors=0', 'errors=1'));
  prepareVerificationOutput(freshDir, 'run-1-claim-1', 'initial');
  const path = join(freshDir, 'verify-initial-run-1-claim-1.txt');
  writeFileSync(path, transcript);
  assert.equal(completeVerificationTranscript(readFileSync(path, 'utf8'), { band: 'FULL' }).pass, true);
  assert.equal(completeVerificationTranscript(readFileSync(join(freshDir, 'verify-raw.txt'), 'utf8'), { band: 'FULL' }).pass, false);
  prepareVerificationOutput(freshDir, 'run-1-claim-1', 'initial');
  assert.equal(readFileSync(path, 'utf8'), '');
  assert.equal(readFileSync(path + '.prior-1', 'utf8'), transcript);
} finally { rmSync(freshDir, { recursive: true, force: true }); }
const refix = batch(); refix.runId = 'run-unique-2'; Object.assign(refix.items[0], { reFix: true, runId: 'run-unique-2', claimId: 'claim-2', attemptNumber: 3 });
const corrected = await run(refix);
assert.equal(corrected.result.results[0].toState, 'CLOSED');
assert.ok(corrected.result.results[0].initialVerification.transcript.endsWith('verify-initial-run-unique-2-claim-2.txt'));
assert.ok(corrected.calls.find(c => c.label.endsWith(':runner')).prompt.includes('never append to historical verify-raw.txt'));
assert.equal(corrected.result.results[0].claimId, 'claim-2');
assert.equal(corrected.result.results[0].attemptNumber, 3);
assert.equal(corrected.result.results[0].runId, corrected.result.runId);
assert.ok(corrected.result.results[0].integrationVerification.transcript.endsWith('verify-integrate-run-unique-2-claim-2.txt'));
assert.ok(corrected.calls.find(c => c.label.endsWith(':integrator')).prompt.includes('verify-integrate-run-unique-2-claim-2.txt'));
const noRunIdentity = batch(); delete noRunIdentity.runId;
await assert.rejects(() => run(noRunIdentity), /unique driver-supplied runId/);

// Final plan recheck respects accepted alternative, but new gaps cannot inherit its waiver.
async function deviationRun(newGap) {
  let identityCalls = 0;
  return run(batch(), (prompt, opts) => {
    if (opts.label.endsWith(':evidence-identity')) return identityCalls++ === 0 ? identity : { ...identity, hash: 'fe'.repeat(32) };
    if (opts.label.endsWith(':plan-commitment-probe')) return { honored: false, gaps: [{ commitment: newGap && prompt.includes('FINAL SNAPSHOT RECHECK') ? 'brand new obligation' : 'original step', why: 'alternative used' }] };
    if (opts.label.endsWith(':fixer') && /PLAN-(?:COMMITMENT|STEP) AMEND/.test(prompt)) return { applied: true, scopeStop: false, summary: 'alternative implemented', deviations: [{ commitment: 'original step', reason: 'equivalent guard already enforced upstream' }] };
  });
}
const acceptedAlternative = await deviationRun(false);
assert.equal(acceptedAlternative.result.results[0].toState, 'CLOSED', acceptedAlternative.result.results[0].note);
assert.ok(acceptedAlternative.calls.some(c => c.prompt.includes('FINAL PLAN-DEVIATION RE-ADJUDICATION')));
assert.ok(acceptedAlternative.result.results[0].planDeviation.evidenceHash);
assert.equal((await deviationRun(true)).result.results[0].toState, 'FAILED');

const portPrior = { needsRealInfra: false, codeChange: true, realInfraClassification: { original: true, effective: false, reason: 'pure in-process defect', adjudication: { verdict: 'OVERRULED', headline: 'no provider dependency', reasons: ['pure logic demonstrated'] } }, gates: { 'adjudicator:realinfra-override': 'OVERRULED' } };
const portRecovery = recoveryFoldSkeleton('x', {}, portPrior, 1);
assert.equal(effectiveInfraRequirement(portRecovery, true), false);
assert.deepEqual(portRecovery.realInfraClassification, portPrior.realInfraClassification);
assert.equal(effectiveInfraRequirement(recoveryFoldSkeleton('x', {}, { ...portPrior, gates: {} }, 1), true), true);

const configSweep = structuredClone(sw); configSweep.sweep.sites[0].files = ['X/appsettings.json']; configSweep.sweep.verificationTargets.push('Y/Y.sln');
const configResult = await run(configSweep);
assert.equal(configResult.result.runId, 'sweep-run-1');
assert.equal(configResult.result.sweep.runId, 'sweep-run-1');
assert.equal(configResult.result.sweep.execution.verificationRequired, true);
assert.equal(configResult.result.sweep.sites[0].claimId, 'claim-x');
const sweepPrompt = configResult.calls.find(c => c.label === 'sweep:verify').prompt;
for (const sub of ['build', 'filter', 'suite']) for (const target of ['X/X.sln', 'Y/Y.sln']) assert.ok(sweepPrompt.includes(sub + ' "/fixture/' + target + '"'));
assert.ok(sweepPrompt.includes(sw.sweep.verificationTranscript));
const sweepFixture = mkdtempSync(join(tmpdir(), 'factory-sweep-contract-'));
try {
  for (const name of ['X.sln', 'Y.sln']) writeFileSync(join(sweepFixture, name), 'fixture');
  const proof = ['X.sln', 'Y.sln'].map(target => 'FACTORY::BUILD::START ' + join(sweepFixture, target) + '\nFACTORY::SUMMARY::build exit=0 errors=0\nFACTORY::TEST::FILTER::START ' + join(sweepFixture, target) + ' :: RegressionClass\nPassed! - Failed: 0, Passed: 1\nFACTORY::SUMMARY::filter exit=0\nFACTORY::TEST::SUITE::START ' + join(sweepFixture, target) + '\nFACTORY::SUMMARY::suite exit=0 failed=0 passed=1 skipped=0\n').join('');
  assert.equal(verifyTranscript(proof, { worktree: sweepFixture, targets: ['X.sln', 'Y.sln'] }).pass, true);
  assert.equal(verifyTranscript(proof.slice(0, proof.indexOf('FACTORY::BUILD::START ' + join(sweepFixture, 'Y.sln'))), { worktree: sweepFixture, targets: ['X.sln', 'Y.sln'] }).pass, false);
} finally { rmSync(sweepFixture, { recursive: true, force: true }); }
const docSweep = structuredClone(sw); docSweep.sweep.sites[0].files = ['X/readme.md', 'X/notes.rst', 'X/help.txt'];
assert.equal((await run(docSweep)).result.sweep.execution.verificationRequired, false);

const notAdmitted = await run(refix, undefined, { budget: { total: 100000, remaining: () => 1, spent: () => 0 } });
assert.equal(notAdmitted.calls.length, 0);
assert.equal(notAdmitted.result.results[0].admission.status, 'deferred');
assert.equal(notAdmitted.result.admissionObservations[0].attempted, false);
assert.equal(notAdmitted.result.admissionObservations[0].claimId, 'claim-2');
assert.equal(corrected.result.admissionObservations[0].attempted, true);

// Driver's actual scanner consumer recognizes early native checkpoints without a final envelope.
const mechanical = batch(); mechanical.items[0].fixType = 'mechanical'; mechanical.items[0].claimId = 'mechanical-claim'; mechanical.items[0].attemptNumber = 1;
let postTest;
const mechanicalRun = await run(mechanical, (prompt, opts) => {
  if (opts.label.endsWith(':progress:post-test')) postTest = JSON.parse(prompt.split('CHECKPOINT-BEGIN\n')[1].split('\nCHECKPOINT-END')[0]);
});
assert.ok(postTest && postTest.admission.attempted && postTest.test.red);
assert.equal(postTest.toState, 'IN_PROGRESS');
assert.equal(mechanicalRun.calls.filter(c => c.label.endsWith(':progress:post-test')).length, 1);
assert.ok(mechanicalRun.calls.findIndex(c => c.label.endsWith(':progress:post-test')) < mechanicalRun.calls.findIndex(c => c.label.endsWith(':fixer')));
function admissionRow(id, runId, claimId) { return { id, runId, claimId, attemptIdentity: { runId, claimId, attemptNumber: 1, admitted: false, startedAt: null, band: 'LIGHT', recovery: false } }; }
const mechanicalRow = admissionRow(postTest.id, postTest.runId, postTest.claimId);
assert.equal(observeAdmission(postTest, mechanicalRow, () => {}), true);
assert.equal(mechanicalRow.attemptIdentity.admitted, true);
assert.equal(first.calls.some(c => c.label.endsWith(':progress:post-test')), false);

let siteStart;
const durableSweep = await run(sw, (prompt, opts) => {
  if (opts.label === 'sweep:apply:x') siteStart = JSON.parse(prompt.split('CHECKPOINT-BEGIN\n')[1].split('\nCHECKPOINT-END')[0]);
});
assert.equal(siteStart.id, 'x');
assert.equal(siteStart.progressStage, 'sweep-apply-started');
assert.equal(siteStart.admission.attempted, true);
assert.ok(siteStart.attemptObservations.some(o => o.itemId === 'x' && o.outcome === 'started'));
assert.equal(observeAdmission(siteStart, admissionRow('x', sw.runId, 'claim-x'), () => {}), true);
assert.equal(durableSweep.result.sweep.sites[0].admission.attempted, true);
assert.equal(durableSweep.result.sweep.sites[0].attemptObservations[0].outcome, 'completed');
assert.ok(durableSweep.calls.find(c => c.label === 'sweep:verify').prompt.includes('DURABLE APPLY FRONTIER'));
assert.equal(durableSweep.calls.filter(c => /checkpoint|progress:/.test(c.label)).length, 1);

let sweepRemaining = 100000;
const queuedSweep = await run(sw, (_prompt, opts) => { if (opts.label === 'sweep:design') sweepRemaining = 0; }, { budget: { total: 100000, remaining: () => sweepRemaining, spent: () => 100000 - sweepRemaining } });
assert.equal(queuedSweep.calls.some(c => c.label.startsWith('sweep:apply:')), false);
assert.equal(queuedSweep.result.sweep.sites[0].admission.attempted, true);
assert.equal(queuedSweep.result.sweep.sites[0].admission.status, 'admitted');
for (const unsafe of ['/fixture-sibling/X.sln', '../outside.sln', 'C:\\other\\X.sln']) {
  const rejected = structuredClone(sw); rejected.sweep.verificationTargets = [unsafe];
  assert.equal((await run(rejected)).calls.length, 0);
}
const windowsSweep = structuredClone(sw); windowsSweep.worktree.path = 'C:\\factory\\worktree'; windowsSweep.sweep.verificationTargets = ['c:/FACTORY/worktree/X.sln'];
assert.ok((await run(windowsSweep)).calls.some(c => c.label === 'sweep:verify'));
windowsSweep.sweep.verificationTargets = ['C:\\factory\\worktree-sibling\\X.sln'];
assert.equal((await run(windowsSweep)).calls.length, 0);

const expectedCross = { build: ['A/A.sln', 'B/B.sln'], filter: [{ target: 'A/Tests/Tests.csproj', filter: 'RegressionClass' }], suite: ['A/A.sln', 'B/B.sln'] };
function transcriptFor(expected) {
  return ['build', 'filter', 'suite'].flatMap(sub => expected[sub].map(entry => {
    const target = typeof entry === 'string' ? entry : entry.target;
    const marker = sub === 'build' ? 'BUILD' : sub === 'filter' ? 'TEST::FILTER' : 'TEST::SUITE';
    return 'FACTORY::' + marker + '::START ' + target + (sub === 'filter' ? ' :: ' + entry.filter : '') + '\n' + (sub === 'filter' ? 'Passed! - Failed: 0, Passed: 1\n' : '') + 'FACTORY::SUMMARY::' + sub + ' exit=0' + (sub === 'build' ? ' errors=0' : sub === 'suite' ? ' failed=0 passed=1 skipped=0' : '') + '\n';
  })).join('');
}
const crossProof = transcriptFor(expectedCross);
assert.equal(completeVerificationTranscript(crossProof, { band: 'FULL', worktree: 'C:\\Repo', expected: expectedCross }).pass, true);
assert.equal(completeVerificationTranscript(transcriptFor({ ...expectedCross, suite: ['A/A.sln'] }), { band: 'FULL', worktree: 'C:\\Repo', expected: expectedCross }).pass, false);
assert.equal(completeVerificationTranscript(crossProof.replace(':: RegressionClass', ':: UnrelatedClass'), { band: 'FULL', worktree: 'C:\\Repo', expected: expectedCross }).pass, false);
assert.equal(completeVerificationTranscript(crossProof.replaceAll('A/A.sln', 'C:/Repo-sibling/A.sln'), { band: 'FULL', worktree: 'C:\\Repo', expected: expectedCross }).pass, false);
assert.equal(completeVerificationTranscript(crossProof.replaceAll('A/A.sln', '/c/repo/a/a.sln').replaceAll('B/B.sln', 'c:\\REPO\\B\\B.sln'), { band: 'FULL', worktree: 'C:\\Repo', expected: expectedCross }).pass, true);

const crossBatch = batch(); crossBatch.items[0].verificationTargets = ['A/A.sln', 'B/B.sln']; crossBatch.items[0].verificationExpected = expectedCross;
let capturedContract;
const crossRun = await run(crossBatch, (prompt, opts) => {
  if (opts.schema?.properties.expected) return { written: true, expected: expectedCross, integrationExpected: { build: expectedCross.build, filter: [], suite: expectedCross.suite } };
  if (opts.label.endsWith(':evidence-identity')) {
    capturedContract = JSON.parse(prompt.split('\n').at(-1)).context.verificationContract;
    return prompt.includes('Boundary post-verify.') ? identity : { ...identity, hash: 'ef'.repeat(32), codeHash: 'fa'.repeat(32) };
  }
  if (opts.label.endsWith(':runner')) return { ...defaultAgentStub(opts), evidence: 'no service names in prose' };
});
assert.equal(crossRun.result.results[0].toState, 'CLOSED', crossRun.result.results[0].note);
assert.deepEqual(capturedContract.expected, expectedCross);
const runnerPrompts = crossRun.calls.filter(c => c.label.endsWith(':runner')).map(c => c.prompt);
assert.equal(runnerPrompts.length, 2);
for (const prompt of runnerPrompts) {
  for (const target of expectedCross.build) assert.ok(prompt.includes('build "' + crossBatch.items[0].worktree.path + '/' + target + '"'));
  for (const target of expectedCross.suite) assert.ok(prompt.includes('suite "' + crossBatch.items[0].worktree.path + '/' + target + '"'));
  assert.ok(prompt.includes('filter "' + crossBatch.items[0].worktree.path + '/A/Tests/Tests.csproj" "RegressionClass"'));
}
const integPrompt = crossRun.calls.find(c => c.label.endsWith(':integrator')).prompt;
for (const target of expectedCross.build) assert.ok(integPrompt.includes('build "' + crossBatch.items[0].worktree.path + '/' + target + '"'));
for (const target of expectedCross.suite) assert.ok(integPrompt.includes('suite "' + crossBatch.items[0].worktree.path + '/' + target + '"'));
const missingIntegrationTarget = await run(crossBatch, (prompt, opts) => opts.label.endsWith(':evidence-identity') && prompt.includes('Boundary post-integrate.') ? { ...identity, integration: { pass: false, reason: 'missing B/B.sln' } } : undefined);
assert.equal(missingIntegrationTarget.result.results[0].toState, 'FAILED');

const contractFixture = mkdtempSync(join(tmpdir(), 'factory-target-contract-'));
try {
  mkdirSync(join(contractFixture, 'A', 'Tests'), { recursive: true }); mkdirSync(join(contractFixture, 'B'));
  for (const file of ['A/A.sln', 'B/B.sln', 'A/Tests/Tests.csproj', 'A/Tests/Regression.cs']) writeFileSync(join(contractFixture, file), 'fixture');
  writeFileSync(join(contractFixture, 'verify-red-raw.txt'), 'FACTORY::RED::START ' + join(contractFixture, 'A/Tests/Tests.csproj') + ' :: RegressionClass\nFACTORY::RED::1\n');
  const contract = nativeVerificationContract({ item: { verificationTargets: ['A/A.sln', 'B/B.sln'], files: [] }, test: { testFiles: ['A/Tests/Regression.cs'] }, worktree: contractFixture, artifactDir: contractFixture, band: 'FULL' });
  assert.equal(contract.expected.build.length, 2); assert.equal(contract.expected.suite.length, 2);
  assert.equal(contract.expected.filter[0].filter, 'RegressionClass');
  assert.ok(/tests\.csproj$/i.test(contract.expected.filter[0].target));
  assert.equal(contract.baseline.status, 'absent');
  const baselineRaw = 'FACTORY::TEST::SUITE::START A/A.sln\nFACTORY::TEST::FAILURE {"source":"A.Tests/net8.0","test":"Existing.EnvironmentFailure"}\nFACTORY::SUMMARY::suite exit=1 failed=1 passed=2 skipped=0\n';
  writeFileSync(join(contractFixture, 'baseline-raw.txt'), baselineRaw);
  const input = { item: { verificationTargets: ['A/A.sln'], files: [] }, test: { testFiles: ['A/Tests/Regression.cs'] }, worktree: contractFixture, artifactDir: contractFixture, band: 'FULL' };
  const captured = nativeVerificationContract(input).baseline;
  assert.equal(captured.status, 'captured');
  assert.equal(captured.targets[0].failedTests.length, 1);
  const preparationSchema = first.calls.find(c => c.schema?.properties.expected).schema;
  assert.equal(validate(preparationSchema, { written: true, ...nativeVerificationContract(input) }).ok, true);
  assert.equal(validate(preparationSchema, { written: true, baseline: { ...captured, targets: [{ ...captured.targets[0], failedTests: 1 }] } }).ok, false);
  assert.equal(validate(preparationSchema, { written: true, baseline: { ...captured, targets: [{ ...captured.targets[0], unknown: true }] } }).ok, false);
  assert.equal(nativeVerificationContract({ ...input, item: { ...input.item, reFix: true } }).baseline.status, 'absent');
  assert.equal(nativeVerificationContract({ ...input, item: { ...input.item, reFix: true, claimAt: '2000-01-01T00:00:00Z' } }).baseline.status, 'absent');
  assert.equal(nativeVerificationContract({ ...input, item: { ...input.item, reFix: true, claimAt: '2100-01-01T00:00:00Z' } }).baseline.status, 'captured');
  const suiteMeta = { reviewerContract: { band: 'FULL' }, context: { verificationContract: { baseline: captured, integrationExpected: { build: [], filter: [], suite: ['A/A.sln'] } } }, integrationTranscript: join(contractFixture, 'integration.txt') };
  writeFileSync(suiteMeta.integrationTranscript, baselineRaw.replace('Existing.EnvironmentFailure', 'New.Regression'));
  const collectedBaseline = collectNativeEvidence(process.cwd(), suiteMeta, contractFixture, { legacy: true });
  assert.equal(collectedBaseline.integration.pass, false);
} finally { rmSync(contractFixture, { recursive: true, force: true }); }

for (const pair of [['src\\Foo.cs', 'src/Foo.cs'], ['src/tmp/../Foo.cs', './src/Foo.cs'], ['SRC/Foo.cs', 'src/foo.cs']]) {
  const overlap = structuredClone(sw); overlap.worktree.path = 'C:\\Repo'; overlap.sweep.verificationTargets = ['X/X.sln'];
  overlap.sweep.sites = [{ findingId: 'x', target: 'X', files: [pair[0]] }, { findingId: 'y', target: 'Y', files: [pair[1]] }];
  assert.equal((await run(overlap)).result.sweep.applyMode, 'sequential (shared file)');
}

const ledger = { items: { x: { lastFailSignature: 'global regression', stallRounds: 1 } } };
assert.equal(applyStallDetection(ledger, { maxStallRounds: 2 }, [{ id: 'x', toState: 'FAILED', note: 'global regression: still failing', gateDetails: { a: { verdict: 'APPROVED' } } }], {}).length, 1);

const admissionCheckpoint = checkpoints.find(c => c.progressStage === 'admission');
assert.ok(admissionCheckpoint.admission.attempted);
assert.equal(admissionCheckpoint.attemptObservations.length, 1);
assert.equal(admissionCheckpoint.attemptObservations[0].outcome, 'started');
assert.ok(first.calls[0].label.endsWith(':progress:admission'));
const admissionDir = mkdtempSync(join(tmpdir(), 'native-admission-'));
try {
  assert.deepEqual(persistNativeAdmission(admissionDir, admissionCheckpoint), { written: true });
  assert.deepEqual(JSON.parse(readFileSync(join(admissionDir, 'progress.json'), 'utf8')), admissionCheckpoint);
  assert.throws(() => persistNativeAdmission(admissionDir, { ...admissionCheckpoint, runId: 'other' }), /invalid/);
} finally { rmSync(admissionDir, { recursive: true, force: true }); }
const admissionFailure = await run(batch(), (_p, o) => o.label.endsWith(':progress:admission') ? { written: false } : undefined);
assert.equal(admissionFailure.calls.some(c => /:(planner|test-author|fixer)$/.test(c.label)), false);
assert.match(admissionFailure.result.results[0].note, /durable admission unavailable/);
for (const c of first.calls.filter(c => /:(runner|fixer|test-author|integrator)$/.test(c.label))) {
  assert.ok(c.prompt.includes('/_workflow/opencode/build-lease.mjs'));
  assert.doesNotMatch(c.prompt, /bash [^\n`]*\/verify\/build-test\.sh[" ]+(?:build|red|filter|suite|efmigration)\b/);
}
assert.doesNotMatch(source, /['"]bash [^\n]*\/verify\/build-test\.sh (?:build|red|filter|suite|efmigration) /);

function shadowBatch() {
  const b = batch(); b.items[0].reFix = true;
  b.items[0].acceptance = 'The handler enforces the policy; The repository propagates the token';
  b.policies.shadowConsolidatedScan = true;
  return b;
}
const nullShadow = await run(shadowBatch());
assert.equal(nullShadow.result.results[0].toState, 'CLOSED');
assert.equal(nullShadow.result.results[0].shadowObservation.status, 'SKIPPED');
assert.equal(nullShadow.result.results[0].shadowObservation.snapshotHash, null);
assert.equal(nullShadow.calls.some(c => c.label.endsWith(':consolidated-scan-shadow')), false, 'null is not a shadow candidate');
for (const truth of [[true, true, true], [false, true, false], [false, false, false]]) {
  const shadowRun = await run(shadowBatch(), (p, o) => {
    if (o.label.endsWith(':evidence-identity')) return { ...identity, shadowSnapshotHash: hash };
    if (o.label.endsWith(':acceptance-probe')) return { covered: truth[0], gaps: truth[0] ? [] : [{ clause: 'missing', why: 'no evidence' }] };
    if (o.label.endsWith(':plan-commitment-probe')) return { honored: truth[1], gaps: truth[1] ? [] : [{ commitment: 'missing', why: 'no evidence' }] };
    if (o.label.endsWith(':prior-finding-probe')) return { honored: truth[2], gaps: truth[2] ? [] : [{ commitment: 'missing', why: 'no evidence' }] };
    if (o.label.endsWith(':consolidated-scan-shadow')) return { acceptanceCovered: true, planHonored: true, findingHonored: true };
  });
  const r = shadowRun.result.results[0];
  assert.equal(r.shadowObservation.status, truth.every(Boolean) ? 'AGREE' : 'DISAGREE');
  assert.deepEqual(Object.values(r.shadowObservation.originals), truth);
  const shadowIndex = shadowRun.calls.findIndex(c => c.label.endsWith(':consolidated-scan-shadow'));
  assert.ok(shadowIndex >= 0);
  const amendments = shadowRun.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.label.endsWith(':fixer') && /AMEND/.test(c.prompt));
  assert.ok(amendments.every(({ i }) => i > shadowIndex));
  assert.equal(r.toState, truth.every(Boolean) ? 'CLOSED' : 'FAILED');
}
const staleShadow = await run(shadowBatch(), (p, o) => o.label.endsWith(':evidence-identity') ? { ...identity, shadowSnapshotHash: p.includes('Boundary shadow-after.') ? 'ff'.repeat(32) : hash } : undefined);
assert.equal(staleShadow.result.results[0].shadowObservation.status, 'SKIPPED');
assert.equal(staleShadow.result.results[0].toState, 'CLOSED');
const unavailableShadow = await run(shadowBatch(), (p, o) => {
  if (o.label.endsWith(':evidence-identity')) return { ...identity, shadowSnapshotHash: hash };
  if (o.label.endsWith(':consolidated-scan-shadow')) return null;
});
assert.equal(unavailableShadow.result.results[0].shadowObservation.status, 'SKIPPED');
assert.equal(unavailableShadow.result.results[0].toState, 'CLOSED');
const negativeShadowOnly = await run(shadowBatch(), (p, o) => {
  if (o.label.endsWith(':evidence-identity')) return { ...identity, shadowSnapshotHash: hash };
  if (p.includes('OBSERVATIONAL BLINDED PRE-AMENDMENT SCAN') && o.label.endsWith(':prior-finding-probe')) return { honored: false, gaps: [{ commitment: 'observational negative', why: 'fixture' }] };
});
assert.equal(negativeShadowOnly.result.results[0].shadowObservation.status, 'DISAGREE');
assert.equal(negativeShadowOnly.result.results[0].toState, 'CLOSED');
assert.equal(negativeShadowOnly.result.results[0].gates['probe:prior-finding-scan'], 'APPROVED');
const configuredInputs = { includePaths: ['build/custom.settings'], includeGlobs: ['eng/**/*.lock'], excludePaths: ['factory/state'], discoverDefaults: true };
const configuredBatch = batch(); configuredBatch.config.evidenceInputs = configuredInputs;
let inputCaptures = 0;
const configuredRun = await run(configuredBatch, (p, o) => {
  if (o.label.endsWith(':evidence-identity')) {
    const metadata = JSON.parse(p.split('\n').at(-1));
    assert.deepEqual(metadata.inputs, configuredInputs);
    assert.equal(metadata.reviewerContract.version, 'native-review-v2');
    inputCaptures++;
    return identity;
  }
});
assert.equal(configuredRun.result.results[0].toState, 'CLOSED');
assert.ok(inputCaptures >= 4, 'initial/final/review/integration metadata preserves same input contract');
const launchInputs = batch(); launchInputs.evidenceInputs = configuredInputs;
launchInputs.config.evidenceInputs = { includePaths: ['stale-config-input'] };
const launchInputRun = await run(launchInputs, (p, o) => {
  if (o.label.endsWith(':evidence-identity')) {
    assert.deepEqual(JSON.parse(p.split('\n').at(-1)).inputs, configuredInputs, 'resolved driver launch contract takes precedence');
    return identity;
  }
});
assert.equal(launchInputRun.result.results[0].toState, 'CLOSED');
const mountedBatch = batch();
mountedBatch.engineMount = { path: 'tools/factory', sourceRoot: 'C:/host/tools/factory' };
mountedBatch.config.engineMount = { path: 'src/product', sourceRoot: 'C:/untrusted/config' };
mountedBatch.items[0].engineMount = { path: 'src/product', sourceRoot: 'C:/untrusted/item' };
mountedBatch.briefs = { runner: 'Complete runner brief', fixer: 'Complete fixer brief\n' + 'x'.repeat(14000) + '\nMANDATORY-TAIL' };
let mountCaptures = 0;
const mountedRun = await run(mountedBatch, (p, o) => {
  if (o.label.endsWith(':evidence-identity')) {
    const metadata = JSON.parse(p.split('\n').at(-1));
    assert.deepEqual(metadata.engineMount, mountedBatch.engineMount);
    assert.deepEqual(metadata.reviewerContract.briefs, mountedBatch.briefs);
    assert.deepEqual(metadata.inputs, {});
    assert.deepEqual(o.schema.properties.version.enum, [EVIDENCE_IDENTITY_VERSION]);
    mountCaptures++;
    return identity;
  }
});
assert.equal(mountedRun.result.results[0].toState, 'CLOSED');
assert.ok(mountCaptures >= 4);
delete mountedBatch.engineMount;
await run(mountedBatch, (p, o) => {
  if (o.label.endsWith(':evidence-identity')) {
    assert.equal(JSON.parse(p.split('\n').at(-1)).engineMount, null, 'no fallback to untrusted item/config mount');
    return identity;
  }
});
for (const [role, schema] of [['test-author', SCHEMAS.TEST_SCHEMA], ['runner', SCHEMAS.VERIFY_SCHEMA], ['integrator', SCHEMAS.INTEG_SCHEMA]]) {
  assert.deepEqual(first.calls.find(c => c.label.endsWith(':' + role)).schema, schema, role + ' native/port schema parity');
}
console.log('native-efficiency_test: all contract and execSmoke checks passed (no agents or git mutations)');
