import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedEnvironment, availableModels, chooseModel, workerConfig, toolEvidence } from './live-opencode-workers.mjs';
import { OpenCodeServer } from './opencode/server-api.mjs';
import { digest } from './opencode/identity.mjs';

test('default auth context retained without inheriting config, credential env or plugins', () => {
  const env = authenticatedEnvironment('/owned', workerConfig(), { HOME: '/user', USERPROFILE: '/user',
    XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/secret-config', OPENCODE_CONFIG: '/secret.json',
    OPENCODE_CONFIG_CONTENT: 'secret', GITHUB_TOKEN: 'secret', NODE_OPTIONS: 'secret', PATH: '/bin' });
  assert.equal(env.HOME, '/user');
  assert.equal(env.XDG_DATA_HOME, '/data');
  assert.notEqual(env.XDG_CONFIG_HOME, '/secret-config');
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OPENCODE_CONFIG, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(JSON.stringify(env).includes('secret'), false);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.snapshot, false);
  assert.equal(config.agent['factory-live-reviewer'].permission.edit, 'deny');
  assert.equal(config.agent['factory-live-writer'].permission.external_directory, 'deny');
  assert.deepEqual(config.agent['factory-live-writer'].permission.bash, { '*': 'deny', 'node check.mjs': 'allow' });
});

test('discovery emits connected IDs only and routing never invents availability', () => {
  const models = availableModels({ connected: ['github-copilot'], all: [
    { id: 'github-copilot', options: { apiKey: 'secret' }, models: { 'gpt-5-mini': { secret: true } } },
    { id: 'private', models: { other: {} } },
  ] });
  assert.deepEqual(models, ['github-copilot/gpt-5-mini']);
  assert.equal(chooseModel(models), models[0]);
  assert.throws(() => chooseModel(models, 'private/other'));
  assert.throws(() => chooseModel([]));
});

test('tool evidence excludes arbitrary tool inputs, outputs and errors', () => {
  assert.deepEqual(toolEvidence([{ parts: [
    { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'secret' }, output: 'secret' } },
    { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'node check.mjs' } } },
  ] }]), [
    { tool: 'bash', status: 'completed', command: undefined },
    { tool: 'bash', status: 'completed', command: 'node check.mjs' },
  ]);
});

test('live v1 header-before-parts race waits, then completes; genuine mismatch still fails', async () => {
  const mapping = { sessionId: 'ses_live', messageId: 'msg_live', dispatchId: 'live', promptHash: digest('synthetic') };
  let parts = [];
  const api = new OpenCodeServer({ url: 'http://127.0.0.1:1', version: 'v1', fetchImpl: async url => {
    const path = new URL(url).pathname;
    const value = path === '/session/ses_live' ? { id: 'ses_live', title: 'factory:live', directory: '/owned' }
      : path === '/session/status' ? {}
      : [{ info: { id: 'msg_live', sessionID: 'ses_live', role: 'user' }, parts },
        { info: { id: 'msg_result', sessionID: 'ses_live', role: 'assistant', parentID: 'msg_live', finish: 'stop', time: { completed: 1 } }, parts: [{ type: 'text', text: '{"markerFound":true}' }] }];
    return Response.json(value);
  } });
  assert.equal(await api.admissionKnown(mapping, '/owned'), false);
  assert.deepEqual(await api.outcome(mapping, '/owned'), { pending: true });
  parts = [{ type: 'text', text: 'synthetic' }];
  assert.equal(await api.admissionKnown(mapping, '/owned'), true);
  const outcome = await api.outcome(mapping, '/owned');
  assert.equal(outcome.settled, true);
  assert.equal(outcome.actualModel, null);
  assert.equal(outcome.usage.input, null);
  assert.equal(outcome.cost, null);
  parts = [{ type: 'text', text: 'different' }];
  await assert.rejects(api.outcome(mapping, '/owned'), /durable prompt content mismatch/);
});
