import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const approved = 'C:\\Users\\AYEFYM~1\\AppData\\Local\\Temp\\opencode';
const parent = process.env.FACTORY_TEST_TMP_ROOT || (process.platform === 'win32' && existsSync(approved) ? approved : tmpdir());
if (!existsSync(parent)) throw new Error('Test temporary parent does not exist: ' + parent);
export const testRoot = mkdtempSync(join(parent, 'factory-selftest-run-'));
Object.assign(process.env, {
  TMPDIR: testRoot, TMP: testRoot, TEMP: testRoot, FACTORY_TEST_TMP_ROOT: testRoot,
  FACTORY_SELFTEST_NO_GIT_MUTATIONS: '1', GIT_OPTIONAL_LOCKS: '0',
  DOTNET_CLI_HOME: testRoot, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  NUGET_PACKAGES: join(testRoot, 'nuget'), FACTORY_TELEMETRY: '0',
});
process.once('exit', () => rmSync(testRoot, { recursive: true, force: true, maxRetries: 3 }));
