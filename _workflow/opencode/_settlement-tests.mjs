import assert from 'node:assert/strict';
import { OpenCodeServer } from './server-api.mjs';
import { dispatchAgent } from './dispatcher.mjs';
import { digest } from './identity.mjs';
import { lifecycleForLaunch, applyPhaseResults } from './runtime.mjs';
import { effectiveInfraRequirement } from '../lib/effective-infra.mjs';
import { completeCommand } from './contracts.mjs';
import { completeCommand as sharedCommand } from '../lib/stage-evidence.mjs';
import { extractFactoryRoles, extractFactoryGateKeys, extractPortRoles, parityGaps } from '../lib/port-parity.mjs';
import { STAGE_PARITY } from './stage-parity.mjs';
import { readFileSync } from 'node:fs';
import { validate } from './schemas.mjs';
import { createServer } from 'node:http';

async function localApi(version, handler, run) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const result = handler(req.method, new URL(req.url, 'http://localhost').pathname,
        chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined);
      res.writeHead(result === undefined ? 204 : 200, { 'content-type': 'application/json' });
      res.end(result === undefined ? undefined : JSON.stringify(result));
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(new OpenCodeServer({ url: 'http://127.0.0.1:' + server.address().port, version })); }
  finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
}

const mapping = { dispatchId: 'd', sessionId: 'ses_d', messageId: 'msg_d', promptHash: digest('prompt'), requestedModel: { agent: 'worker', providerID: 'p', modelID: 'm' } };
let busy = true, running = true;
const api = new OpenCodeServer({ url: 'http://fake', version: 'v1' });
api.verifySession = async () => {};
api.messages = async () => [
  { info: { id: 'msg_d', role: 'user', sessionID: 'ses_d' }, parts: [{ type: 'text', text: 'prompt' }] },
  { info: { role: 'assistant', sessionID: 'ses_d', parentID: 'msg_d', time: { completed: 123 }, finish: 'stop' }, parts: [{ type: 'text', text: '{"red":true,"note":"done"}' }, { type: 'tool', state: { status: running ? 'running' : 'completed' } }] },
];
api.request = async (_method, path) => { assert.equal(path, '/session/status'); return busy ? { ses_d: { type: 'busy' } } : {}; };
assert.ok((await api.outcome(mapping, '/wt')).pending, 'stop with running tool cannot complete');
busy = false;
assert.ok((await api.outcome(mapping, '/wt')).pending, 'idle alone cannot complete a running tool');
busy = true; running = false;
assert.ok((await api.outcome(mapping, '/wt')).pending, 'settled tool while runner still busy cannot complete');
busy = false;
assert.equal((await api.outcome(mapping, '/wt')).settled, true);

for (const version of ['v1', 'v2']) {
  const racing = new OpenCodeServer({ url: 'http://fake', version });
  racing.verifySession = async () => {};
  let revision = 'APPROVED', reads = 0;
  const messages = verdict => version === 'v1' ? [
    { info: { id: 'msg_d', role: 'user', sessionID: 'ses_d' }, parts: [{ type: 'text', text: 'prompt' }] },
    { info: { role: 'assistant', sessionID: 'ses_d', parentID: 'msg_d', time: { completed: 1 }, finish: 'stop' }, parts: [{ type: 'text', text: JSON.stringify({ verdict }) }, { type: 'tool', state: { status: 'completed' } }] },
  ] : [
    { id: 'msg_d', type: 'user', text: 'prompt' },
    { type: 'assistant', time: { completed: 1 }, finish: 'stop', content: [{ type: 'text', text: JSON.stringify({ verdict }) }, { type: 'tool', state: { status: 'completed' } }] },
  ];
  racing.messages = async () => { reads++; return messages(revision); };
  racing.executionIdle = async () => { revision = 'CHANGES_REQUIRED'; return true; };
  racing.inbox = async () => [];
  assert.deepEqual(await racing.outcome(mapping, '/wt'), { pending: true }, version + ' does not accept pre-idle APPROVED');
  assert.equal(reads, 2, 'messages reread after idle');
  assert.equal(JSON.parse((await racing.outcome(mapping, '/wt')).text).verdict, 'CHANGES_REQUIRED');
  let idleReads = 0;
  racing.executionIdle = async () => ++idleReads === 1;
  assert.deepEqual(await racing.outcome(mapping, '/wt'), { pending: true }, 'runner restarts after second message read');
}

const delayed = new OpenCodeServer({ url: 'http://fake', version: 'v1' });
delayed.verifySession = async () => {};
let started = false, completeParts = false, terminal = false, aborts = 0;
delayed.messages = async () => [
  { info: { id: 'msg_d', role: 'user', sessionID: 'ses_d' }, parts: completeParts ? [{ type: 'text', text: 'prompt' }] : [] },
  ...(terminal ? [{ info: { role: 'assistant', sessionID: 'ses_d', parentID: 'msg_d', time: { completed: 1 }, finish: 'stop' }, parts: [] }] : []),
];
delayed.executionIdle = async () => !started;
delayed.interrupt = async () => { aborts++; started = false; return true; };
for (let n = 0; n < 12; n++) await assert.rejects(delayed.stop(mapping, '/wt'), /handler may not have started/);
completeParts = true;
for (let n = 0; n < 12; n++) await assert.rejects(delayed.stop(mapping, '/wt'), /handler may not have started/);
assert.equal(aborts, 24, 'repeated acknowledged abort/idle cannot prove detached handler completion');
started = true;
assert.equal((await delayed.stop(mapping, '/wt')).stopped, true, 'matching prompt with observed busy execution may be aborted');
terminal = true;
assert.equal((await delayed.stop(mapping, '/wt')).stopped, true, 'matching terminal record proves startup occurred');
completeParts = false;
await assert.rejects(delayed.stop(mapping, '/wt'), /handler may not have started/, 'terminal cannot substitute missing durable prompt parts');
const empty = new OpenCodeServer({ url: 'http://fake', version: 'v1' });
empty.verifySession = async () => {}; empty.messages = async () => []; empty.executionIdle = async () => true; empty.interrupt = async () => true;
await assert.rejects(empty.stop(mapping, '/wt'), /handler may not have started/, 'empty session after unknown send is not proven unsent');

const nullable = { type: ['object', 'null'], additionalProperties: false, required: ['baseline'], properties: {
  baseline: { type: ['object', 'null'], additionalProperties: false, required: ['pass', 'failures'], properties: {
    pass: { type: 'boolean' }, failures: { type: ['array', 'null'], items: { type: 'string' } },
  } },
} };
assert.equal(validate(nullable, null).ok, true);
assert.equal(validate(nullable, { baseline: null }).ok, true);
assert.equal(validate(nullable, { baseline: { pass: true, failures: [] } }).ok, true);
for (const value of [{}, { baseline: {} }, { baseline: { pass: 'true', failures: [] } }, { baseline: { pass: true, failures: [123] } }, { baseline: null, extra: true }]) {
  assert.equal(validate(nullable, value).ok, false, JSON.stringify(value));
}
assert.equal(validate({ ...nullable, enum: [null] }, { baseline: null }).ok, false, 'enum applies independently to nullable object');
assert.equal(validate(nullable, { baseline: { pass: true, failures: null } }).ok, true);
assert.equal(validate(nullable, { baseline: { pass: true, failures: [], extra: false } }).ok, false);
assert.equal(validate({ type: ['object', 'null'], additionalProperties: false }, { extra: true }).ok, false);
assert.equal(validate({ type: ['object', 'null'], additionalProperties: false }, null).ok, true);
assert.equal(validate({ required: ['pass'] }, {}).ok, false);
assert.equal(validate({ items: nullable }, [{ baseline: { pass: 'true', failures: null } }]).ok, false);
assert.equal(validate({ type: ['object', 'null'], additionalProperties: { type: 'boolean' } }, { extra: 'true' }).ok, false);
assert.equal(validate(nullable, JSON.parse('{"baseline":null,"toString":true}')).ok, false);

// A v2 admission can sit durably in the inbox with no active foreground execution.
const v2 = new OpenCodeServer({ url: 'http://fake', version: 'v2' });
v2.verifySession = async () => {};
let queued = true, active = false, cancelWorks = true, calls = [];
v2.request = async (method, path, body) => {
  calls.push([method, path]);
  if (method === 'DELETE') { assert.equal(path, '/api/session/ses_d/inbox/msg_d'); if (cancelWorks) queued = false; return null; }
  if (path.endsWith('/interrupt?resume=false')) { assert.equal(body, undefined); active = false; return { interrupted: false }; }
  if (path.endsWith('/inbox')) return { data: queued ? [{ id: 'msg_d', sessionID: 'ses_d', type: 'user' }] : [] };
  if (path === '/api/session/active') return { data: active ? { ses_d: {} } : {} };
  if (path.includes('/message?')) return { data: [], cursor: { next: null } };
  throw new Error('unexpected endpoint ' + path);
};
assert.equal((await v2.stop(mapping, '/wt')).stopped, true);
assert.equal(calls[0][0], 'DELETE', 'cancel pending input before interrupting active execution');
queued = true; cancelWorks = false;
await assert.rejects(v2.stop(mapping, '/wt'), /not proven stopped/, 'interrupt false cannot clear admitted-undelivered input');

const descriptor = { itemId: 'I', runId: 'R', attemptId: 'claim', dispatchId: 'D', promptRef: 'prompt', promptHash: digest('prompt'), inputHash: 'hash', role: 'test-author', schema: 'TEST_SCHEMA', route: { model: 'm' } };
const state = { ...mapping, dispatchId: 'D', attemptId: 'claim', runId: 'R', itemId: 'I', inputHash: 'hash', promptHash: descriptor.promptHash, directory: '/wt', server: null, apiVersion: null, status: 'uncertain', startedAt: Date.now() };
const store = new Map([['prompt', { prompt: 'prompt', inputHash: 'hash' }], ['state', state]]);
let stops = 0, sends = 0;
const options = { descriptor, directory: '/wt', statePath: 'state', config: {}, load: p => structuredClone(store.get(p)), present: p => store.has(p), persist: (p, v) => store.set(p, structuredClone(v)), observe: () => {}, api: { verifySession: async () => { throw new Error('malformed poll'); }, send: async () => { sends++; }, stop: async () => { stops++; throw new Error('network failure'); } } };
{
  let rows = [], runner = false, cancelled = 0, prompts = 0;
  await localApi('v1', (method, path, body) => {
    if (path === '/session/ses_d') return { id: 'ses_d', title: 'factory:D', directory: '/wt' };
    if (path === '/session/ses_d/prompt_async') {
      prompts++;
      rows = [{ info: { id: body.messageID, role: 'user', sessionID: 'ses_d' }, parts: [] }];
      return undefined;
    }
    if (path === '/session/ses_d/message') return rows;
    if (path === '/session/status') return runner ? { ses_d: { type: 'busy' } } : {};
    if (path === '/session/ses_d/abort') { if (runner) { runner = false; cancelled++; } return true; }
    throw new Error('unexpected endpoint ' + method + ' ' + path);
  }, async api => {
    const persisted = new Map([['prompt', { prompt: 'prompt', inputHash: 'hash' }], ['state', {
      ...state, server: api.url, apiVersion: 'v1', status: 'admitted', startedAt: 1,
    }]]);
    const opts = { ...options, api, config: { agentTimeoutMs: 1 }, load: p => structuredClone(persisted.get(p)),
      present: p => persisted.has(p), persist: (p, v) => persisted.set(p, structuredClone(v)) };
    await api.send(persisted.get('state'), 'prompt', mapping.requestedModel, '/wt');
    for (let n = 0; n < 3; n++) {
      await assert.rejects(dispatchAgent(opts), e => e.unsettled === true && e.retryable === false);
      assert.equal(persisted.get('state').status, 'uncertain');
      assert.equal(persisted.get('state').stopped, undefined);
    }
    assert.equal(cancelled, 0, 'no-runner abort cannot cancel suspended prompt handler');
    rows[0].parts = [{ type: 'text', text: 'prompt' }];
    runner = true;
    assert.equal(await api.executionIdle(persisted.get('state'), '/wt'), false, 'handler starts after all acknowledged aborts');
    await assert.rejects(dispatchAgent(opts), /uncertain execution/);
    assert.equal(cancelled, 1);
    assert.equal(persisted.get('state').stopped, true);
    assert.equal(prompts, 1, 'uncertain restarts never resend or launch a fresh writer');
  });
}

for (const version of ['v1', 'v2']) {
  let revision = 0, reads = 0, toolStatus = 'completed';
  const assistant = (id, verdict, tool) => version === 'v1'
    ? { info: { id, role: 'assistant', sessionID: 'ses_d', parentID: 'msg_d', time: { completed: 1 }, finish: 'stop' }, parts: [
      { type: 'text', text: JSON.stringify({ gate: 'code', verdict, headline: verdict }) }, ...(tool ? [{ type: 'tool', state: { status: toolStatus } }] : [])] }
    : { id, type: 'assistant', time: { completed: 1 }, finish: 'stop', content: [
      { type: 'text', text: JSON.stringify({ gate: 'code', verdict, headline: verdict }) }, ...(tool ? [{ type: 'tool', state: { status: toolStatus } }] : [])] };
  await localApi(version, (method, path) => {
    if (path === '/session/ses_d') return { id: 'ses_d', title: 'factory:D', directory: '/wt' };
    if (path === '/api/session/ses_d') return { data: { id: 'ses_d', title: 'factory:D', location: { directory: '/wt' }, agent: 'worker', model: { providerID: 'p', id: 'm' } } };
    if (path.endsWith('/message')) {
      reads++;
      const rows = [version === 'v1'
        ? { info: { id: 'msg_d', role: 'user', sessionID: 'ses_d' }, parts: [{ type: 'text', text: 'prompt' }] }
        : { id: 'msg_d', type: 'user', text: 'prompt' }, assistant('msg_intermediate', 'APPROVED', true),
      ...(revision ? [assistant('msg_final', 'CHANGES_REQUIRED', false)] : [])];
      return version === 'v1' ? rows : { data: rows, cursor: { next: null } };
    }
    if (path === '/session/status' || path === '/api/session/active') { revision++; return version === 'v1' ? {} : { data: {} }; }
    if (path.endsWith('/inbox')) return { data: [] };
    throw new Error('unexpected endpoint ' + method + ' ' + path);
  }, async api => {
    const current = { ...mapping, dispatchId: 'D' };
    assert.deepEqual(await api.outcome(current, '/wt'), { pending: true }, 'HTTP race must reject pre-idle APPROVED');
    assert.equal(reads, 2);
    toolStatus = 'running';
    assert.deepEqual(await api.outcome(current, '/wt'), { pending: true }, 'latest terminal cannot hide unsettled earlier tool');
    toolStatus = 'completed';
    const persisted = new Map([['prompt', { prompt: 'prompt', inputHash: 'hash' }], ['state', {
      ...state, server: api.url, apiVersion: version, status: 'admitted', startedAt: Date.now(),
    }]]);
    const result = await dispatchAgent({ ...options, descriptor: { ...descriptor, schema: 'GATE_SCHEMA' }, api,
      load: p => structuredClone(persisted.get(p)), present: p => persisted.has(p),
      persist: (p, v) => persisted.set(p, structuredClone(v)) });
    assert.equal(result.value.verdict, 'CHANGES_REQUIRED');
    assert.equal(persisted.get('state').outcome.value.verdict, 'CHANGES_REQUIRED');
  });
}
await assert.rejects(dispatchAgent(options), e => e.unsettled === true && e.retryable === false);
assert.equal(stops, 1); assert.equal(sends, 0); assert.equal(store.get('state').status, 'uncertain');
assert.equal(store.get('state').observation, undefined, 'no terminal observation for live uncertain session');
const delayedStore = new Map([['prompt', { prompt: 'prompt', inputHash: 'hash' }], ['state', {
  ...state, dispatchId: 'D', sessionId: 'ses_d', messageId: 'msg_d', server: delayed.url, apiVersion: 'v1', status: 'admitted', startedAt: 1,
}]]);
const delayedOptions = { ...options, api: delayed, config: { agentTimeoutMs: 1 }, load: p => structuredClone(delayedStore.get(p)),
  present: p => delayedStore.has(p), persist: (p, v) => delayedStore.set(p, structuredClone(v)) };
for (let n = 0; n < 3; n++) {
  await assert.rejects(dispatchAgent(delayedOptions), e => e.unsettled === true && e.retryable === false);
  assert.equal(delayedStore.get('state').status, 'uncertain', 'delayed startup remains fenced across restart');
  assert.equal(delayedStore.get('state').observation, undefined);
}
options.api.stop = async () => { stops++; return { stopped: true }; };
await assert.rejects(dispatchAgent(options), /uncertain execution/);
assert.equal(stops, 2); assert.equal(store.get('state').status, 'failed'); assert.equal(store.get('state').stopped, true);
for (const failure of [null, Object.assign(new Error('HTTP unauthorized'), { status: 401 })]) {
  store.set('state', { ...state, status: 'admitted', stopped: false, startedAt: Date.now() });
  const liveOptions = { ...options, config: { agentTimeoutMs: 1000 }, api: { verifySession: async () => {}, outcome: async () => { if (failure) throw failure; return null; }, stop: async () => { stops++; throw new Error('cannot cancel'); } } };
  await assert.rejects(dispatchAgent(liveOptions), e => e.unsettled === true);
  assert.equal(store.get('state').status, 'uncertain');
  await assert.rejects(dispatchAgent(liveOptions), e => e.unsettled === true);
  assert.equal(store.get('state').status, 'uncertain', 'restart cannot downgrade live failure to terminal');
}
// Exercise admitted-but-undelivered cancellation through dispatchAgent, not only stop().
queued = true; cancelWorks = true; calls = [];
const queuedState = { ...state, sessionId: mapping.sessionId, messageId: mapping.messageId, server: v2.url, apiVersion: 'v2', status: 'admitted', stopped: false, startedAt: Date.now() - 1000 };
store.set('state', queuedState);
await assert.rejects(dispatchAgent({ ...options, config: { agentTimeoutMs: 1 }, api: v2 }), /timeout/);
assert.equal(queued, false); assert.equal(store.get('state').stopped, true);
assert.ok(calls.some(([method, path]) => method === 'DELETE' && path.endsWith('/inbox/msg_d')));

const row = { runId: 'run', claimId: 'claim', attemptNumber: 4, attemptIdentity: { startedAt: '2026-09-19T00:00:00Z' } };
assert.deepEqual(lifecycleForLaunch(row, { runId: 'run' }, row), { runId: 'run', claimId: 'claim', attemptId: 'claim', attemptNumber: 4, startedAt: Date.parse(row.attemptIdentity.startedAt) });
assert.throws(() => lifecycleForLaunch(row, { runId: 'other' }, row), /differs/);
const p = { phase: 'realinfra_adjudicate', test: { realInfraOverride: 'pure formatting' }, res: { transitions: [], gates: {}, gateDetails: {} }, pendingSet: { phaseKey: 'realinfra_adjudicate', received: { adjudicator: { verdict: 'OVERRULED', headline: 'no provider dependence', reasons: ['only transforms text'] } } } };
applyPhaseResults(p);
assert.equal(p.res.infraClassification.version, 1);
assert.equal(effectiveInfraRequirement(JSON.parse(JSON.stringify(p.res)), true), false);
p.res.gateDetails['adjudicator:realinfra-override'].reasons = ['mismatch'];
assert.equal(effectiveInfraRequirement(p.res, true), true);
assert.equal(effectiveInfraRequirement({ needsRealInfra: false, infraClassification: { version: 1, original: false, effective: false } }, true), true);
assert.equal(completeCommand, sharedCommand, 'one shared command-completion implementation');
const factory = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('./runtime.mjs', import.meta.url), 'utf8');
const gaps = parityGaps(extractFactoryRoles(factory), extractPortRoles(runtime), STAGE_PARITY, extractFactoryGateKeys(factory));
assert.ok(Object.values(gaps).every(a => !a.length), JSON.stringify(gaps));
console.log('Settlement regressions: running tools/busy runner, durable inbox cancel, uncertain restart, shared lifecycle/infra/evidence/parity passed');
