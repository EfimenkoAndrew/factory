import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectEvidenceIdentity, readOnlyEvidenceGit, ENGINE_SOURCE_PATHS } from './evidence-identity.mjs';
import { preflightWorktreeInputs } from './worktree.mjs';

const metadata = { acceptance: 'complete', reviewerContract: { version: 1 } };
const oid = character => character.repeat(40);

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'factory-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositories = new Map();
  const write = (path, content = path) => {
    fs.mkdirSync(resolve(root, path, '..'), { recursive: true });
    fs.writeFileSync(resolve(root, path), content);
  };
  const repository = (path = '', head = oid('a')) => {
    const directory = resolve(root, path);
    fs.mkdirSync(directory, { recursive: true });
    write(path ? path + '/.git' : '.git', 'read-only interface fixture; not a Git repository');
    const data = { root: directory, head, index: [], untracked: [] };
    repositories.set(directory, data);
    return data;
  };
  const git = Object.fromEntries(['root', 'head', 'index', 'untracked'].map(key => [key, directory => {
    const data = repositories.get(resolve(directory));
    if (!data) throw new Error('Uninitialized fixture repository');
    return data[key];
  }]));
  const main = repository();
  const collect = (inputs = {}, options = {}) => collectEvidenceIdentity(root, { ...metadata, inputs }, { git, ...options });
  return { root, write, repository, main, git, collect };
}

test('recursive gitlinks bind index revision, child HEAD, nested tracked/untracked bytes and modes', t => {
  const f = fixture(t);
  f.main.index.push({ path: 'lib', mode: '160000', oid: oid('b') });
  const child = f.repository('lib', oid('c'));
  child.index.push({ path: 'source.cs', mode: '100644', oid: oid('d') }, { path: 'nested', mode: '160000', oid: oid('e') });
  const nested = f.repository('lib/nested', oid('f'));
  nested.index.push({ path: 'inner.cs', mode: '100644', oid: oid('1') });
  nested.untracked.push('new.cs');
  f.write('lib/source.cs', 'source');
  f.write('lib/nested/inner.cs', 'nested');
  f.write('lib/nested/new.cs', 'new');
  let last = f.collect();
  assert.equal(last.fileCount, 5);
  for (const mutate of [
    () => { child.head = oid('2'); },
    () => { f.main.index[0].oid = oid('3'); },
    () => f.write('lib/source.cs', 'changed'),
    () => f.write('lib/nested/inner.cs', 'changed'),
    () => f.write('lib/nested/new.cs', 'changed'),
    () => { nested.index[0].mode = '100755'; },
    () => fs.rmSync(join(f.root, 'lib/nested/inner.cs')),
  ]) {
    mutate();
    const next = f.collect();
    assert.notEqual(next.hash, last.hash);
    assert.notEqual(next.codeHash, last.codeHash);
    last = next;
  }
  assert.deepEqual(f.collect(), last);
});

test('missing, uninitialized, ancestor-fallback and failed recursive git reads fail closed', t => {
  const f = fixture(t);
  f.main.index.push({ path: 'lib', mode: '160000', oid: oid('b') });
  assert.throws(() => f.collect(), /submodule worktree/);
  fs.mkdirSync(join(f.root, 'lib'));
  assert.throws(() => f.collect(), /ENOENT/);
  f.repository('lib');
  assert.throws(() => f.collect({}, { git: { ...f.git, root: () => f.root } }), /uninitialized/);
  assert.throws(() => f.collect({}, { git: { ...f.git, index: () => { throw new Error('unreadable index'); } } }), /unreadable index/);
  f.main.index.push({ path: 'bad', mode: '100644', oid: oid('c') }, { path: 'bad', mode: '100644', oid: oid('d') });
  assert.throws(() => f.collect(), /unmerged index/);
});

test('ignored defaults, explicit files/directories/globs and contract changes invalidate both identities without emitting secrets', t => {
  const f = fixture(t);
  f.write('src/source.cs');
  f.main.index.push({ path: 'src/source.cs', mode: '100644', oid: oid('1') });
  f.write('src/.env', 'PASSWORD=first-secret');
  f.write('global.json', '{"sdk":"one"}');
  f.write('src/custom/settings.ini', 'first');
  f.write('src/custom/notes.md', 'build input in markdown');
  f.write('src/config/dependency.lock', 'first');
  const inputs = { includePaths: ['src/custom'], includeGlobs: ['**/config/*.lock'] };
  let last = f.collect(inputs);
  assert.equal(last.fileCount, 6);
  assert.equal(JSON.stringify(last).includes('first-secret'), false);
  for (const path of ['src/.env', 'global.json', 'src/custom/settings.ini', 'src/custom/notes.md', 'src/config/dependency.lock']) {
    f.write(path, 'second-secret');
    const next = f.collect(inputs);
    assert.notEqual(next.hash, last.hash, path);
    assert.notEqual(next.codeHash, last.codeHash, path);
    last = next;
  }
  assert.notEqual(f.collect({ ...inputs, includePaths: ['src/custom', 'not-created.ini'] }).codeHash, last.codeHash);
  assert.deepEqual(f.collect({ ...inputs, includePaths: ['src/custom', 'src/custom'] }), last);
  f.write('src/new.props', 'new ignored build config');
  assert.notEqual(f.collect(inputs).hash, last.hash);
});

test('generated trees are pruned before enumeration; tracked generated files remain evidence; explicit includes override generated pruning', t => {
  const f = fixture(t);
  f.write('node_modules/pkg/package.json');
  f.write('src/obj/generated.props');
  f.write('src/bin/tracked.cs');
  f.main.index.push({ path: 'src/bin/tracked.cs', mode: '100644', oid: oid('a') });
  const visited = [];
  const observedFs = { ...fs, readdirSync(path, ...args) {
    visited.push(path);
    return fs.readdirSync(path, ...args);
  } };
  assert.equal(f.collect({}, { fs: observedFs }).fileCount, 1);
  assert.ok(visited.every(path => !/node_modules|[/\\](obj|bin)$/.test(path)));
  assert.equal(f.collect({ includePaths: ['node_modules/pkg/package.json', 'src/obj'] }).fileCount, 3);
  assert.equal(f.collect({ generatedExcludes: [] }).fileCount, 3);
  assert.throws(() => f.collect({ includePaths: ['src/obj'], excludePaths: ['src'] }), /also excluded/);
  for (const inputs of [{ includePaths: ['../outside'] }, { includeGlobs: ['../**'] }, { includeGlobs: ['**/[abc]'] }, { typo: [] }]) {
    assert.throws(() => f.collect(inputs));
  }
  assert.throws(() => f.collect({ includePaths: ['.git'] }), /administrative/);
});

test('discovery and recursive content reads propagate failures rather than producing partial green identities', t => {
  const f = fixture(t);
  f.write('.env', 'secret');
  assert.throws(() => f.collect({}, { fs: { ...fs, readFileSync() { throw new Error('denied'); } } }), /denied/);
  assert.throws(() => f.collect({}, { fs: { ...fs, readdirSync() { throw new Error('denied'); } } }), /denied/);
});

test('working-tree executable mode changes and exclusion aliases are fingerprinted', t => {
  const f = fixture(t);
  f.write('Script.sh', 'echo fixture');
  f.main.index.push({ path: 'Script.sh', mode: '100644', oid: oid('a') });
  const plain = f.collect();
  const executable = f.collect({}, { fs: { ...fs, lstatSync(path, ...args) {
    const stat = fs.lstatSync(path, ...args);
    if (String(path).toLowerCase().endsWith('script.sh')) stat.mode |= 0o111;
    return stat;
  } } });
  assert.notEqual(executable.codeHash, plain.codeHash);
  assert.equal(f.collect({ excludePaths: ['./Script.sh'] }).fileCount, 0);
  if (process.platform === 'win32') assert.equal(f.collect({ excludePaths: ['SCRIPT.SH'] }).fileCount, 0);
  assert.throws(() => f.collect({ excludePaths: 'Script.sh' }), /Invalid input contract/);
});

test('production read-only Git interface agrees with actual repository HEAD/index without creating Git fixtures', () => {
  const root = execFileSync('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  assert.equal(readOnlyEvidenceGit.head(root), execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  const index = readOnlyEvidenceGit.index(root);
  assert.ok(index.some(entry => entry.path === '_workflow/lib/locks.mjs' && entry.mode === '100644'));
  assert.ok(Array.isArray(readOnlyEvidenceGit.untracked(root)));
});

test('fresh recommended engine gitlink is separate from required product submodules and fingerprints live engine contracts', t => {
  const f = fixture(t);
  const live = fixture(t);
  for (const path of ENGINE_SOURCE_PATHS) {
    if (path === 'VERSION') live.write(path, '1.0.0');
    else live.write(path + '/source.txt', 'effective engine source');
  }
  const mount = '_bmad-output/ai-factory';
  fs.mkdirSync(join(f.root, mount), { recursive: true });
  f.main.index.push({ path: mount, mode: '160000', oid: oid('b') });
  const engineMount = { path: mount, sourceRoot: live.root };
  const reviewerContract = { version: 'effective-v1', briefs: { fixer: 'effective instructions' } };
  const meta = { ...metadata, reviewerContract, engineMount };
  const calls = [];
  const git = Object.fromEntries(['root', 'head', 'index', 'untracked'].map(key => [key, directory => {
    calls.push([key, directory]);
    return (resolve(directory) === live.root ? live.git : f.git)[key](directory);
  }]));
  const collect = (extra = {}) => preflightWorktreeInputs(f.root, { ...meta, ...extra }, { git });
  let previous = collect();
  assert.equal(previous.fileCount, 0);
  assert.equal(calls.some(([, directory]) => directory === join(f.root, mount)), false);
  for (const mutate of [
    () => live.write('_workflow/source.txt', 'changed engine implementation'),
    () => live.write('VERSION', '1.0.1'),
    () => { live.main.head = oid('c'); },
    () => { reviewerContract.briefs.fixer = 'changed effective profile/brief'; },
  ]) {
    mutate();
    const current = collect();
    assert.notEqual(current.hash, previous.hash);
    assert.notEqual(current.codeHash, previous.codeHash);
    previous = current;
  }
  assert.throws(() => collect({ engineMount: undefined }), /ENOENT|submodule/);
  for (const bad of [{ path: mount }, { sourceRoot: live.root }, { path: '../outside', sourceRoot: live.root }, { ...engineMount, sourceHash: 'caller assertion' }]) {
    assert.throws(() => collect({ engineMount: bad }));
  }
  for (const bad of ['opaque', {}, { briefs: {} }, { briefs: { fixer: '' } }]) {
    assert.throws(() => collect({ reviewerContract: bad }), /effective reviewerContract/);
  }
  f.main.index.push({ path: mount + '-product', mode: '160000', oid: oid('d') });
  assert.throws(collect, /submodule worktree/);
  assert.throws(() => collect({ inputs: { excludePaths: [mount + '-product'] } }), /submodule worktree/);
  f.repository(mount + '-product');
  assert.doesNotThrow(collect);
  fs.rmSync(join(live.root, 'schema'), { recursive: true });
  assert.throws(collect, /Missing required live engine source/);
});
