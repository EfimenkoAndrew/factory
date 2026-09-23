import { copyFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const fixtureUrl = new URL('../../setup/test-fixtures/dotnet/', import.meta.url);
export const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixtureUrl), 'utf8'));
export const fixtureLock = JSON.parse(readFileSync(new URL('packages.lock.json', fixtureUrl), 'utf8'));
export const defaultPrereqsRoot = () => resolve(process.env.FACTORY_TEST_PREREQS_ROOT || join(tmpdir(), 'factory-test-prereqs'));

export function resolvedPackages(lock = fixtureLock, framework = manifest.targetFramework) {
  const graph = lock.dependencies?.[framework];
  if (!graph || lock.version !== 1) throw new Error('Fixture lock has no supported target: ' + framework);
  const names = new Set(Object.keys(graph).map(id => id.toLowerCase()));
  return Object.entries(graph).map(([id, row]) => {
    if (!/^[a-z0-9_.-]+$/i.test(id) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(row.resolved) || !/^[A-Za-z0-9+/]{86}==$/.test(row.contentHash)) throw new Error('Invalid locked package: ' + id);
    for (const dep of Object.keys(row.dependencies || {})) {
      if (!names.has(dep.toLowerCase())) throw new Error(`Incomplete ${framework} lock: ${id}/${row.resolved} requires ${dep}`);
    }
    return { id: id.toLowerCase(), version: row.resolved, hash: row.contentHash, framework };
  });
}

export function isolatedDotnetEnv(root, env = process.env) {
  return { ...env, DOTNET_CLI_HOME: root, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false',
    DOTNET_NOLOGO: '1', DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: '1',
    DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1',
    NUGET_PACKAGES: join(root, 'offline-nuget'), NUGET_HTTP_CACHE_PATH: join(root, 'http-cache'),
    NUGET_PLUGINS_CACHE_PATH: join(root, 'plugins-cache'), NUGET_FALLBACK_PACKAGES: '' };
}

export function findSdk(root, env = process.env) {
  const local = join(root, 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const candidates = [process.env.FACTORY_TEST_DOTNET, existsSync(local) ? local : null, 'dotnet'].filter(Boolean);
  for (const command of candidates) {
    const result = spawnSync(command, ['--list-sdks'], { encoding: 'utf8', timeout: 10000, env });
    if (result.status === 0 && result.stdout.split(/\r?\n/).some(line => line.startsWith(manifest.sdk + ' ['))) return command;
  }
  throw new Error(`Integration requires exact .NET SDK ${manifest.sdk} with net8.0 targeting/runtime packs. Run node setup/test-prereqs.mjs --provision --allow-network --root "${root}"`);
}

export function writeFixtureProject(directory) {
  mkdirSync(directory, { recursive: true });
  for (const name of ['Tests.csproj', 'packages.lock.json', 'global.json', 'NuGet.Config']) copyFileSync(new URL(name, fixtureUrl), join(directory, name));
  writeFileSync(join(directory, 'Directory.Build.props'), '<Project><PropertyGroup><UseSharedCompilation>false</UseSharedCompilation><MSBuildEnableWorkloadResolver>false</MSBuildEnableWorkloadResolver></PropertyGroup></Project>');
}

export function copyLockedPackages(source, destination) {
  const packages = resolvedPackages();
  const archives = packages.map(pkg => {
    const name = `${pkg.id}.${pkg.version}.nupkg`;
    const path = join(source, pkg.id, pkg.version, name);
    if (!existsSync(path)) throw new Error(`Integration prerequisite missing: ${pkg.id}/${pkg.version} (${pkg.framework}); expected ${path}. Provision with node setup/test-prereqs.mjs --provision --allow-network`);
    const archiveHash = path + '.sha512';
    if (!existsSync(archiveHash) || createHash('sha512').update(readFileSync(path)).digest('base64') !== readFileSync(archiveHash, 'utf8').trim()) throw new Error(`Integration package archive hash mismatch: ${pkg.id}/${pkg.version} at ${path}`);
    return { path, name };
  });
  mkdirSync(destination, { recursive: true });
  for (const archive of archives) copyFileSync(archive.path, join(destination, archive.name));
  return packages;
}

export function restoreFixture(directory, dotnet, env, source) {
  const args = ['restore', 'Tests.csproj', '--use-lock-file', '--locked-mode', '--configfile', join(directory, 'NuGet.Config'), '-p:NuGetAudit=false'];
  if (source) args.push('--source', source);
  const result = spawnSync(dotnet, args, { cwd: directory, env, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error('Locked net8.0 fixture restore failed: ' + (result.error?.message || '') + '\n' + result.stdout + result.stderr);
  const assets = JSON.parse(readFileSync(join(directory, 'obj', 'project.assets.json'), 'utf8'));
  const actual = Object.keys(assets.targets[manifest.targetFramework] || {}).sort();
  const expected = Object.entries(fixtureLock.dependencies[manifest.targetFramework]).map(([id, row]) => `${id}/${row.resolved}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Resolved net8.0 assets differ from the checked fixture lock');
  for (const pkg of resolvedPackages()) {
    const metadata = join(env.NUGET_PACKAGES, pkg.id, pkg.version, '.nupkg.metadata');
    if (JSON.parse(readFileSync(metadata, 'utf8')).contentHash !== pkg.hash) throw new Error(`Restored content hash differs from lock: ${pkg.id}/${pkg.version}`);
  }
  return assets;
}

export function prepareOfflineDotnetFixture(tempRoot, options = {}) {
  mkdirSync(tempRoot, { recursive: true });
  const root = options.root || defaultPrereqsRoot();
  const env = isolatedDotnetEnv(tempRoot);
  const dotnet = findSdk(root, env);
  if (dotnet !== 'dotnet') {
    env.PATH = dirname(dotnet) + delimiter + env.PATH;
    env.DOTNET_ROOT = dirname(dotnet);
  }
  const source = options.cache || process.env.FACTORY_TEST_NUGET_CACHE || join(root, 'packages');
  const feed = join(tempRoot, 'offline-feed');
  const packages = copyLockedPackages(source, feed);
  const project = join(tempRoot, 'prereq-check');
  writeFixtureProject(project);
  restoreFixture(project, dotnet, env, feed);
  copyFileSync(new URL('global.json', fixtureUrl), join(tempRoot, 'global.json'));
  copyFileSync(join(project, 'Directory.Build.props'), join(tempRoot, 'Directory.Build.props'));
  Object.assign(process.env, env, { FACTORY_TEST_REAL_DOTNET: '1', FACTORY_TEST_NUGET_CACHE: env.NUGET_PACKAGES });
  console.log(`integration prerequisites READY: SDK ${manifest.sdk}; ${packages.length} hash-checked packages; locked ${manifest.targetFramework} assets verified; isolated cache ${env.NUGET_PACKAGES}`);
  return { dotnet, env, project };
}
