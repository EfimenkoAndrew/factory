import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureBaseline, failedTestIdentities, canonicalFramework } from './baseline.mjs';
import { completeCommand, completeVerificationTranscript } from './stage-evidence.mjs';
import { parseVerifyRaw, verdictFromParse } from './verify.mjs';
import { verifyTranscript } from './driver-integration.mjs';
import { parseTrx } from './test-results.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const suite = (target, tests = [], { failed = tests.length, source = 'Tests.dll/net8.0' } = {}) =>
  `FACTORY::TEST::SUITE::START ${target}\n` + tests.map(test => 'FACTORY::TEST::FAILURE ' + JSON.stringify({ source, test }) + '\n').join('')
  + `FACTORY::SUMMARY::suite exit=${failed ? 1 : 0} failed=${failed} passed=3 skipped=0\n`;
const check = (text, baseline, options = {}) => completeVerificationTranscript(text, { required: ['suite'], baseline, ...options });

test('equal counts cannot exchange failure identities or reuse allowance across targets', () => {
  const baseline = captureBaseline(suite('A.sln', ['Old']) + suite('B.sln', []));
  assert.equal(check(suite('A.sln', ['Old']) + suite('B.sln'), baseline).pass, true);
  assert.equal(check(suite('A.sln', ['New']) + suite('B.sln'), baseline).pass, false);
  assert.equal(check(suite('A.sln', ['Old']) + suite('B.sln', ['Old']), baseline).pass, false);
  assert.equal(check(suite('A.sln'), baseline).pass, true);
  assert.equal(check(suite('A.sln', ['Old'], { source: 'Other.dll/net8.0' }), baseline).pass, false);
  const larger = captureBaseline(suite('A.sln', ['Old', 'Other']));
  assert.equal(check(suite('A.sln', ['Old']), larger).pass, true);
  assert.equal(check(suite('A.sln', ['New']), larger).pass, false);
});

test('Windows native, MSYS, slash, dot and case target aliases share exactly one target', () => {
  const options = { worktree: 'C:\\Work\\Item' };
  const baseline = captureBaseline(suite('C:\\Work\\Item\\A.sln', ['Old']), options);
  assert.equal(check(suite('/c/work/item/./A.sln', ['Old']), baseline, options).pass, true);
  assert.equal(check(suite('A.sln', ['Old']), baseline, options).pass, true);
  assert.equal(check(suite('/c/work/item2/A.sln', ['Old']), baseline, options).pass, false);
});

test('absent, measured zero, malformed and legacy baselines are distinct and fail closed', () => {
  assert.equal(captureBaseline(null).status, 'absent');
  const zero = captureBaseline(suite('A.sln'));
  assert.equal(zero.status, 'captured');
  assert.deepEqual(zero.targets[0].failedTests, []);
  assert.equal(captureBaseline('FACTORY::SUMMARY::suite exit=0 failed=0 passed=4').status, 'invalid');
  for (const baseline of [null, 1, 999, ['Old'], zero, captureBaseline(suite('A.sln', [], { failed: 1 }))]) {
    assert.equal(check(suite('A.sln', ['Old']), baseline).pass, false);
    assert.equal(check(suite('A.sln'), baseline).pass, true);
  }
});

test('duplicate detail lines do not inflate counts and retries cannot union failure sets', () => {
  assert.equal(captureBaseline(suite('A.sln', ['Old', 'Old'], { failed: 1 })).status, 'captured');
  assert.equal(captureBaseline(suite('A.sln', ['Old', 'Old'])).status, 'invalid');
  assert.equal(captureBaseline(suite('A.sln', ['Old']) + suite('A.sln', ['New'])).status, 'invalid');
  const raw = suite('A.sln', ['Old']);
  const baseline = captureBaseline(raw + raw);
  assert.equal(baseline.targets.length, 1);
  assert.equal(check(raw + raw, baseline).pass, true);
  assert.equal(check(raw + suite('A.sln', ['New']), baseline).pass, false);
  assert.equal(check(raw + 'FACTORY::TEST::SUITE::START A.sln\n', baseline).pass, false);
});

test('detailed dotnet output preserves parameter and assembly identity; ambiguity refuses allowance', () => {
  const raw = 'Test run for C:\\src\\App.Tests.dll (.NETCoreApp,Version=v8.0)\n  Failed Ns.Test(x: 1) [12 ms]\n';
  assert.equal(failedTestIdentities(raw, 1).pass, true);
  assert.equal(failedTestIdentities(raw, 2).pass, false);
  assert.equal(failedTestIdentities(raw + 'Test run for Other.dll (net8.0)\n', 1).pass, false);
  const malformed = 'FACTORY::TEST::FAILURE {oops}\n';
  assert.equal(failedTestIdentities(malformed, 0).pass, false);
});

test('retained console baseline matches current TRX parameterized identities across exact framework aliases', () => {
  const test = 'Ns.Tests.Theory(input: "a,b", expected: 2)';
  const retained = 'FACTORY::TEST::SUITE::START A.sln\nTest run for C:\\old\\Tests.dll (.NETCoreApp,Version=v8.0)\n'
    + '  Failed ' + test + ' [12 ms]\nFACTORY::SUMMARY::suite exit=1 failed=1 passed=3\n';
  const baseline = captureBaseline(retained);
  assert.equal(baseline.status, 'captured');
  const xml = '<TestRun><Results><UnitTestResult testId="t" executionId="e" testName="Theory(input: &quot;a,b&quot;, expected: 2)" outcome="Failed"/></Results>'
    + '<TestDefinitions><UnitTest id="t" storage="C:/new/bin/Debug/net8.0/Tests.dll"><Execution id="e"/>'
    + '<TestMethod codeBase="C:/new/bin/Debug/net8.0/Tests.dll" className="Ns.Tests" name="Theory"/></UnitTest></TestDefinitions>'
    + '<ResultSummary outcome="Failed"><Counters total="1" executed="1" passed="0" failed="1" notExecuted="0"/></ResultSummary></TestRun>';
  const fromTrx = parseTrx(xml).failures[0];
  assert.equal(check(suite('A.sln', [fromTrx.test], { source: fromTrx.source }), baseline).pass, true);
  assert.equal(check(suite('A.sln', [test], { source: 'Tests.dll/net8.0' }), baseline).pass, true);
  assert.equal(check(suite('A.sln', [test], { source: 'Tests.dll/net9.0' }), baseline).pass, false);
  assert.equal(check(suite('A.sln', [test.replace('2)', '3)')]), baseline).pass, false);
  for (const [long, short] of [['.NETCoreApp,Version=v3.1', 'netcoreapp3.1'], ['.NETCoreApp,Version=v5.0', 'net5.0'],
    ['.NETStandard,Version=v2.0', 'netstandard2.0'], ['.NETFramework,Version=v4.8', 'net48'], ['.NETFramework,Version=v4.7.2', 'net472']]) {
    assert.equal(canonicalFramework(long), canonicalFramework(short));
  }
  assert.notEqual(canonicalFramework('netstandard2.0'), canonicalFramework('netcoreapp2.0'));
  assert.notEqual(canonicalFramework('net48'), canonicalFramework('net8.0'));
  assert.notEqual(canonicalFramework('net8.0-windows'), canonicalFramework('net8.0'));
  for (const bad of ['prefix net8.0', 'net8.0/net9.0', '.NETCoreApp,Version=v8.0,Profile=unknown', 'net4.8', 'net8', 'net08.0']) {
    assert.throws(() => canonicalFramework(bad), /framework/);
  }
});

test('single-command, legacy parse and aggregate consumers enforce the same baseline', () => {
  const text = suite('A.sln', ['Old']), baseline = captureBaseline(text);
  assert.equal(completeCommand({ code: 1, output: text }, 'suite', 'A.sln', null, baseline).pass, true);
  assert.equal(verdictFromParse(parseVerifyRaw(text), baseline).pass, true);
  assert.equal(verdictFromParse(parseVerifyRaw(text), 1).pass, false);
  assert.equal(verdictFromParse(parseVerifyRaw(text + suite('B.sln', ['Old'])), baseline).pass, false);
  assert.equal(verdictFromParse(parseVerifyRaw('Failed! - Failed: 1, Passed: 4'), 99).pass, false);
});

test('filesystem-backed driver validator uses normalized target/test evidence', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'baseline-contract-'));
  try {
    for (const name of ['A.sln', 'B.sln']) writeFileSync(join(worktree, name), '');
    const baseline = captureBaseline(suite('A.sln', ['Old']) + suite('B.sln'), { worktree });
    const options = { worktree, expected: { suite: ['A.sln', 'B.sln'] }, required: ['suite'], baseline };
    assert.equal(verifyTranscript(suite(join(worktree, 'A.sln'), ['Old']) + suite('B.sln'), options).pass, true);
    assert.equal(verifyTranscript(suite('A.sln', ['Old']) + suite('B.sln', ['Old']), options).pass, false);
  } finally { rmSync(worktree, { recursive: true, force: true }); }
});
