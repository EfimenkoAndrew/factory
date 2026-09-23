import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseTrx, aggregateTrx } from './test-results.mjs';
import { captureBaseline } from './baseline.mjs';
import { completeCommand } from './stage-evidence.mjs';
import { resolveBash } from './bash.mjs';
import { writeFixtureProject } from './_offline-dotnet-fixture.mjs';

const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function trx({ assembly = 'A.Tests', root = 'C:/work/first', framework = 'net8.0', names = ['Case("a&<b>", 2)'], outcomes = ['Failed'], prefix = '' } = {}) {
  const tag = name => prefix + name;
  const path = root + '/bin/Debug/' + framework + '/' + assembly + '.dll';
  const failed = outcomes.filter(o => o === 'Failed').length, passed = outcomes.filter(o => o === 'Passed').length;
  const skipped = outcomes.filter(o => o === 'NotExecuted').length;
  return `<?xml version="1.0" encoding="utf-8"?>
<${tag('TestRun')} xmlns${prefix ? ':' + prefix.slice(0, -1) : ''}="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
<${tag('Results')}>${names.map((n, i) => `<${tag('UnitTestResult')} testId="t${i}" executionId="e${i}" testName="${escape(n)}" outcome="${outcomes[i]}"/>`).join('')}</${tag('Results')}>
<${tag('TestDefinitions')}>${names.map((n, i) => `<${tag('UnitTest')} id="t${i}" storage="${path.toLowerCase()}"><${tag('Execution')} id="e${i}"/><${tag('TestMethod')} codeBase="${path}" className="Example.Tests" name="Case"/></${tag('UnitTest')}>`).join('')}</${tag('TestDefinitions')}>
<${tag('ResultSummary')} outcome="${failed ? 'Failed' : 'Completed'}"><${tag('Counters')} total="${names.length}" executed="${passed + failed}" passed="${passed}" failed="${failed}" notExecuted="${skipped}" error="0" aborted="0"/></${tag('ResultSummary')}>
</${tag('TestRun')}>`;
}

test('stable, qualified parameter identities across temp paths, namespace prefixes and assemblies', () => {
  const a = parseTrx(trx());
  assert.deepEqual(a.failures, [{ source: 'A.Tests.dll/net8.0', test: 'Example.Tests.Case("a&<b>", 2)' }]);
  assert.deepEqual(parseTrx(trx({ root: 'D:/temp/net9.0/second', prefix: 't:' })).failures, a.failures);
  const combined = aggregateTrx([trx(), trx({ assembly: 'B.Tests' }), trx({ framework: 'net9.0' })], 1);
  assert.equal(combined.failed, 3);
  assert.equal(new Set(combined.failures.map(f => f.source)).size, 3);
  assert.deepEqual(aggregateTrx([trx({ assembly: 'B.Tests' }), trx()], 1), aggregateTrx([trx(), trx({ assembly: 'B.Tests' })], 1));
});

test('numeric entities, quotes, literal entity spelling and Unicode preserve parameter identity', () => {
  const xml = trx({ names: ['Case("&quot;", \'雪😀\')'] }).replace('雪', '&#x96EA;').replace('😀', '&#128512;');
  assert.equal(parseTrx(xml).failures[0].test, 'Example.Tests.Case("&quot;", \'雪😀\')');
  assert.equal(parseTrx(xml.replace('name="Case"', 'name="CaseWithCustomName"')).failures[0].test,
    'Example.Tests.CaseWithCustomName [Case("&quot;", \'雪😀\')]');
});

test('aggregates all records rather than the last console/project summary', () => {
  const a = trx({ names: ['Case(1)', 'Case(2)', 'Case(3)'], outcomes: ['Failed', 'Passed', 'NotExecuted'] });
  const b = trx({ assembly: 'B.Tests', names: ['Case(1)'], outcomes: ['Passed'] });
  const result = aggregateTrx([a, b], 1);
  assert.deepEqual([result.total, result.failed, result.passed, result.skipped], [4, 1, 2, 1]);
  assert.throws(() => aggregateTrx([a, b], 0), /exit contradicts/);
  assert.throws(() => aggregateTrx([b], 1), /exit contradicts/);
  assert.throws(() => aggregateTrx([b], 137), /exit contradicts/);
  assert.throws(() => aggregateTrx([], 1), /missing/);
  assert.throws(() => aggregateTrx([a, a], 1), /duplicate/);
  assert.equal(parseTrx(a.replace('notExecuted="1"', 'notExecuted="0"')).skipped, 1);
  assert.throws(() => parseTrx(trx({ names: ['Case(1)', 'Case(1)'], outcomes: ['Failed', 'Failed'] })), /duplicate/);
});

test('xUnit error run-info must corroborate an actual failed record', () => {
  const base = trx().replace('name="Case"/>', 'name="Case" adapterTypeName="executor://xunit/VsTestRunner2/netcoreapp"/>');
  const info = '<RunInfos><RunInfo outcome="Error"><Text>[xUnit.net 00:00:00.17]   Case(&quot;a&amp;&lt;b&gt;&quot;, 2) [FAIL]</Text></RunInfo></RunInfos>';
  const xml = base.replace('</ResultSummary>', info + '</ResultSummary>');
  assert.equal(parseTrx(xml).failed, 1);
  assert.throws(() => parseTrx(xml.replace('Case(&quot;', 'Other(&quot;')), /infrastructure error/);
  assert.throws(() => parseTrx(xml.replace('executor://xunit/', 'executor://other/')), /infrastructure error/);
});

for (const [label, mutate] of Object.entries({
  aborted: x => x.replace('<ResultSummary outcome="Failed"', '<ResultSummary outcome="Aborted"'),
  timeout: x => x.replace('outcome="Failed"/>', 'outcome="Timeout"/>'),
  missingTestId: x => x.replace('testId="t0"', ''),
  missingExecutionId: x => x.replace('executionId="e0"', ''),
  orphanTest: x => x.replace('testId="t0"', 'testId="missing"'),
  mismatchedExecution: x => x.replace('<Execution id="e0"', '<Execution id="wrong"'),
  missingClass: x => x.replace('className="Example.Tests"', ''),
  missingFramework: x => x.replaceAll('/net8.0/', '/custom/'),
  counters: x => x.replace('total="1"', 'total="2"'),
  missingResult: x => x.replace(/<UnitTestResult[^>]+\/>/, ''),
  crash: x => x.replace('</ResultSummary>', '<RunInfos><RunInfo outcome="Error"/></RunInfos></ResultSummary>'),
  duplicateAttribute: x => x.replace('testId="t0"', 'testId="t0" testId="t1"'),
  missingQuote: x => x.replace('testId="t0"', 'testId=t0'),
  unboundPrefix: x => x.replaceAll('TestRun', 'bad:TestRun'),
  wrongNamespace: x => x.replace('http://microsoft.com/schemas/VisualStudio/TeamTest/2010', 'urn:other'),
  malformedEntity: x => x.replace('&amp;', '&nope;'),
  invalidCharacter: x => x.replace('&amp;', '&#0;'),
  literalLessThan: x => x.replace('&lt;', '<'),
  truncated: x => x.slice(0, -5),
  repeatedRoot: x => x + '<Other/>',
  dtd: x => x.replace('<TestRun ', '<!DOCTYPE TestRun [<!ENTITY attack SYSTEM "file:///etc/passwd">]><TestRun '),
  externalDtd: x => x.replace('<TestRun ', '<!DOCTYPE TestRun SYSTEM "https://example.invalid/evil"><TestRun '),
  processingInstruction: x => x.replace('<Results>', '<?attack x?><Results>'),
  excessiveDepth: x => x.replace('<Results>', '<Results>' + '<x>'.repeat(65) + '</x>'.repeat(65)),
})) test('rejects ' + label, () => assert.throws(() => parseTrx(mutate(trx()))));

const parent = process.env.FACTORY_TEST_TMP_ROOT || (process.platform === 'win32' ? 'C:\\Users\\AYEFYM~1\\AppData\\Local\\Temp\\opencode' : tmpdir());
const cli = fileURLToPath(new URL('../test-results.mjs', import.meta.url));
const runner = fileURLToPath(new URL('../../verify/build-test.sh', import.meta.url)).replace(/\\/g, '/');
const bashPath = resolveBash();
console.log('TRX tests Bash: ' + bashPath);
const bash = (args, options = {}) => spawnSync(bashPath, args, { encoding: 'utf8', timeout: 120000, ...options });
const temporary = t => { const dir = mkdtempSync(join(parent, 'factory-trx-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('CLI emits atomic markers; malformed/missing evidence cannot become a baseline', t => {
  const dir = temporary(t);
  writeFileSync(join(dir, 'a.trx'), trx());
  writeFileSync(join(dir, 'b.trx'), trx({ assembly: 'B.Tests' }));
  const run = spawnSync(process.execPath, [cli, dir, 'suite', '1'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  const text = 'FACTORY::TEST::SUITE::START A.sln\n' + run.stdout;
  const baseline = captureBaseline(text);
  assert.equal(baseline.status, 'captured');
  assert.equal(baseline.targets[0].failedTests.length, 2);
  assert.equal(completeCommand({ code: 1, output: text }, 'suite', 'A.sln', null, baseline).pass, true);
  writeFileSync(join(dir, 'broken.trx'), '<TestRun>');
  const invalid = spawnSync(process.execPath, [cli, dir, 'suite', '1'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stdout, /FACTORY::TEST::DIAGNOSTIC/);
  assert.doesNotMatch(invalid.stdout, /FACTORY::TEST::FAILURE/);
  assert.equal(captureBaseline('FACTORY::TEST::SUITE::START A.sln\n' + invalid.stdout).status, 'invalid');
  const empty = join(dir, 'empty'); mkdirSync(empty);
  for (const code of ['0', '1', '137']) {
    const missing = spawnSync(process.execPath, [cli, empty, 'suite', code], { encoding: 'utf8' });
    assert.equal(missing.status, code === '137' ? 137 : 2);
    assert.match(missing.stdout, /missing\/excessive TRX/);
  }
});

test('CLI decodes UTF-8/UTF-16 BOMs strictly and rejects invalid encoding', t => {
  const dir = temporary(t), path = join(dir, 'a.trx');
  const xml = trx().replace('encoding="utf-8"', 'encoding="utf-16"');
  const le = Buffer.from('\ufeff' + xml, 'utf16le');
  for (const bytes of [Buffer.from('\ufeff' + trx()), le, Buffer.from(le).swap16()]) {
    writeFileSync(path, bytes);
    const run = spawnSync(process.execPath, [cli, dir, 'suite', '1'], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /FACTORY::TEST::FAILURE/);
  }
  writeFileSync(path, Buffer.from([0xc0, 0x80]));
  const bad = spawnSync(process.execPath, [cli, dir, 'suite', '0'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /DIAGNOSTIC/);
});

test('Git Bash runner captures machine identities, detailed real-infra, pipeline status and cleans only its temp directory', t => {
  const dir = temporary(t), fixtures = join(dir, 'fixtures'), bin = join(dir, 'bin');
  mkdirSync(fixtures); mkdirSync(bin);
  writeFileSync(join(fixtures, 'a.trx'), trx());
  writeFileSync(join(fixtures, 'b.trx'), trx({ assembly: 'B.Tests', names: ['Case(2)'], outcomes: ['Passed'] }));
  const log = join(dir, 'args'), location = join(dir, 'location');
  writeFileSync(join(bin, 'dotnet'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$TEST_ARGS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--results-directory' ]; then shift; results="$1"; fi
  shift
done
cygpath -w "$results" > "$TEST_LOCATION" 2>/dev/null || printf '%s' "$results" > "$TEST_LOCATION"
if [ "$TEST_MODE" = signal ]; then sleep 1; exit 143; fi
if [ "$TEST_MODE" != missing ]; then cp "$TEST_FIXTURES/"*.trx "$results/"; fi
if [ "$TEST_MODE" = malformed ]; then printf '<bad>' > "$results/bad.trx"; fi
echo 'Failed! - Failed: 1, Passed: 0, Skipped: 0'
echo 'Passed! - Failed: 0, Passed: 1, Skipped: 0'
echo 'FACTORY::REALINFRA::postgres'
exit "$TEST_CODE"
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, FACTORY_BT_NO_LOCAL: '1',
    TEST_ARGS: log, TEST_LOCATION: location, TEST_FIXTURES: fixtures, TEST_MODE: 'valid', TEST_CODE: '1' };
  const target = dir.replace(/\\/g, '/') + '/state/worktrees/item/Tests.sln';
  const invoke = (sub, overrides = {}) => bash(['-c', 'set -o pipefail; bash "$1" "$2" "$3" "Case" | cat', '_', runner, sub, target], { env: { ...env, ...overrides } });
  const run = invoke('suite');
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /SUMMARY::suite exit=1 failed=1 passed=1 skipped=0 total=2/);
  assert.match(run.stdout, /FAILURE .*A.Tests.dll\/net8.0/);
  assert.equal(existsSync(readFileSync(location, 'utf8').trim()), false);
  assert.equal(existsSync(join(fixtures, 'a.trx')), true);
  assert.match(readFileSync(log, 'utf8'), /--logger\ntrx\n--results-directory\n/);
  const filter = invoke('filter');
  assert.equal(filter.status, 1);
  assert.match(filter.stdout, /FACTORY::REALINFRA::postgres/);
  assert.match(readFileSync(log, 'utf8'), /console;verbosity=detailed/);
  for (const TEST_MODE of ['missing', 'malformed']) for (const TEST_CODE of ['0', '1', '137']) {
    const bad = invoke('suite', { TEST_MODE, TEST_CODE });
    assert.equal(bad.status, TEST_CODE === '137' ? 137 : 2, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /FACTORY::TEST::DIAGNOSTIC/);
    assert.doesNotMatch(bad.stdout, /FACTORY::TEST::FAILURE/);
    assert.equal(existsSync(readFileSync(location, 'utf8').trim()), false);
  }
  rmSync(location);
  const interrupted = bash(['-c', 'bash "$1" suite "$2" & pid=$!; while [ ! -s "$TEST_LOCATION" ]; do sleep 0.05; done; kill -TERM "$pid"; wait "$pid"', '_', runner, target], { env: { ...env, TEST_MODE: 'signal' } });
  assert.equal(interrupted.status, 143, interrupted.stdout + interrupted.stderr);
  assert.equal(existsSync(readFileSync(location, 'utf8').trim()), false);
  assert.equal(existsSync(join(fixtures, 'a.trx')), true);
  writeFileSync(join(bin, 'node'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const noExtractor = invoke('suite');
  assert.equal(noExtractor.status, 2);
  assert.match(noExtractor.stdout, /extractor invocation failed/);
  assert.equal(existsSync(readFileSync(location, 'utf8').trim()), false);
});

if (process.env.FACTORY_TEST_REAL_DOTNET === '1') test('real offline dotnet fixture through shared Bash producer', t => {
  const dir = temporary(t), work = join(dir, 'state', 'worktrees', 'fixture');
  mkdirSync(work, { recursive: true });
  const packages = process.env.FACTORY_TEST_NUGET_CACHE || join(homedir(), '.nuget', 'packages');
  for (const [name, version] of [['microsoft.net.test.sdk', '17.11.1'], ['xunit', '2.9.0'], ['xunit.runner.visualstudio', '2.8.2']]) {
    assert.ok(existsSync(join(packages, name, version)), 'offline package absent: ' + name);
  }
  writeFixtureProject(work);
  writeFileSync(join(work, 'Tests.cs'), `using Xunit;
namespace Fixture;
public class Tests {
 [Theory] [InlineData("a&<b>\\\"", 1)] [InlineData("other", 2)]
 public void Fails(string value, int number) { Assert.True(false, value); }
 [Fact] public void Passes() { System.Console.WriteLine("FACTORY::REALINFRA::fixture"); Assert.True(true); }
 [Fact(Skip="fixture skip")] public void Skipped() { }
}`);
  const env = { ...process.env, FACTORY_BT_NO_LOCAL: '1', NUGET_PACKAGES: packages, DOTNET_CLI_HOME: dir,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
  const target = join(work, 'Tests.csproj').replace(/\\/g, '/');
  const suite = bash([runner, 'suite', target], { cwd: work, env });
  assert.equal(suite.status, 1, suite.stdout + suite.stderr);
  assert.match(suite.stdout, /SUMMARY::suite exit=1 failed=2 passed=1 skipped=1 total=4/);
  const baseline = captureBaseline(suite.stdout);
  assert.equal(baseline.status, 'captured', suite.stdout);
  assert.equal(baseline.targets[0].failedTests.length, 2);
  const green = bash([runner, 'filter', target, 'FullyQualifiedName~Passes'], { cwd: work, env });
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /SUMMARY::filter exit=0 failed=0 passed=1/);
  assert.match(green.stdout, /FACTORY::REALINFRA::fixture/);
});
