import { cpSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function prepareOfflineDotnetFixture(tempRoot) {
  const dotnet = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', timeout: 10000 });
  if (dotnet.error || dotnet.status !== 0 || !dotnet.stdout.trim()) {
    throw new Error('Real offline dotnet fixture requires an installed .NET SDK');
  }
  const sdk = [...dotnet.stdout.matchAll(/^(8\.\d+\.\d+) \[/gm)].at(-1)?.[1];
  if (!sdk) throw new Error('Offline net8.0 fixture requires a .NET 8 SDK and its installed targeting packs');
  writeFileSync(join(tempRoot, 'global.json'), JSON.stringify({ sdk: { version: sdk, rollForward: 'disable' } }));
  writeFileSync(join(tempRoot, 'Directory.Build.props'), '<Project><PropertyGroup><UseSharedCompilation>false</UseSharedCompilation><MSBuildEnableWorkloadResolver>false</MSBuildEnableWorkloadResolver></PropertyGroup></Project>');
  process.env.DOTNET_CLI_USE_MSBUILD_SERVER = '0';
  process.env.MSBUILDDISABLENODEREUSE = '1';
  const source = process.env.FACTORY_TEST_NUGET_CACHE || join(homedir(), '.nuget', 'packages');
  const destination = join(tempRoot, 'offline-nuget');
  const visited = new Set();
  const copyPackage = (id, version, required = false) => {
    id = id.toLowerCase();
    version = version.replace(/^[[(]/, '').split(',')[0].replace(/[\])]$/, '').trim();
    if (!/^[a-z0-9_.-]+$/.test(id) || !/^\d+(?:\.\d+)*(?:-[a-z0-9.-]+)?$/i.test(version)) throw new Error('Unsupported cached package identity: ' + id + '/' + version);
    const key = id + '/' + version;
    if (visited.has(key)) return;
    visited.add(key);
    const directory = join(source, id, version);
    if (!existsSync(directory)) {
      if (required) throw new Error('Offline fixture package absent from cache: ' + key);
      return;
    }
    const manifest = readdirSync(directory).find(name => name.endsWith('.nuspec'));
    if (!manifest) throw new Error('Offline package manifest absent: ' + key);
    const text = readFileSync(join(directory, manifest), 'utf8');
    mkdirSync(join(destination, id), { recursive: true });
    cpSync(directory, join(destination, id, version), { recursive: true });
    for (const [, attributes] of text.matchAll(/<dependency\s+([^>]+)\/?\s*>/g)) {
      const name = /\bid="([^"]+)"/.exec(attributes)?.[1];
      const constraint = /\bversion="([^"]+)"/.exec(attributes)?.[1];
      if (!name || !constraint) throw new Error('Invalid cached dependency in ' + key);
      copyPackage(name, constraint);
    }
  };
  for (const [id, version] of [['microsoft.net.test.sdk', '17.11.1'], ['xunit', '2.9.0'], ['xunit.runner.visualstudio', '2.8.2']]) copyPackage(id, version, true);
  process.env.FACTORY_TEST_REAL_DOTNET = '1';
  process.env.FACTORY_TEST_NUGET_CACHE = destination;
  console.log('self-test: real offline .NET fixture enabled with an isolated cache copy; offline restore verifies the net8.0 dependency closure');
}
