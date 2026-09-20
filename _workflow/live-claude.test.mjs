import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cliArgs, parseEvents, summarize, completedWorkflow, verifyPrimitive, fixturePassed, fixtureOracle, DEFAULT_PARENT } from './live-claude.mjs';

test('CLI bounds spend and turns, persists session, and grants only fixture file writes', () => {
  const args = cliArgs({ sessionId: 'test', prompt: 'explicit Workflow request', fixture: true });
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '1.5');
  assert.equal(args[args.indexOf('--max-turns') + 1], '12');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  const allow = args[args.indexOf('--allowedTools') + 1];
  assert.match(allow, /Edit\(\.\/clamp.mjs\)/);
  assert.doesNotMatch(allow, /Write\(|Edit\(\.\/\*\*\)|Bash|PowerShell/);
  assert.ok(!args.includes('--no-session-persistence'));
  assert.ok(cliArgs({ sessionId: 'test', prompt: 'resume', resume: true }).includes('--resume'));
});

test('missing/invalid result never becomes success', () => {
  const summary = summarize(parseEvents('not json\n{"type":"system"}\n'), { exitCode: 0 });
  assert.equal(summary.isError, null);
  assert.equal(summary.usage, null);
  assert.throws(() => completedWorkflow([{ type: 'result', result: 'Workflow passed!' }]));
});

test('machine completion and cached agents required, not controller prose or unchanged file alone', () => {
  const result = { results: [{ value: 'schema-ok' }, { value: 'token' }], usage: { sharedOutputTokensBefore: 2, sharedOutputTokensAfter: 20 } };
  const initial = { result, workflowProgress: [] };
  const replay = { result: { ...result, usage: { sharedOutputTokensBefore: 5, sharedOutputTokensAfter: 5 } }, workflowProgress: [1, 2].map(() => ({ type: 'workflow_agent', state: 'done', cached: true })) };
  const events = [{ message: { content: [{ type: 'tool_result', content: '<status>completed</status><output>' + JSON.stringify(initial) + '</output>' }] } }];
  assert.deepEqual(completedWorkflow(events), initial);
  assert.equal(verifyPrimitive(initial, replay, 'token').replayAgents.length, 2);
  assert.throws(() => verifyPrimitive(initial, replay, 'different'));
  assert.throws(() => verifyPrimitive(initial, { ...replay, workflowProgress: [] }, 'token'));
  assert.throws(() => verifyPrimitive(initial, { ...replay, result }, 'token'));
});

test('factory fixture rejects scope stops and fabricated test attestation even with passing source', () => {
  const result = { fixes: [1, 2].map(() => ({ applied: true, scopeStop: false, summary: 'fixed' })), gates: [1, 2].map(() => ({ gate: 'review', verdict: 'APPROVED', headline: 'source correct' })) };
  const summary = { exitCode: 0, isError: false }, green = { exitCode: 0 };
  assert.equal(fixturePassed(summary, green, result), true);
  result.fixes[0].scopeStop = true;
  assert.equal(fixturePassed(summary, green, result), false);
  result.fixes[0].scopeStop = false;
  result.gates[0].redGreenConfirmed = true;
  assert.equal(fixturePassed(summary, green, result), false);
  delete result.gates[0].redGreenConfirmed;
  assert.equal(fixturePassed(summary, { exitCode: 1 }, result), false);
});

test('independent subprocess oracle observes real failing and passing fixture code', () => {
  const root = mkdtempSync(join(DEFAULT_PARENT, 'factory-claude-test-'));
  try {
    writeFileSync(join(root, 'clamp.mjs'), 'export function clamp(x) {return x;}');
    const red = fixtureOracle(root);
    assert.equal(red.exitCode, 1);
    assert.match(red.stderr, /AssertionError/);
    writeFileSync(join(root, 'clamp.mjs'), 'export function clamp(x,lo,hi) {return Math.min(hi,Math.max(lo,x));}');
    const green = fixtureOracle(root);
    assert.equal(green.exitCode, 0);
    assert.match(green.stdout, /8 clamp cases passed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
