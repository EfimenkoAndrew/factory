import { testRoot } from './_test-environment.mjs';
import { prepareOfflineDotnetFixture } from './_offline-dotnet-fixture.mjs';

try {
  prepareOfflineDotnetFixture(testRoot);
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  process.exitCode = 0;
  for (const args of [
    ['--test', '--test-name-pattern=^real offline dotnet fixture', fileURLToPath(new URL('./test-results.test.mjs', import.meta.url))],
    ['--test', fileURLToPath(new URL('../live-opencode-code.test.mjs', import.meta.url))],
  ]) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env, timeout: 240000 });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exitCode = 1;
  }
  console.log('integration ' + (process.exitCode ? 'FAILED' : 'PASSED'));
} catch (error) {
  console.error('integration FAILED: ' + error.message);
  process.exitCode = 1;
}
