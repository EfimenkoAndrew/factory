import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyShellcheckOutput, unavailableResult } from './shellcheck-lint.mjs';

// Real `shellcheck --format=json --severity=style --enable=all` output, captured against an actual
// script reproducing the MSG-CR-3 masking-bug shape (a function invoked as `f "$x" || ...` with no
// explicit $? capture inside it) — not hand-invented JSON. Confirms SC2310 ("This function is
// invoked in an || condition so set -e will be disabled...") is the check that catches this class,
// and that it ONLY appears with --enable=all (shellcheck's default check set returns [] on the
// identical file — verified separately, see the lib file's own header comment).
const MASKING_BUG_REAL_OUTPUT = '[{"file":"/tmp/masking-bug.sh","line":6,"endLine":6,"column":21,"endColumn":29,"level":"style","code":2250,"message":"Prefer putting braces around variable references even when not strictly required.","fix":null},{"file":"/tmp/masking-bug.sh","line":13,"endLine":13,"column":5,"endColumn":19,"level":"info","code":2310,"message":"This function is invoked in an || condition so set -e will be disabled. Invoke separately if failures should cause the script to exit.","fix":null},{"file":"/tmp/masking-bug.sh","line":13,"endLine":13,"column":21,"endColumn":29,"level":"style","code":2250,"message":"Prefer putting braces around variable references even when not strictly required.","fix":null}]';

test('a genuinely clean script (real shellcheck output, empty array) verdicts clean', () => {
  const result = classifyShellcheckOutput('[]', { exitCode: 0 });
  assert.equal(result.verdict, 'clean');
  assert.deepEqual(result.findings, []);
  assert.match(result.summary, /0 finding/);
});

test('the real MSG-CR-3 masking-bug shape is flagged, SC2310 marked notable', () => {
  const result = classifyShellcheckOutput(MASKING_BUG_REAL_OUTPUT, { exitCode: 1 });
  assert.equal(result.verdict, 'findings');
  assert.equal(result.findings.length, 3);
  const sc2310 = result.findings.find((f) => f.code === 2310);
  assert.ok(sc2310, 'SC2310 present in parsed findings');
  assert.equal(sc2310.level, 'info');
  assert.ok(sc2310.notable, 'SC2310 is marked as a notable, incident-cited class');
  assert.match(sc2310.notable, /MSG-CR-3 masking-bug/);
  // style-level noise (SC2250) must NOT be marked notable — only the incident-cited codes are.
  const style = result.findings.filter((f) => f.code === 2250);
  assert.equal(style.length, 2);
  for (const f of style) assert.equal(f.notable, null);
  assert.match(result.summary, /3 finding/);
  assert.match(result.summary, /1 notable/);
});

test('findings are sorted by severity rank (error, warning, info, style)', () => {
  const mixed = JSON.stringify([
    { file: 'x.sh', line: 1, column: 1, level: 'style', code: 2250, message: 'style nit' },
    { file: 'x.sh', line: 2, column: 1, level: 'error', code: 2086, message: 'real error' },
    { file: 'x.sh', line: 3, column: 1, level: 'info', code: 2310, message: 'masking class' },
    { file: 'x.sh', line: 4, column: 1, level: 'warning', code: 2034, message: 'unused var' },
  ]);
  const result = classifyShellcheckOutput(mixed);
  assert.deepEqual(result.findings.map((f) => f.level), ['error', 'warning', 'info', 'style']);
});

test('malformed JSON is inconclusive, never silently clean (KI-E185 anchored-grep lesson)', () => {
  const result = classifyShellcheckOutput('not valid json {{{');
  assert.equal(result.verdict, 'inconclusive');
  assert.notEqual(result.verdict, 'clean');
});

test('a JSON value that parses but is not an array is inconclusive, never silently clean', () => {
  const result = classifyShellcheckOutput('{"unexpected":"shape"}');
  assert.equal(result.verdict, 'inconclusive');
});

test('unavailableResult reports the reason and never claims clean or findings', () => {
  const result = unavailableResult('shellcheck: command not found');
  assert.equal(result.verdict, 'unavailable');
  assert.match(result.summary, /command not found/);
});

test('exitCode is carried through unmodified for the caller to report alongside the marker', () => {
  assert.equal(classifyShellcheckOutput('[]', { exitCode: 0 }).exitCode, 0);
  assert.equal(classifyShellcheckOutput(MASKING_BUG_REAL_OUTPUT, { exitCode: 1 }).exitCode, 1);
});
