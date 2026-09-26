import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const approved = 'C:\\Users\\AYEFYM~1\\AppData\\Local\\Temp\\opencode';
const parent = process.env.FACTORY_TEST_BASE_TMP_ROOT || process.env.FACTORY_TEST_TMP_ROOT || (process.platform === 'win32' && existsSync(approved) ? approved : tmpdir());
if (!existsSync(parent)) throw new Error('Test temporary parent does not exist: ' + parent);
export const testRoot = mkdtempSync(join(parent, 'ft-'));
const prereqsRoot = process.env.FACTORY_TEST_PREREQS_ROOT || join(tmpdir(), 'factory-test-prereqs');
const home = join(testRoot, 'home');
mkdirSync(home);
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
  FACTORY_TEST_PREREQS_ROOT: prereqsRoot,
  FACTORY_TEST_BASE_TMP_ROOT: parent,
  TMPDIR: testRoot, TMP: testRoot, TEMP: testRoot, FACTORY_TEST_TMP_ROOT: testRoot,
  FACTORY_SELFTEST_NO_GIT_MUTATIONS: '1', GIT_OPTIONAL_LOCKS: '0',
  DOTNET_CLI_HOME: testRoot, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false', NUGET_HTTP_CACHE_PATH: join(testRoot, 'nuget-http'),
  NUGET_PACKAGES: join(testRoot, 'nuget'), FACTORY_TELEMETRY: '0',
});
delete process.env.FACTORY_TEST_REAL_DOTNET;
process.once('exit', () => rmSync(testRoot, { recursive: true, force: true, maxRetries: 3 }));
