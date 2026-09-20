import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenCodeVersion, detectOpenCodeApi, waitForOpenCodeAgents, openCodeAuthHeaders } from './compatibility.mjs';
import { prepareDispatchConfig, dispatchAgent } from './dispatcher.mjs';
import { digest } from './identity.mjs';

test('published CLI version formats select matching API and config dialects', () => {
  assert.deepEqual(parseOpenCodeVersion('1.18.31\r\n'), { version: '1.18.31', apiVersion: 'v1', configMajor: 1 });
  assert.deepEqual(parseOpenCodeVersion('opencode v2.0.10\n'), { version: '2.0.10', apiVersion: 'v2', configMajor: 2 });
  for (const value of ['3.0.0', '0.0.0-beta-19507', '2.0.10-beta', 'error 2.0.10', '2.x', null]) assert.equal(parseOpenCodeVersion(value), null);
});

const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
test('v2 discovery tolerates a legacy endpoint HTML fallback and forwards auth', async () => {
  const called = [];
  const result = await detectOpenCodeApi({ url: 'http://127.0.0.1:1234', headers: { authorization: 'Basic isolated' }, fetchImpl: async (url, init) => {
    called.push(url);
    assert.equal(init.headers.authorization, 'Basic isolated');
    assert.equal(init.redirect, 'error');
    return url.endsWith('/api/info') ? response({ version: '2.0.10' }) : new Response('<html>not an API</html>');
  } });
  assert.equal(result.apiVersion, 'v2');
  assert.equal(called.length, 2);
});

test('healthy v1 remains selectable when v2 route is absent', async () => {
  const result = await detectOpenCodeApi({ url: 'http://localhost', fetchImpl: async url => url.endsWith('/global/health') ? response({ healthy: true, version: '1.18.31' }) : response({}, 404) });
  assert.equal(result.configMajor, 1);
});

test('auth failure blocks discovery without a valid candidate and explicit selection never falls back', async () => {
  for (const status of [401, 403]) {
    for (const other of [404, 401, 403, 200]) {
      await assert.rejects(detectOpenCodeApi({ url: 'http://localhost', fetchImpl: async url => url.endsWith('/api/info') ? response({}, status) : response({ healthy: false, version: '1.18.31' }, other) }), /authentication failed/);
    }
    const calls = [];
    await assert.rejects(detectOpenCodeApi({ url: 'http://localhost', version: 'v2', fetchImpl: async url => {
      calls.push(url);
      return url.endsWith('/api/info') ? response({}, status) : response({ healthy: true, version: '1.18.31' });
    } }), /authentication failed/);
    assert.deepEqual(calls, ['http://localhost/api/info']);
  }
});

test('ambiguous identities require explicit selection', async () => {
  const fetchImpl = async url => url.endsWith('/api/info') ? response({ version: '2.0.10' }) : response({ healthy: true, version: '1.18.31' });
  await assert.rejects(detectOpenCodeApi({ url: 'http://localhost', fetchImpl }), /ambiguous/);
  assert.equal((await detectOpenCodeApi({ url: 'http://localhost', version: 'v2', fetchImpl })).apiVersion, 'v2');
});

test('future versions, unhealthy and non-JSON servers fail diagnostically', async () => {
  for (const value of [{ version: '3.0.0' }, { version: '1.18.31', healthy: false }, null]) {
    await assert.rejects(detectOpenCodeApi({ url: 'http://localhost', fetchImpl: async () => response(value) }), /cannot discover supported/);
  }
});

test('startup readiness waits for every requested worker and preserves errors', async () => {
  let calls = 0;
  const api = { version: 'v2', agents: async () => ++calls === 1 ? [] : [{ id: 'writer' }, { id: 'reviewer' }] };
  assert.equal((await waitForOpenCodeAgents(api, '.', ['writer', 'reviewer'], { intervalMs: 1 })).length, 2);
  assert.equal(calls, 2);
  await assert.rejects(waitForOpenCodeAgents({ version: 'v2', agents: async () => [] }, '.', ['missing'], { timeoutMs: 5, intervalMs: 1 }), /not ready or not installed:.*missing/);
  await assert.rejects(waitForOpenCodeAgents({ version: 'v1', agents: async () => { throw new Error('HTTP 401'); } }, '.', ['writer']), /HTTP 401/);
  await assert.rejects(waitForOpenCodeAgents({ version: 'v2', agents: () => new Promise(() => {}) }, '.', ['writer'], { timeoutMs: 5 }), /readiness request timed out/);
});

test('dispatcher detection honors explicit identity and both password conventions without overriding headers', async () => {
  const env = { OPENCODE_PASSWORD: 'new', OPENCODE_SERVER_PASSWORD: 'old', OPENCODE_SERVER_USERNAME: 'custom' };
  assert.equal(openCodeAuthHeaders({}, env).authorization, 'Basic ' + Buffer.from('opencode:new').toString('base64'));
  assert.deepEqual(openCodeAuthHeaders({ Authorization: 'Bearer host' }, env), { Authorization: 'Bearer host' });
  assert.equal(openCodeAuthHeaders({}, { OPENCODE_SERVER_PASSWORD: 'old', OPENCODE_SERVER_USERNAME: 'custom' }, 'v1').authorization, 'Basic ' + Buffer.from('custom:old').toString('base64'));
  const config = { url: 'http://localhost', roles: { fixer: { agent: 'custom' } } };
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.authorization, openCodeAuthHeaders({}, env).authorization);
    return url.endsWith('/api/info') ? response({ version: '2.0.10' }) : new Response('not found', { status: 404 });
  };
  const prepared = await prepareDispatchConfig(config, { env, fetchImpl });
  assert.equal(prepared.version, 'v2');
  assert.deepEqual(prepared.roles, config.roles);
  assert.equal(config.version, undefined);
  await assert.rejects(prepareDispatchConfig({ ...config, version: 'v1' }, { env, fetchImpl }), /cannot discover supported/);
  const legacyEnv = { OPENCODE_SERVER_PASSWORD: 'pw', OPENCODE_SERVER_USERNAME: 'custom' };
  for (const version of ['v1', 'v2']) {
    const expected = 'Basic ' + Buffer.from((version === 'v1' ? 'custom' : 'opencode') + ':pw').toString('base64');
    const calls = [];
    const authenticatedFetch = async (url, init) => {
      calls.push({ url, auth: init.headers.authorization });
      if (init.headers.authorization !== expected) return response({}, 401);
      if (version === 'v1' && url.endsWith('/global/health')) return response({ healthy: true, version: '1.18.31' });
      if (version === 'v2' && url.endsWith('/api/info')) return response({ version: '2.0.10' });
      return response({}, 404);
    };
    const selected = await prepareDispatchConfig(config, { env: legacyEnv, fetchImpl: authenticatedFetch });
    assert.equal(selected.version, version);
    assert.equal(selected.headers.authorization, expected);
    assert.equal(calls.length, 2);
    assert.ok(calls.some(call => call.auth !== expected));
    await assert.rejects(prepareDispatchConfig({ ...config, version: version === 'v1' ? 'v2' : 'v1' }, { env: legacyEnv, fetchImpl: authenticatedFetch }), /authentication failed/);
    await assert.rejects(prepareDispatchConfig(config, { env: { ...legacyEnv, OPENCODE_SERVER_PASSWORD: 'wrong' }, fetchImpl: authenticatedFetch }), /authentication failed/);
  }
});

test('actual dispatcher waits before persistence/create and uses ready host override', async () => {
  let polls = 0, creates = 0;
  const saved = [];
  const prompt = 'isolated test';
  const descriptor = { itemId: 'ITEM', attemptId: 'attempt', dispatchId: 'dispatch', role: 'fixer', route: { model: 'claude-sonnet-5' }, promptRef: 'memory', promptHash: digest(prompt), inputHash: 'input' };
  const api = {
    version: 'v2',
    agents: async () => ++polls === 1 ? [] : [{ id: 'custom-writer', model: { id: 'host-model', providerID: 'host' } }],
    create: async (_descriptor, _directory, route) => { creates++; assert.equal(polls, 2); assert.equal(route.modelID, 'host-model'); throw new Error('stop before admission'); },
  };
  const config = { roles: { fixer: { agent: 'custom-writer' } }, profileReadyPollMs: 1, profileReadyTimeoutMs: 1000 };
  const args = { descriptor, directory: '.', statePath: 'memory', api, config, present: () => false, load: () => ({ prompt, inputHash: 'input' }), persist: (_path, value) => saved.push(structuredClone(value)), observe: () => {} };
  await assert.rejects(dispatchAgent(args), /stop before admission/);
  assert.equal(creates, 1);
  assert.equal(saved[0].requestedModel.providerID, 'host');
  saved.length = 0;
  await assert.rejects(dispatchAgent({ ...args, api: { ...api, agents: async () => [] }, config: { ...config, profileReadyTimeoutMs: 5 } }), /not ready/);
  assert.equal(saved.length, 0);
  assert.equal(creates, 1);
});
