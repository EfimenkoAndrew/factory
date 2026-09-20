import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareCode, foldCodeFailure, codeConfig, codeCommands, CODE_ID, CODE, TEST } from './live-opencode-code.mjs';
import { writeJsonAtomic, digest } from './opencode/identity.mjs';
import { resolveBash } from './lib/bash.mjs';
import { authenticatedEnvironment } from './live-opencode-workers.mjs';

test('role permissions separate tests/product/review and disallow other providers', () => {
  const fx = { root: 'C:/fixture', workspace: 'C:/fixture/state/worktrees/code', dir: 'C:/fixture/factory/state/items/code' };
  const config = codeConfig('github-copilot/gpt-5-mini', fx);
  const edits = id => config.agents[id].permissions.filter(p => p.action === 'edit' && p.effect === 'allow');
  assert.ok(edits('factory-code-test').every(p => p.resource.replace(/\\/g, '/').endsWith(TEST)));
  assert.ok(edits('factory-code-fixer').every(p => p.resource.replace(/\\/g, '/').endsWith(CODE)));
  assert.equal(edits('factory-code-review').length, 0);
  assert.ok(edits('factory-code-test').some(p => p.resource === 'state/worktrees/code/' + TEST));
  assert.ok(edits('factory-code-test').some(p => p.resource === TEST));
  assert.ok(config.agents['factory-code-test'].permissions.some(p => p.action === 'external_directory' && p.resource === 'C:/fixture/*'));
  assert.throws(() => codeConfig('anthropic/claude-sonnet-4-6', fx), /only-authorized/);
});

test('real offline fixture baseline and actual negative-test runtime/finalize/driver fold', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-code-regression-'));
  const oldEnv = { ...process.env };
  try {
    const fx = prepareCode(root);
    assert.match(readFileSync(join(root, 'before-suite.txt'), 'utf8'), /SUMMARY::suite exit=0 failed=0 passed=1/);
    assert.equal(existsSync(join(fx.workspace, TEST)), false);
    const cli = (name, args) => execFileSync(process.execPath, [join(fx.mount, '_workflow', name), ...args], { cwd: root, env: fx.env, encoding: 'utf8' });
    cli('opencode/runtime.mjs', ['init', CODE_ID, '--fixture', join(root, 'fixture.json')]);
    cli('driver.mjs', ['init']);
    const text = cli('opencode/runtime.mjs', ['next', CODE_ID]);
    const descriptor = JSON.parse(text.slice(text.indexOf('{'))).agents[0];
    const prompt = JSON.parse(readFileSync(descriptor.promptRef, 'utf8')).prompt;
    const commands = codeCommands(fx);
    assert.ok(prompt.lastIndexOf('HOST WORKER COMMAND CONTRACT') > prompt.lastIndexOf('BUILD CAPACITY CONTRACT'));
    assert.ok(prompt.lastIndexOf('CURRENT ROLE COMMANDS (test-author)') > prompt.lastIndexOf('HOST WORKER COMMAND CONTRACT'));
    const config = JSON.parse(readFileSync(join(fx.mount, 'config/factory.config.local.json'), 'utf8'));
    assert.match(config.workerRoleCommandHints['gate-qa'], /NEVER run red/);
    assert.match(config.workerRoleCommandHints['integrator'], /HANDOFF-ONLY/);
    const rules = codeConfig('github-copilot/gpt-5-mini', fx).agents['factory-code-test'].permissions;
    for (const command of Object.values(commands)) {
      assert.ok(prompt.includes(command), command + ' present in actual runtime prompt');
      assert.ok(rules.some(p => p.action === 'shell' && p.resource === command && p.effect === 'allow'), command + ' allowed');
    }
    const bash = resolveBash({ env: fx.env });
    for (const command of [commands.status, commands.diff, commands.suite]) {
      const output = execFileSync(bash, ['-c', command], { cwd: fx.workspace, env: fx.env, encoding: 'utf8', timeout: 120000 });
      if (command === commands.suite) assert.match(output, /SUMMARY::suite exit=0 failed=0 passed=1/);
    }
    const stripped = authenticatedEnvironment(root, {});
    delete stripped.APPDATA; delete stripped.LOCALAPPDATA;
    const isolated = execFileSync(process.execPath, [join(root, 'code-check.mjs'), 'suite'], { cwd: fx.workspace, env: stripped, encoding: 'utf8', timeout: 120000 });
    assert.match(isolated, /SUMMARY::suite exit=0 failed=0 passed=1/);
    const leftovers = cli('opencode/build-lease.mjs', [fx.mount, 'leftovers', fx.workspace]);
    assert.match(leftovers, /FACTORY::LEFTOVER::0/);
    const statePath = join(fx.dir, 'dispatch', descriptor.dispatchId + '-session.json');
    const value = { red: false, testFiles: [], runCmd: 'not executed', evidence: 'synthetic unit-test permission refusal', note: 'No regression proof' };
    writeJsonAtomic(statePath, { status: 'uncertain', stopped: false, outcome: { value } });
    assert.throws(() => foldCodeFailure(root), /settled-negative/);
    writeJsonAtomic(statePath, { status: 'completed', stopped: true, outcome: { value, actualModel: 'test/no-inference' } });
    const original = digest(readFileSync(join(fx.workspace, CODE)));
    const report = foldCodeFailure(root);
    assert.equal(report.folded.state, 'FAILED');
    assert.equal(report.finalized.codeChange, true);
    assert.match(report.finalized.note, /no red proof/);
    assert.equal(report.foldReplayUnchanged, true);
    assert.equal(digest(readFileSync(join(fx.workspace, CODE))), original);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

test('NuGet setup failure is rejected via actual runtime fail rather than submitted as RED', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-code-infra-'));
  const oldEnv = { ...process.env };
  try {
    const fx = prepareCode(root);
    const cli = (name, args) => execFileSync(process.execPath, [join(fx.mount, '_workflow', name), ...args], { cwd: root, env: fx.env, encoding: 'utf8' });
    cli('opencode/runtime.mjs', ['init', CODE_ID, '--fixture', join(root, 'fixture.json')]);
    cli('driver.mjs', ['init']);
    const text = cli('opencode/runtime.mjs', ['next', CODE_ID]);
    const descriptor = JSON.parse(text.slice(text.indexOf('{'))).agents[0];
    writeJsonAtomic(join(fx.dir, 'dispatch', descriptor.dispatchId + '-session.json'), { status: 'completed', stopped: true, outcome: { value: { red: true }, actualModel: 'test/no-inference' } });
    writeFileSync(join(fx.dir, 'verify-red-raw.txt'), 'NuGet.targets(745,5): error : setup failed\nFACTORY::RED::1\n');
    const report = foldCodeFailure(root);
    assert.equal(report.folded.state, 'FAILED');
    assert.equal(report.failureFold.infrastructureRedRejected, true);
    assert.equal(report.finalized.transitions.includes('RED'), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
