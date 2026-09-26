import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { defaultPrereqsRoot, manifest, findSdk, isolatedDotnetEnv, prepareOfflineDotnetFixture, writeFixtureProject, restoreFixture } from '../_workflow/lib/_offline-dotnet-fixture.mjs';

export function parseOptions(args) {
  const options = { root: defaultPrereqsRoot(), network: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check' || arg === '--provision') {
      if (options.mode) throw new Error('Choose exactly one of --check / --provision');
      options.mode = arg.slice(2);
    } else if (arg === '--allow-network') options.network = true;
    else if (arg === '--root' || arg === '--cache') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(arg + ' requires a path');
      options[arg.slice(2)] = resolve(args[++i]);
    } else throw new Error('Unknown prerequisite option: ' + arg);
  }
  if (!options.mode) throw new Error('Use --check or --provision [--allow-network] [--root <isolated-directory>] [--cache <existing-package-cache>]');
  if (options.mode === 'check' && options.network) throw new Error('--check is offline; --allow-network requires --provision');
  if (options.mode === 'provision' && !options.network) throw new Error('Provisioning requires explicit --allow-network consent');
  return options;
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function provisionSdk(root, work, env) {
  try { return findSdk(root, env); } catch {}
  const os = { win32: 'win', linux: 'linux', darwin: 'osx' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) throw new Error('SDK auto-provision unsupported for ' + process.platform + '/' + process.arch + '; install the pinned SDK explicitly');
  const releases = JSON.parse(await download('https://builds.dotnet.microsoft.com/dotnet/release-metadata/8.0/releases.json'));
  const sdk = releases.releases.flatMap(release => release.sdks || [release.sdk]).find(sdk => sdk?.version === manifest.sdk);
  const extension = os === 'win' ? '.zip' : '.tar.gz';
  const archive = sdk?.files.find(file => file.rid === `${os}-${arch}` && file.url.endsWith(extension));
  if (!archive) throw new Error('Pinned SDK archive unavailable for ' + os + '-' + arch);
  const bytes = await download(archive.url);
  if (createHash('sha512').update(bytes).digest('hex').toLowerCase() !== archive.hash.toLowerCase()) throw new Error('SDK archive SHA-512 mismatch');
  const file = join(work, 'sdk' + extension), destination = join(root, 'dotnet');
  writeFileSync(file, bytes);
  mkdirSync(destination, { recursive: true });
  const result = os === 'win'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:FACTORY_SDK_ARCHIVE -DestinationPath $env:FACTORY_SDK_DEST -Force'], { env: { ...env, FACTORY_SDK_ARCHIVE: file, FACTORY_SDK_DEST: destination }, encoding: 'utf8', timeout: 120000 })
    : spawnSync('tar', ['-xzf', file, '-C', destination], { env, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error('SDK extraction failed: ' + (result.error?.message || result.stderr));
  return findSdk(root, env);
}

export async function main(args) {
  const options = parseOptions(args);
  const parent = process.env.FACTORY_TEST_TMP_ROOT || tmpdir();
  if (!existsSync(parent)) throw new Error('Temporary parent does not exist: ' + parent);
  const work = mkdtempSync(join(parent, 'factory-prereqs-'));
  try {
    if (options.mode === 'provision') {
      mkdirSync(options.root, { recursive: true });
      const env = { ...isolatedDotnetEnv(work), NUGET_PACKAGES: join(options.root, 'packages') };
      const dotnet = await provisionSdk(options.root, work, env);
      if (dotnet !== 'dotnet') { env.DOTNET_ROOT = dirname(dotnet); env.PATH = dirname(dotnet) + delimiter + env.PATH; }
      const project = join(work, 'project');
      writeFixtureProject(project);
      restoreFixture(project, dotnet, env, 'https://api.nuget.org/v3/index.json');
    }
    prepareOfflineDotnetFixture(join(work, 'check'), { ...options, cache: options.cache || join(options.root, 'packages') });
    console.log(`prerequisites ${options.mode.toUpperCase()} passed; root=${options.root}`);
    console.log(`Run: node _workflow/lib/_selftest.mjs --suite all (FACTORY_TEST_PREREQS_ROOT=${options.root}${options.cache ? '; FACTORY_TEST_NUGET_CACHE=' + options.cache : ''})`);
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error('test-prereqs FAILED: ' + error.message); process.exitCode = 1; }
}
