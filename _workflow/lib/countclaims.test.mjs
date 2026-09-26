import { testRoot } from './_test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lintItemCountClaims, resolveCountClaimTranscripts } from './countclaims.mjs';
import { resolveBash } from './bash.mjs';

const hash = 'a'.repeat(64);
const raw = n => `FACTORY::SUMMARY::suite exit=0 failed=0 passed=${n} skipped=0\n`;
const digest = s => createHash('sha256').update(s).digest('hex');
function fixture() {
  const dir = mkdtempSync(join(testRoot, 'counts-'));
  const wt = join(dir, 'work tree'); const item = join(dir, 'item');
  mkdirSync(wt); mkdirSync(item);
  const initial = join(item, 'verify-initial-run-claim.txt');
  const final = join(item, 'verify-final-' + hash + '.txt');
  writeFileSync(initial, raw(5)); writeFileSync(final, raw(7));
  writeFileSync(join(item, 'verify-raw.txt'), raw(5)); writeFileSync(join(item, 'integrate-raw.txt'), raw(5));
  const claim = { id: 'A', attemptIdentity: { runId: 'run', claimId: 'claim', attemptNumber: 1, reservedAt: '2026-01-01T00:00:00Z' } };
  const progress = { id: 'A', runId: 'run', claimId: 'claim', attemptNumber: 1, nativeEvidenceVersion: 1,
    initialVerification: { passId: 'run-claim', transcript: initial },
    finalVerification: { refreshed: true, codeChanged: true, evidenceHash: hash, transcript: final },
    evidenceIdentity: { hash, request: { verificationTranscript: final } } };
  const commands = [];
  const deps = { execFileSync: (cmd, args) => {
    commands.push([cmd, args]); assert.equal(cmd, 'git');
    if (args[2] === 'diff') return '+7/7 passed\n';
    assert.equal(args[2], 'ls-files'); assert.ok(args.includes('-z')); return '';
  } };
  return { dir, wt, item, initial, final, claim, progress, deps, commands };
}

test('correct current-only counts pass; stale-only claims fail; selected source is exact', () => {
  const f = fixture();
  const options = { progress: f.progress, claim: f.claim, transcripts: [f.final] };
  const report = lintItemCountClaims(f.wt, f.item, options, f.deps);
  assert.equal(report.status, 'clean');
  assert.deepEqual(report.sources, [{ path: resolve(f.final), sha256: digest(raw(7)), pairs: ['7/7'] }]);
  const stale = lintItemCountClaims(f.wt, f.item, options, { execFileSync: (_cmd, args) => args[2] === 'diff' ? '+5/5 passed\n' : '' });
  assert.equal(stale.status, 'mismatch'); assert.deepEqual(stale.missing, ['5/5']);
  const refused = lintItemCountClaims(f.wt, f.item, { ...options, transcripts: [f.initial] }, f.deps);
  assert.equal(refused.status, 'unavailable'); assert.deepEqual(refused.sources, []);
  assert.equal(lintItemCountClaims(f.wt, f.item, { ...options, transcripts: [join(f.item, 'verify-raw.txt')] }, f.deps).status, 'unavailable');
  assert.equal(f.commands.length, 6);
});

test('explicit untracked Markdown uses real filesystem reads, including spaces/Unicode and UTF16', () => {
  const f = fixture();
  const name = 'new counts — report.md';
  writeFileSync(join(f.wt, name), Buffer.concat([Buffer.from([255, 254]), Buffer.from('7/7 passed', 'utf16le')]));
  const commands = [];
  const deps = { execFileSync: (cmd, args) => { commands.push(cmd); return args[2] === 'diff' ? '' : name + '\0'; } };
  assert.equal(lintItemCountClaims(f.wt, f.item, { transcripts: [f.final] }, deps).status, 'clean');
  assert.deepEqual(commands, ['git', 'git']);
  writeFileSync(join(f.wt, name), '5/5 passed');
  assert.deepEqual(lintItemCountClaims(f.wt, f.item, { transcripts: [f.final] }, deps).missing, ['5/5']);
});

test('claim, item, attempt, mtime, hash and physical containment failures never become clean', () => {
  const f = fixture();
  const options = { progress: f.progress, claim: f.claim };
  for (const change of [{ id: 'B' }, { claimId: 'old' }, { runId: 'old' }, { attemptNumber: 2 }]) {
    assert.equal(lintItemCountClaims(f.wt, f.item, { ...options, progress: { ...f.progress, ...change } }, f.deps).status, 'unavailable');
  }
  assert.equal(lintItemCountClaims(f.wt, f.item, { progress: f.progress }, f.deps).status, 'unavailable');
  assert.equal(lintItemCountClaims(f.wt, f.item, { transcripts: [{ path: f.final, sha256: '0'.repeat(64) }] }, f.deps).status, 'unavailable');
  utimesSync(f.final, new Date('2025-01-01'), new Date('2025-01-01'));
  assert.equal(lintItemCountClaims(f.wt, f.item, options, f.deps).status, 'unavailable');
  const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'report.md'), '7/7 passed');
  symlinkSync(outside, join(f.wt, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = lintItemCountClaims(f.wt, f.item, { transcripts: [f.initial] }, { execFileSync: (_cmd, a) => a[2] === 'diff' ? '' : 'link/report.md\0' });
  assert.equal(escaped.status, 'unavailable'); assert.match(escaped.errors[0], /outside/);
  const sibling = join(f.dir, 'item-sibling'); mkdirSync(sibling); writeFileSync(join(sibling, 'verify-raw.txt'), raw(7));
  assert.equal(lintItemCountClaims(f.wt, f.item, { transcripts: [join(sibling, 'verify-raw.txt')] }, f.deps).status, 'unavailable');
});

test('missing, unreadable and empty evidence remain distinct from a completed mismatch', () => {
  const f = fixture();
  assert.equal(lintItemCountClaims(f.wt, f.item, {}, f.deps).status, 'missing-evidence');
  assert.equal(lintItemCountClaims(f.wt, f.item, { transcripts: [join(f.item, 'verify-final-' + 'b'.repeat(64) + '.txt')] }, f.deps).status, 'missing-evidence');
  const bad = join(f.item, 'verify-initial-directory.txt'); mkdirSync(bad);
  assert.equal(lintItemCountClaims(f.wt, f.item, { transcripts: [bad] }, f.deps).status, 'unavailable');
  writeFileSync(f.final, 'no counts');
  assert.equal(lintItemCountClaims(f.wt, f.item, { transcripts: [f.final] }, f.deps).status, 'missing-evidence');
  const failedGit = lintItemCountClaims(f.wt, f.item, { transcripts: [f.initial] }, { execFileSync() { throw new Error('git unavailable'); } });
  assert.equal(failedGit.status, 'unavailable'); assert.deepEqual(failedGit.sources, []);
  const failedRead = lintItemCountClaims(f.wt, f.item, { transcripts: [f.initial] }, { execFileSync: (_c, a) => a[2] === 'diff' ? '' : 'vanished.md\0' });
  assert.equal(failedRead.status, 'unavailable');
});

test('legacy fallback requires explicit absence of active contract and never searches archives', () => {
  const f = fixture();
  assert.equal(resolveCountClaimTranscripts({ itemDir: f.item, legacy: true }).status, 'unavailable');
  assert.equal(resolveCountClaimTranscripts({ itemDir: f.item, legacy: true, noActiveContract: true, progress: f.progress, claim: f.claim }).status, 'unavailable');
  const report = lintItemCountClaims(f.wt, f.item, { legacy: true, noActiveContract: true }, f.deps);
  assert.equal(report.status, 'mismatch'); assert.deepEqual(report.missing, ['7/7']);
  assert.deepEqual(report.sources.map(s => s.path), ['verify-raw.txt', 'integrate-raw.txt'].map(n => join(f.item, n)));
  assert.equal(resolveCountClaimTranscripts({ itemDir: f.item, transcripts: [f.final + '.prior-1'] }).status, 'unavailable');
});

test('OpenCode progress and portable proof select current hash-bound transcripts', () => {
  const f = fixture();
  writeFileSync(join(f.item, 'verify-raw.txt'), raw(7));
  const p = { id: 'A', runId: 'run', claimId: 'claim', attemptNumber: 1,
    content: { hash }, evidence: { complete: true, hash, rawHash: digest(raw(7)) } };
  assert.equal(lintItemCountClaims(f.wt, f.item, { progress: p, claim: f.claim }, f.deps).status, 'clean');
  const portable = { id: 'A', runId: 'run', claimId: 'claim', attemptNumber: 1, portableEvidence: {
    version: 1, runtime: 'opencode', runId: 'run', claimId: 'claim', attemptNumber: 1, identity: { hash },
    verification: { transcript: 'verify-raw.txt', rawHash: digest(raw(7)), complete: true, identityHash: hash } } };
  assert.equal(lintItemCountClaims(f.wt, f.item, { progress: portable, claim: f.claim }, f.deps).status, 'clean');
  writeFileSync(join(f.item, 'verify-raw.txt'), raw(5));
  assert.equal(lintItemCountClaims(f.wt, f.item, { progress: p, claim: f.claim }, f.deps).status, 'unavailable');
});

test('CLI and build-test forward exact current refs and report errors without a clean marker', () => {
  const f = fixture();
  const cli = new URL('../countclaims-lint.mjs', import.meta.url);
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const run = spawnSync(process.execPath, [fileURLToPath(cli), repo, f.item, '--transcript', f.final], { encoding: 'utf8' });
  assert.ok([0, 1].includes(run.status), run.stdout + run.stderr);
  assert.ok(run.stdout.includes('FACTORY::COUNTCLAIMS-SOURCE::' + JSON.stringify({ path: resolve(f.final), sha256: digest(raw(7)), pairs: ['7/7'] })));
  assert.equal(run.stdout.includes('verify-raw.txt"'), false);
  const unavailable = spawnSync(process.execPath, [fileURLToPath(cli), f.wt, f.item], { encoding: 'utf8' });
  assert.equal(unavailable.status, 2);
  assert.ok(unavailable.stdout.includes('FACTORY::COUNTCLAIMS-STATUS::unavailable'));
  assert.equal(unavailable.stdout.includes('FACTORY::COUNTCLAIMS::0'), false);
  const shell = spawnSync(resolveBash(), [join(repo, 'verify', 'build-test.sh'), 'countclaims', repo, f.item, '--transcript', f.final], { encoding: 'utf8' });
  assert.equal(shell.status, run.status, shell.stdout + shell.stderr);
  assert.equal(shell.stdout, run.stdout);
  assert.ok(readFileSync(new URL('../../verify/build-test.sh', import.meta.url), 'utf8').includes('"${@:4}"'));
});
