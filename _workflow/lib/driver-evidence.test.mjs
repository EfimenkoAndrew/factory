import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { driverEngineMount, preflightProductGitlinks } from './driver-evidence.mjs';

test('only the actual installed engine gitlink is excluded; product gitlinks require initialization', t => {
  const root = mkdtempSync(join(tmpdir(), 'driver-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const factory = join(root, 'tools/factory');
  mkdirSync(factory, { recursive: true });
  const entries = [{ mode: '160000', path: 'tools/factory' }, { mode: '160000', path: 'product' }];
  const indexes = new Map([[resolve(root), entries]]);
  const git = { index: dir => indexes.get(resolve(dir)) || [], root: dir => dir, head: () => 'a'.repeat(40) };
  const engineMount = driverEngineMount(root, factory, { git });
  assert.equal(engineMount.path, 'tools/factory');
  assert.equal(driverEngineMount(root, root, { git }), null);
  entries[0].mode = '100644';
  assert.equal(driverEngineMount(root, factory, { git }), null);
  entries[0].mode = '160000';
  assert.throws(() => preflightProductGitlinks(root, engineMount, { git }), /product.*owner to initialize\/update/);
  mkdirSync(join(root, 'product')); writeFileSync(join(root, 'product/.git'), 'injected git fixture');
  assert.doesNotThrow(() => preflightProductGitlinks(root, engineMount, { git }));
  indexes.set(resolve(root, 'product'), [{ mode: '160000', path: 'nested' }]);
  assert.throws(() => preflightProductGitlinks(root, engineMount, { git }), /product\/nested/);
  assert.throws(() => preflightProductGitlinks(root, engineMount, { git: { ...git, root: () => root } }), /product.*initialize/);
});
