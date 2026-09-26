import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOptions } from './test-prereqs.mjs';
import { selectTestSuite } from '../_workflow/lib/_test-suites.mjs';
import { fixtureLock, manifest, resolvedPackages, copyLockedPackages, fixtureUrl } from '../_workflow/lib/_offline-dotnet-fixture.mjs';

test('suite requests and provisioning consent are explicit and fail closed', () => {
  assert.equal(selectTestSuite([]), 'portable');
  assert.equal(selectTestSuite(['--integration']), 'all');
  for (const suite of ['portable', 'integration', 'all']) assert.equal(selectTestSuite(['--suite', suite]), suite);
  for (const args of [['--suite'], ['--suite', 'auto'], ['--suite', 'portable', '--integration']]) assert.throws(() => selectTestSuite(args), /Usage/);
  assert.throws(() => parseOptions(['--provision']), /explicit --allow-network/);
  assert.throws(() => parseOptions(['--check', '--allow-network']), /offline/);
  assert.throws(() => parseOptions(['--check', '--provision']), /exactly one/);
  assert.throws(() => parseOptions(['--check', '--root']), /requires a path/);
  assert.equal(parseOptions(['--provision', '--allow-network']).mode, 'provision');
});

test('declarative net8 closure agrees with project and SDK; unrelated framework dependencies are excluded', () => {
  const graph = resolvedPackages();
  const project = readFileSync(new URL('Tests.csproj', fixtureUrl), 'utf8');
  assert.equal(JSON.parse(readFileSync(new URL('global.json', fixtureUrl))).sdk.version, manifest.sdk);
  assert.ok(project.includes(`<TargetFramework>${manifest.targetFramework}</TargetFramework>`));
  assert.deepEqual(Object.fromEntries(Object.entries(fixtureLock.dependencies[manifest.targetFramework]).filter(([, p]) => p.type === 'Direct').map(([id, p]) => [id, p.resolved])), manifest.packages);
  for (const [id, version] of Object.entries(manifest.packages)) assert.ok(project.includes(`Include="${id}" Version="[${version}]"`));
  const multi = structuredClone(fixtureLock);
  multi.dependencies.net472 = { UnavailableLegacy: { resolved: '1.0.0' } };
  assert.deepEqual(resolvedPackages(multi), graph);
  delete multi.dependencies['net8.0']['xunit.abstractions'];
  assert.throws(() => resolvedPackages(multi), /xunit.extensibility.core\/2.9.0 requires xunit.abstractions/);
});

test('missing transitive package fails before copying; malformed archives fail at their exact path', t => {
  const root = mkdtempSync(join(process.env.FACTORY_TEST_TMP_ROOT || tmpdir(), 'prereq-negative-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, 'cache'), feed = join(root, 'feed');
  const packages = resolvedPackages(), missing = packages.find(p => p.id === 'xunit.abstractions');
  for (const pkg of packages.filter(p => p !== missing)) {
    const path = join(cache, pkg.id, pkg.version); mkdirSync(path, { recursive: true });
    const archive = join(path, `${pkg.id}.${pkg.version}.nupkg`);
    writeFileSync(archive, 'fixture');
    writeFileSync(archive + '.sha512', createHash('sha512').update('fixture').digest('base64'));
  }
  assert.throws(() => copyLockedPackages(cache, feed), /xunit.abstractions\/2.0.3 \(net8.0\).*expected/);
  assert.equal(existsSync(feed), false);
  writeFileSync(join(cache, packages[0].id, packages[0].version, `${packages[0].id}.${packages[0].version}.nupkg`), 'tampered');
  assert.throws(() => copyLockedPackages(cache, feed), /archive hash mismatch: microsoft.net.test.sdk\/17.11.1/);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./test-prereqs.mjs', import.meta.url)), '--provision'], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /explicit --allow-network/);
});

test('explicit integration with an empty cache exits nonzero instead of skipping', t => {
  const root = mkdtempSync(join(process.env.FACTORY_TEST_BASE_TMP_ROOT || process.env.FACTORY_TEST_TMP_ROOT || tmpdir(), 'prereq-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../_workflow/lib/_selftest.mjs', import.meta.url)), '--suite', 'integration'], {
    env: { ...process.env, FACTORY_TEST_NUGET_CACHE: join(root, 'empty-cache'), FACTORY_TEST_PREREQS_ROOT: root }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /integration FAILED: (Integration prerequisite missing: microsoft.net.test.sdk\/17.11.1 \(net8.0\)|Integration requires exact .NET SDK)/);
  assert.doesNotMatch(result.stdout, /integration PASSED|integration NOT REQUESTED/);
});
