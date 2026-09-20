import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBuildTest } from './buildtest.mjs';
import { buildCapacity } from './build-lease.mjs';
import { evidenceIntact, effectiveBaselineFor } from './runtime.mjs';
import { digest, EVIDENCE_IDENTITY_VERSION, snapshotTree } from './identity.mjs';
import { ENGINE_SOURCE_PATHS } from '../lib/evidence-identity.mjs';

const temp = mkdtempSync(join(tmpdir(), 'port-shared-'));
try {
  const calls = [];
  const spawn = (exe, args, options) => {
    calls.push({ exe, args, options });
    if (args[0] === '-c') return exe === 'usable-bash' ? { status: 0 } : { status: 1, stderr: 'unavailable' };
    return { status: 1, stdout: 'structured failure markers', stderr: '' };
  };
  const result = runBuildTest('/factory', 'suite', ['/wt/A.sln'], { env: { OPENCODE_FACTORY_BASH: 'usable-bash' }, cwd: '/wt' }, { spawn, platform: 'linux' });
  assert.equal(result.code, 1); assert.equal(result.output, 'structured failure markers');
  assert.deepEqual(calls.map(c => c.args), [['-c', 'exit 0'], ['/factory/verify/build-test.sh', 'suite', '/wt/A.sln']]);
  assert.equal(calls[1].options.cwd, '/wt');
  assert.throws(() => runBuildTest('/factory', 'suite', [], { env: {} }, { platform: 'linux', spawn: () => ({ status: 1, stderr: 'broken PATH stub' }) }), /No usable Bash/);

  mkdirSync(join(temp, 'state/items/I'), { recursive: true });
  mkdirSync(join(temp, 'config'));
  assert.equal(buildCapacity(temp, 3), 3);
  writeFileSync(join(temp, 'state/build-capacity.json'), '{"limit":2}');
  writeFileSync(join(temp, 'state/opencode-build-capacity.json'), '{"limit":9}');
  assert.equal(buildCapacity(temp, 7), 2, 'legacy and dispatcher cannot bypass shared capacity');
  writeFileSync(join(temp, 'state/opencode-build-capacity.json'), '{"limit":1}');
  assert.equal(buildCapacity(temp, 7), 1, 'lower legacy fence remains binding');
  writeFileSync(join(temp, 'state/opencode-build-capacity.json'), '{"limit":0}');
  assert.throws(() => buildCapacity(temp), /invalid/);

  const dir = join(temp, 'state/items/I'), raw = 'proof';
  writeFileSync(join(dir, 'verify-raw.txt'), raw);
  const p = { id: 'I', ctx: { factoryRoot: temp, worktreePath: temp }, content: { version: EVIDENCE_IDENTITY_VERSION, hash: 'h' }, evidence: { version: EVIDENCE_IDENTITY_VERSION, hash: 'h', complete: true, rawHash: digest(raw) } };
  assert.equal(evidenceIntact(p), true);
  p.evidence.version = 1; assert.equal(evidenceIntact(p), false, 'v1 cannot authorize v2 reuse');
  const target = join(temp, 'App.sln').replace(/\\/g, '/');
  writeFileSync(join(dir, 'baseline-raw.txt'), `FACTORY::TEST::SUITE::START ${target}\nFACTORY::TEST::FAILURE {"source":"Tests.dll/net8.0","test":"KnownFailure"}\nFACTORY::SUMMARY::suite exit=1 failed=1 passed=2 skipped=0\n`);
  const baseline = effectiveBaselineFor(p, dir).baseline;
  assert.equal(baseline.status, 'captured'); assert.equal(baseline.targets[0].failedTests.length, 1);
  const product = join(temp, 'product'), engine = join(temp, 'engine');
  mkdirSync(product); mkdirSync(engine);
  const mount = 'tools/factory'; mkdirSync(join(product, mount), { recursive: true });
  for (const name of ENGINE_SOURCE_PATHS) {
    if (name === 'VERSION') writeFileSync(join(engine, name), '1.0');
    else { mkdirSync(join(engine, name)); writeFileSync(join(engine, name, 'source'), 'initial'); }
  }
  const git = { root: root => root, head: () => 'a'.repeat(40), index: root => root === product ? [{ path: mount, mode: '160000', oid: 'b'.repeat(40) }] : [], untracked: () => [] };
  const options = { git, inputs: { discoverDefaults: false }, engineMount: { path: mount, sourceRoot: engine }, briefs: { fixer: 'effective launch brief' } };
  const before = snapshotTree(product, 'contract', undefined, options);
  writeFileSync(join(engine, '_workflow/source'), 'changed');
  const after = snapshotTree(product, 'contract', undefined, options);
  assert.notEqual(before.hash, after.hash); assert.notEqual(before.codeHash, after.codeHash);
  assert.throws(() => snapshotTree(product, 'contract', undefined, { ...options, briefs: {} }), /effective reviewerContract/);
  assert.throws(() => snapshotTree(product, 'contract', undefined, { ...options, engineMount: undefined }), /ENOENT|submodule/);
  console.log('Port shared helpers: tested Bash resolution, single restrictive capacity, identity version and structured baseline producer passed');
} finally { rmSync(temp, { recursive: true, force: true }); }
