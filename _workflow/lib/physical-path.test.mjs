import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoPathIdentity, repoPathsOverlap } from './repo-path.mjs';
import { lockedFiles, conflictFor } from './locks.mjs';
import { filesOverlapDirty, unclaimedMainDrift, snapshotMainFiles, driftAgainstSnapshot, matchWorktreeDebris } from './mainguard.mjs';
import { collectEvidenceIdentity } from './evidence-identity.mjs';
import { disjointItems } from './driver-integration.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(join(tmpdir(), 'factory-path-'));
  const root = join(base, 'repo');
  fs.mkdirSync(join(root, 'src'), { recursive: true });
  fs.mkdirSync(join(base, 'outside'));
  fs.writeFileSync(join(root, 'src/file.cs'), 'owner content');
  fs.writeFileSync(join(base, 'outside/secret'), 'outside secret');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, options: { repoRoot: root } };
}

function linkOrSkip(t, action) {
  try { action(); return true; }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    t.skip('Actual filesystem link creation denied: ' + error.code);
    return false;
  }
}

test('existing hardlink aliases conflict in locks and dirty guards and preserve reporting paths', t => {
  const f = fixture(t);
  if (!linkOrSkip(t, () => fs.linkSync(join(f.root, 'src/file.cs'), join(f.root, 'alias.cs')))) return;
  assert.ok(repoPathsOverlap(repoPathIdentity('src/file.cs', f.options), repoPathIdentity('alias.cs', f.options)));
  const graph = { items: [{ id: 'A', files: ['src/file.cs'] }] };
  const locks = lockedFiles(graph, { items: { A: { state: 'CLAIMED' } } }, f.options);
  assert.deepEqual(conflictFor({ files: ['alias.cs'] }, locks), { file: 'alias.cs', heldBy: 'A' });
  assert.deepEqual(conflictFor({ files: ['alias.cs'] }, new Map([['src/file.cs', 'A']]), f.options), { file: 'alias.cs', heldBy: 'A' });
  const dirty = { paths: ['alias.cs'], dirs: [] };
  assert.deepEqual(filesOverlapDirty(['src/file.cs'], dirty, f.options), ['src/file.cs']);
  assert.deepEqual(unclaimedMainDrift(dirty, '', ['src/file.cs'], f.options), []);
  const snap = snapshotMainFiles(f.root, ['src/file.cs']);
  fs.writeFileSync(join(f.root, 'alias.cs'), 'owner changed');
  assert.equal(driftAgainstSnapshot(f.root, snap).length, 1);
  assert.equal(fs.readFileSync(join(f.root, 'alias.cs'), 'utf8'), 'owner changed');
});

test('directory links canonicalize existing and new children through physical parents', t => {
  const f = fixture(t);
  if (!linkOrSkip(t, () => fs.symlinkSync(join(f.root, 'src'), join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir'))) return;
  for (const name of ['file.cs', 'new/deeper.cs']) {
    assert.deepEqual(repoPathIdentity('alias/' + name, f.options).keys, repoPathIdentity('src/' + name, f.options).keys);
  }
  const locks = lockedFiles({ items: [{ id: 'A', files: ['alias/new.cs'] }] }, { items: { A: { state: 'CLAIMED' } } }, f.options);
  assert.equal(conflictFor({ files: ['src/new.cs'] }, locks).heldBy, 'A');
  assert.deepEqual(filesOverlapDirty(['alias/new.cs'], { paths: [], dirs: ['src/'] }, f.options), ['alias/new.cs']);
  assert.deepEqual(unclaimedMainDrift({ paths: ['alias/file.cs'], dirs: [] }, 'src', [], f.options), []);
  for (const directory of ['alias/new-area/', 'alias/./new-area/.', 'alias/new-area/sub/..']) {
    const items = [{ id: 'DIR', files: [directory] }, { id: 'CHILD', files: ['src/new-area/file.cs'] }];
    for (const ordered of [items, [...items].reverse()]) {
      const locks = lockedFiles({ items: ordered }, { items: { [ordered[0].id]: { state: 'CLAIMED' } } }, f.options);
      assert.equal(conflictFor(ordered[1], locks).heldBy, ordered[0].id);
      assert.deepEqual(disjointItems(ordered, Infinity, f.options), [ordered[0]]);
    }
  }
});

test('nonexistent directory claims retain slash, backslash and dot intent in either scheduling order', t => {
  const f = fixture(t);
  for (const options of [f.options, {}]) {
    for (const directory of ['new-area/', './new-area//', 'new-area\\', 'new-area/.', 'new-area/sub/..']) {
      assert.equal(repoPathIdentity(directory, options).directory, true);
      const items = [{ id: 'DIR', files: [directory] }, { id: 'CHILD', files: ['new-area/child.cs'] }];
      for (const ordered of [items, [...items].reverse()]) {
        const locks = lockedFiles({ items: ordered }, { items: { [ordered[0].id]: { state: 'CLAIMED' } } }, options);
        assert.equal(conflictFor(ordered[1], locks).heldBy, ordered[0].id);
        assert.deepEqual(disjointItems(ordered, Infinity, options), [ordered[0]]);
      }
      assert.equal(conflictFor({ files: ['new-area-other/child.cs'] }, new Map([[directory, 'DIR']]), options), null);
    }
  }
  assert.throws(() => repoPathIdentity('src/file.cs/', f.options), /directory is a file/);
});

test('outside directory symlinks fail closed for existing/new paths, snapshots, locks and debris', t => {
  const f = fixture(t);
  if (!linkOrSkip(t, () => fs.symlinkSync(join(f.base, 'outside'), join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'))) return;
  for (const path of ['escape/secret', 'escape/new.cs', 'escape/../src/file.cs']) {
    assert.throws(() => repoPathIdentity(path, f.options), /outside repository/);
    assert.throws(() => snapshotMainFiles(f.root, [path]), /outside repository/);
    assert.throws(() => conflictFor({ files: [path] }, new Map(), f.options), /outside repository/);
  }
  assert.throws(() => matchWorktreeDebris(f.root, ['escape/'], [], f.base), /outside repository/);
  assert.equal(fs.readFileSync(join(f.base, 'outside/secret'), 'utf8'), 'outside secret');
});

test('file symlink identity binds target bytes, rejects outside targets and dangling links', t => {
  const f = fixture(t);
  const link = join(f.root, 'link.cs');
  let target = join(f.root, 'src/file.cs');
  let io = fs;
  let nativeLink = true;
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
    nativeLink = false;
    t.diagnostic('Native file-symlink creation unavailable (' + error.code + '); injecting only link metadata/realpath, retaining real target bytes and actual junction coverage');
    const isLink = path => resolve(path) === link;
    io = {
      ...fs,
      lstatSync: (path, options) => isLink(path) ? { mode: 0o120777, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true } : fs.lstatSync(path, options),
      realpathSync: path => fs.realpathSync(isLink(path) ? target : path),
      statSync: (path, options) => fs.statSync(isLink(path) ? target : path, options),
      readlinkSync: (path, options) => isLink(path) ? target : fs.readlinkSync(path, options),
    };
  }
  const retarget = next => {
    target = next;
    if (nativeLink) { fs.unlinkSync(link); fs.symlinkSync(target, link, 'file'); }
  };
  const git = { root: () => f.root, head: () => 'a'.repeat(40), index: () => [{ path: 'link.cs', mode: '120000', oid: 'b'.repeat(40) }], untracked: () => [] };
  const collect = () => collectEvidenceIdentity(f.root, { reviewerContract: 'test', inputs: { discoverDefaults: false } }, { git, fs: io });
  assert.deepEqual(repoPathIdentity('link.cs', { repoRoot: f.root, fs: io }).keys, repoPathIdentity('src/file.cs', f.options).keys);
  const original = collect();
  fs.writeFileSync(join(f.root, 'src/file.cs'), 'changed target');
  assert.notEqual(collect().codeHash, original.codeHash);
  retarget(join(f.base, 'outside/secret'));
  assert.throws(collect, /outside repository/);
  assert.equal(fs.readFileSync(join(f.base, 'outside/secret'), 'utf8'), 'outside secret');
  retarget(join(f.root, 'missing'));
  assert.throws(collect, /ENOENT/);
});
