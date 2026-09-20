import test from 'node:test';
import assert from 'node:assert/strict';
import { productionLauncher, productionCliArgs, prepareProductionFixture, productionWorkflowOutput, replayOutputEvidence, preflightProduction, verifyFrozenFixture, verifyProductionLaunch, withFixtureEnvironment, sourceSnapshot, driverCommand, productionFoldCounts } from './live-claude-factory.mjs';
import { loadPolicies } from './lib/policy.mjs';
import { readRepoProfiles } from './lib/promptpack.mjs';
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { collectEvidenceIdentity } from './lib/evidence-identity.mjs';

test('production launcher only normalizes line endings and replaces official batch marker', () => {
  const source = "export const meta = {name:'factory'}\r\n/*__FACTORY_BATCH_INJECT__*/\r\nreturn await agent('actual pipeline')\r\n";
  const batch = { runId: 'fixture', items: [] };
  const launcher = productionLauncher(source, batch);
  assert.equal(launcher.replace('const __FACTORY_BATCH__ = ' + JSON.stringify(batch) + ';', '/*__FACTORY_BATCH_INJECT__*/'), source.replaceAll('\r\n', '\n'));
  assert.throws(() => productionLauncher('missing marker', batch));
  assert.throws(() => productionLauncher(source + '/*__FACTORY_BATCH_INJECT__*/', batch));
});

test('actual driver optional override suffix distinguishes clean closure from overridden fold', () => {
  assert.deepEqual(productionFoldCounts('warning\nfold: applied 9, rejected 0, skipped 0\n'), { applied: 9, rejected: 0, skipped: 0, overrides: 0 });
  assert.deepEqual(productionFoldCounts('fold: applied 1, rejected 0, skipped 0, deterministic-overrides 1\n'), { applied: 1, rejected: 0, skipped: 0, overrides: 1 });
  assert.equal(productionFoldCounts('fold: no new current results (already folded or stale)'), null);
  assert.equal(productionFoldCounts('fold: applied 9, rejected 0, skipped 0, deterministic-overrides unknown'), null);
  assert.equal(productionFoldCounts('fold: applied 9, rejected 0, skipped 0\nfold: applied 9, rejected 0, skipped 0'), null);
});

test('production permissions preserve source deny and scope executable helpers and artifact writes', () => {
  const f = { root: 'C:/temp/probe', engine: 'C:/temp/probe/engine', artifacts: 'C:/temp/probe/engine/state/items/X', worktree: 'C:/source', pin: 'C:/temp/probe/engine/state/items/X/pin.mjs', item: { id: 'X' } };
  const args = productionCliArgs(f, 'session');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '6');
  assert.ok(args.includes("Bash(node 'C:/temp/probe/engine/_workflow/native-evidence.mjs' *)"));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('Edit(//c/temp/probe/engine/state/items/X/**)'));
  assert.match(args[args.indexOf('--disallowedTools') + 1], /Edit\(\/\/c\/source\/\*\*\)/);
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('Bash(node *)'));
  assert.ok(args.includes('Bash(git -C "C:/source" status --porcelain)'));
  assert.ok(args.includes("Bash(git -C 'C:/source' diff HEAD -- CLAUDE.md)"));
  assert.ok(!args.includes('Bash(git *)'));
  assert.ok(!args.some(a => /^Bash\(git -C .*\*\)/.test(a)));
});

test('production fixture producer and independent driver consumer load identical policies and profiles', () => {
  const f = prepareProductionFixture();
  try {
    assert.deepEqual(f.batch.policies, loadPolicies(f.engine));
    assert.equal(f.batch.policies.isolateWorktreeWrites, false);
    assert.equal(Object.hasOwn(f.batch.policies, 'note'), false);
    assert.deepEqual(f.batch.repoProfiles, readRepoProfiles(f.engine + '/agents/repo-profiles'));
    const local = f.engine + '/config/factory.config.local.json';
    writeFileSync(local, JSON.stringify({ policies: { isolateWorktreeWrites: true } }));
    assert.equal(loadPolicies(f.engine).isolateWorktreeWrites, true);
    writeFileSync(local, JSON.stringify({ policies: { isolateWorktreeWrites: 'false' } }));
    assert.equal(loadPolicies(f.engine).isolateWorktreeWrites, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('truncated TaskOutput uses matching completed runtime notification, never controller prose', () => {
  const output = { agentCount: 1, result: { results: [{ toState: 'CLOSED' }], usage: { outputTokens: 0 } }, workflowProgress: [{ type: 'workflow_agent', state: 'done', cached: true }] };
  const events = [{ message: { content: [{ type: 'tool_use', name: 'TaskOutput', input: { task_id: 'task' } }] } }, { type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed', output_file: 'runtime.output' }];
  assert.deepEqual(productionWorkflowOutput(events, p => { assert.equal(p, 'runtime.output'); return JSON.stringify(output); }), output);
  assert.equal(replayOutputEvidence(output).agents.length, 1);
  assert.throws(() => productionWorkflowOutput([{ ...events[1], task_id: 'other' }], () => JSON.stringify(output)));
  assert.throws(() => productionWorkflowOutput(events, () => '{"result":"controller says cached"}'));
  assert.throws(() => replayOutputEvidence({ ...output, agentCount: 2 }));
  assert.throws(() => replayOutputEvidence({ ...output, workflowProgress: [{ type: 'workflow_agent', state: 'done', cached: false }] }));
});

test('frozen manifest rejects helper/profile/config drift and unofficial launcher or actual launch', async () => {
  const f = prepareProductionFixture();
  try {
    const manifest = JSON.parse(readFileSync(f.root + '/production.source-manifest.json', 'utf8'));
    const launcher = productionLauncher(readFileSync(f.engine + '/_workflow/factory.js', 'utf8'), f.batch);
    writeFileSync(f.root + '/production-launcher.js', launcher);
    const proof = await preflightProduction(f, manifest, f.batch);
    assert.equal(proof.allSourcesByteIdentical, true);
    assert.match(proof.launcherHash, /^[a-f0-9]{64}$/);
    for (const path of ['_workflow/driver.mjs', '_workflow/lib/native-evidence.mjs', 'agents/runner.md', 'agents/repo-profiles/FactoryReadOnly.md', 'config/factory.config.json']) {
      const full = f.engine + '/' + path, original = readFileSync(full);
      writeFileSync(full, Buffer.concat([original, Buffer.from('\n')]));
      assert.throws(() => verifyFrozenFixture(f, manifest, f.batch), /manifest changed/);
      writeFileSync(full, original);
    }
    writeFileSync(f.root + '/production-launcher.js', launcher + '\n');
    assert.throws(() => verifyFrozenFixture(f, manifest, f.batch), /official source\/batch/);
    writeFileSync(f.root + '/production-launcher.js', launcher);
    await assert.rejects(preflightProduction(f, manifest, { ...f.batch, policies: {} }), /contract mismatch/);
    const summary = { tools: [{ name: 'Workflow', input: { scriptPath: f.root + '/production-launcher.js' } }] };
    verifyProductionLaunch(summary, f.root + '/production-launcher.js');
    verifyProductionLaunch({ tools: [{ name: 'Workflow', input: { scriptPath: (f.root + '/production-launcher.js').replaceAll('/', '\\') } }] }, f.root + '/production-launcher.js');
    assert.throws(() => verifyProductionLaunch(summary, 'other.js'), /Actual Workflow launch/);
    assert.throws(() => verifyProductionLaunch(summary, f.root + '/production-launcher.js', 'wf_other'), /Actual Workflow launch/);
    assert.throws(() => verifyProductionLaunch({ tools: [...summary.tools, ...summary.tools] }, f.root + '/production-launcher.js'), /Actual Workflow launch/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('archived product uses real dynamic identity and read-only Git with separate current engine', async () => {
  const f = prepareProductionFixture(undefined, { stableProduct: true });
  const previous = process.env.GIT_WORK_TREE;
  try {
    const manifest = JSON.parse(readFileSync(f.root + '/production.source-manifest.json', 'utf8'));
    assert.equal(existsSync(f.worktree + '/.git'), false);
    assert.equal(existsSync(f.engine + '/.git'), false);
    writeFileSync(f.root + '/production-launcher.js', productionLauncher(readFileSync(f.engine + '/_workflow/factory.js', 'utf8'), f.batch));
    const proof = await preflightProduction(f, manifest, f.batch);
    assert.equal(proof.identity.baseRevision, manifest.productSnapshot.head);
    assert.ok(proof.identity.fileCount > 100);
    assert.equal(process.env.GIT_WORK_TREE, previous);
    const metadata = { reviewerContract: { briefs: f.batch.briefs }, acceptance: f.item.acceptance };
    const before = await withFixtureEnvironment(f, () => collectEvidenceIdentity(f.worktree, metadata));
    const path = f.worktree + '/CLAUDE.md', bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from('\nfixture identity mutation\n')]));
    const after = await withFixtureEnvironment(f, () => collectEvidenceIdentity(f.worktree, metadata));
    assert.notEqual(before.hash, after.hash);
    assert.throws(() => verifyFrozenFixture(f, manifest, f.batch), /Archived product/);
    writeFileSync(path, bytes);
    assert.equal(driverCommand(f, ['init']).exitCode, 0);
    assert.equal(driverCommand(f, ['claim', f.item.id]).exitCode, 0);
    assert.deepEqual(sourceSnapshot(f.worktree, f.gitEnv), manifest.productSnapshot.source);
    assert.equal(process.env.GIT_WORK_TREE, previous);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
