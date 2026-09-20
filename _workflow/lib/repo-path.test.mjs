import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runInNewContext } from 'node:vm';
import { canonicalRepoPath, normalizeHostPath } from './repo-path.mjs';
import { conflictFor, lockedFiles } from './locks.mjs';
import { computeReady } from './graph.mjs';
import { disjointItems } from './driver-integration.mjs';
import { dirtyMainPaths, filesOverlapDirty, unclaimedMainDrift, repairDirtyDrift,
  splitDriftByStatus, snapshotMainFiles, driftAgainstSnapshot } from './mainguard.mjs';

test('repository identity equates separator/dot/parent aliases and respects host case', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const value of ['src/Foo.cs', 'src\\Foo.cs', './src//Foo.cs', 'src/./Foo.cs', 'src/bar/../Foo.cs']) {
      assert.equal(canonicalRepoPath(value, platform), platform === 'win32' ? 'src/foo.cs' : 'src/Foo.cs');
    }
  }
  assert.equal(canonicalRepoPath('SRC/FOO.CS', 'win32'), 'src/foo.cs');
  assert.notEqual(canonicalRepoPath('src/Foo.cs', 'linux'), canonicalRepoPath('src/foo.cs', 'linux'));
  assert.equal(canonicalRepoPath('src/Foo.cs'), process.platform === 'win32' ? 'src/foo.cs' : 'src/Foo.cs');
  assert.equal(canonicalRepoPath('src/with space.cs', 'linux'), 'src/with space.cs');
});

test('invalid repository identities throw instead of becoming nonconflicts', () => {
  const invalid = [null, undefined, 7, {}, '', '.', './', 'a/..', '..', '../src/Foo.cs',
    'a/../../Foo.cs', 'a/../../a/Foo.cs', '..\\src\\Foo.cs', '/src/Foo.cs', '\\src\\Foo.cs',
    'C:/src/Foo.cs', 'c:src/Foo.cs', '//server/share/file', '\\\\?\\C:\\src', 'bad\0file'];
  for (const platform of ['linux', 'win32']) {
    for (const value of invalid) assert.throws(() => canonicalRepoPath(value, platform), /Invalid repository path/);
  }
  for (const value of ['src/Foo.cs.', 'src/Foo.cs ', 'src/Foo.cs:stream', 'src/.. /Foo.cs', 'src/CON.txt', 'src/AUX', 'src/a?b.cs']) {
    assert.throws(() => canonicalRepoPath(value, 'win32'), /Invalid repository path/);
  }
  assert.equal(canonicalRepoPath('src/Foo.cs.', 'linux'), 'src/Foo.cs.');
});

test('canonical helper executes in Workflow-style context without process or imports', () => {
  const canonical = runInNewContext('(' + canonicalRepoPath.toString() + ')');
  assert.equal(canonical('SRC\\sub\\..\\Foo.cs', 'win32'), 'src/foo.cs');
  assert.equal(canonical('SRC/./Foo.cs', 'linux'), 'SRC/Foo.cs');
  assert.throws(() => canonical('../Foo.cs', 'win32'), /escapes repository root/);
});

test('host transcript identity normalizes MSYS, drive case, UNC, base and boundary siblings', () => {
  const windows = { platform: 'win32', base: 'C:\\Repo\\Worktree' };
  for (const value of ['C:\\Repo\\Worktree\\src\\Foo.sln', 'c:/REPO/worktree/src/./Foo.sln',
    '/c/Repo/Worktree/src/Foo.sln', 'src/Foo.sln', './src/sub/../Foo.sln']) {
    assert.equal(normalizeHostPath(value, windows), 'c:/repo/worktree/src/foo.sln');
  }
  assert.equal(normalizeHostPath('\\\\Server\\Share\\Dir\\..\\Foo', windows), '//server/share/foo');
  assert.equal(normalizeHostPath('/C', windows), 'c:/');
  assert.equal(normalizeHostPath('C:/a/..', windows), 'c:/');
  assert.equal(normalizeHostPath('../Sibling/file', windows), 'c:/repo/sibling/file');
  assert.equal(normalizeHostPath('src/Foo.sln', { platform: 'linux', base: '/Repo' }), '/Repo/src/Foo.sln');
  assert.equal(normalizeHostPath('/c/Repo', { platform: 'linux' }), '/c/Repo');
  const root = normalizeHostPath('C:/Repo/Worktree', windows);
  assert.equal(normalizeHostPath('C:/Repo/Worktree-other/file', windows).startsWith(root + '/'), false);
  for (const value of ['C:relative', '/ambiguous/root', '//server', '//?/C:/file', 'C:/../file', 'C:/Repo/file:stream']) {
    assert.throws(() => normalizeHostPath(value, windows), /Invalid (host|repository) path/);
  }
  assert.throws(() => normalizeHostPath('relative', { platform: 'linux' }), /requires base/);
  assert.throws(() => normalizeHostPath('relative', { platform: 'win32', base: 'relative' }), /requires base/);
});

const graphFixture = () => ({ items: [
  { id: 'ACTIVE', files: ['src/Foo.cs'] },
  { id: 'SLASH', files: ['src\\Foo.cs'] },
  { id: 'DOT', files: ['./src/./Foo.cs'] },
  { id: 'PARENT', files: ['src/sub/../Foo.cs'] },
  { id: 'CASE', files: ['SRC/FOO.CS'] },
  { id: 'OTHER', files: ['src/Foobar.cs'] },
] });
const ledgerFixture = (graph) => ({ items: Object.fromEntries(graph.items.map((wi) => [wi.id,
  { state: wi.id === 'ACTIVE' ? 'CLAIMED' : 'READY', attempts: 0 }])) });

test('active locks block equivalent repository identities on Windows and POSIX', () => {
  for (const platform of ['win32', 'linux']) {
    const graph = graphFixture();
    const locks = lockedFiles(graph, ledgerFixture(graph), platform);
    for (const item of graph.items.slice(1, 4)) {
      assert.deepEqual(conflictFor(item, locks, platform), { file: item.files[0], heldBy: 'ACTIVE' });
    }
    assert.equal(!!conflictFor(graph.items[4], locks, platform), platform === 'win32');
    assert.equal(conflictFor(graph.items[5], locks, platform), null);
    assert.equal(conflictFor({ files: ['src/Foo.cs'] }, new Map([['src\\.\\Foo.cs', 'RAW']]), platform).heldBy, 'RAW');
    assert.throws(() => conflictFor({ files: ['src/Foo.cs', '../bad'] }, locks, platform), /Invalid repository path/);
    assert.throws(() => conflictFor({ files: [] }, new Map([['../bad', 'RAW']]), platform), /Invalid repository path/);
  }
});

test('computeReady cannot schedule aliases of active files or invalid paths', () => {
  const graph = graphFixture();
  const ledger = ledgerFixture(graph);
  assert.deepEqual(computeReady(graph, ledger).map((wi) => wi.id), process.platform === 'win32' ? ['OTHER'] : ['CASE', 'OTHER']);
  ledger.items.ACTIVE.state = 'CLOSED';
  assert.equal(computeReady(graph, ledger).length, 5);
  ledger.items.ACTIVE.state = 'CLAIMED';
  graph.items[0].files = ['../outside.cs'];
  assert.throws(() => computeReady(graph, ledger), /escapes repository root/);
  graph.items[0].files = ['src/Foo.cs'];
  graph.items[5].files = ['C:\\outside.cs'];
  assert.throws(() => computeReady(graph, ledger), /Invalid repository path/);
});

test('batch disjoint selection cannot admit aliases and refills with genuinely disjoint work', () => {
  const graph = graphFixture();
  assert.deepEqual(disjointItems(graph.items).map((wi) => wi.id), process.platform === 'win32' ? ['ACTIVE', 'OTHER'] : ['ACTIVE', 'CASE', 'OTHER']);
  assert.deepEqual(disjointItems(graph.items, 2).map((wi) => wi.id), process.platform === 'win32' ? ['ACTIVE', 'OTHER'] : ['ACTIVE', 'CASE']);
  assert.throws(() => disjointItems([{ files: ['src/Foo.cs'] }, { files: ['../outside.cs'] }]), /Invalid repository path/);
});

test('dirty overlaps and unclaimed checks use keys but preserve original reporting paths', () => {
  const dirty = { paths: ['SRC\\.\\Foo.cs'], dirs: ['Tests\\New\\'] };
  const files = ['src/sub/../foo.CS', 'tests/new/Test.cs', 'tests/new', 'tests/newer/Test.cs', 'src/Other.cs'];
  assert.deepEqual(filesOverlapDirty(files, dirty, 'win32'), files.slice(0, 3));
  assert.deepEqual(filesOverlapDirty(files, dirty, 'linux'), []);
  const state = { paths: ['SRC/Foo.cs', 'Factory/State/ledger.json', 'Factory-other/user.cs'], dirs: ['Tests/New/'] };
  assert.deepEqual(unclaimedMainDrift(state, './FACTORY/', new Set(['src\\Foo.cs', 'tests/new/Test.cs']), 'win32'), ['Factory-other/user.cs']);
  assert.deepEqual(unclaimedMainDrift({ paths: ['owner.cs'], dirs: [] }, '.', new Set(), 'linux'), ['owner.cs']);
  assert.throws(() => filesOverlapDirty(['../bad'], { paths: [], dirs: [] }), /Invalid repository path/);
  assert.throws(() => filesOverlapDirty([], { paths: ['../bad'], dirs: [] }), /Invalid repository path/);
  assert.throws(() => unclaimedMainDrift(state, 'Factory', new Set(['../bad'])), /Invalid repository path/);
  assert.throws(() => snapshotMainFiles('unused', ['../outside']), /Invalid repository path/);
  assert.throws(() => driftAgainstSnapshot('unused', { '../outside': null }), /Invalid repository path/);
});

test('porcelain NUL parsing preserves names/rename sources and status failures fail closed', (t) => {
  const calls = [];
  const unusualName = process.platform === 'win32' ? 'café original.cs' : 'café -> "original"\n.cs';
  let output = ' M src/Foo.cs\0?? ' + unusualName + '\0R  new.cs\0old.cs\0?? Tests/New/\0 T type-change.cs\0';
  t.mock.method(childProcess, 'execFileSync', (...args) => { calls.push(args); return output; });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(dirtyMainPaths('repo'), { paths: ['src/Foo.cs', unusualName, 'new.cs', 'old.cs', 'type-change.cs'], dirs: ['Tests/New/'] });
    assert.ok(calls[0][1].includes('-z'));
    const drift = [{ file: 'src\\.\\Foo.cs' }, { file: 'clean.cs' }];
    assert.deepEqual(splitDriftByStatus('repo', drift), { dirty: [drift[0]], committed: [drift[1]] });
    output = '?? ../escape\0';
    assert.throws(() => dirtyMainPaths('repo'), /Invalid repository path/);
    output = 'R  new.cs\0';
    assert.throws(() => dirtyMainPaths('repo'), /Invalid repository path/);
    t.mock.method(childProcess, 'execFileSync', () => { throw new Error('status unavailable'); });
    syncBuiltinESMExports();
    assert.throws(() => dirtyMainPaths('repo'), /status unavailable/);
    assert.deepEqual(splitDriftByStatus('repo', drift), { dirty: drift, committed: [] });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('repair compatibility API is honest and diagnostic-only even for frozen owner records', (t) => {
  const calls = [];
  const warnings = [];
  t.mock.method(childProcess, 'execFileSync', (...args) => { calls.push(args); throw new Error('forbidden'); });
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  syncBuiltinESMExports();
  try {
    const dirty = Object.freeze([Object.freeze({ file: 'owner.cs', was: 'present' }), Object.freeze({ file: 'new-owner.cs', was: 'absent' })]);
    assert.deepEqual(repairDirtyDrift('repo', dirty), []);
    assert.deepEqual(calls, []);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((line) => line.includes('owner review required') && line.includes('No repair performed')));
    assert.deepEqual(repairDirtyDrift('repo', []), []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
