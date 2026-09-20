import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchAgent } from './dispatcher.mjs';
import { digest } from './identity.mjs';
import { attachDispatchEvidence } from './admission.mjs';
import { invokedOpenCodeDispatch, observeAdmission } from '../lib/driver-integration.mjs';

const descriptor = { itemId: 'I', runId: 'run', attemptId: 'claim', dispatchId: 'dispatch', promptRef: 'prompt', promptHash: digest('prompt'), inputHash: 'input', role: 'fixer', schema: 'FIX_SCHEMA', route: { model: 'm' } };
const makeOptions = () => {
  const store = new Map([['prompt', { prompt: 'prompt', inputHash: 'input' }]]);
  return { store, descriptor, directory: '/wt', statePath: 'state', config: { models: { m: { providerID: 'p', modelID: 'm', agent: 'w' } }, agentTimeoutMs: 1000 },
    load: p => structuredClone(store.get(p)), present: p => store.has(p), persist: (p, v) => store.set(p, structuredClone(v)), observe: () => {}, wait: async () => {},
    api: { create: async () => 'ses_test', send: async () => null, outcome: async () => ({ failed: true, settled: true, error: 'provider unavailable' }), stop: async () => ({ stopped: true }) } };
};
const admitted = makeOptions();
await assert.rejects(dispatchAgent(admitted), /provider unavailable/);
const state = admitted.store.get('state');
assert.equal(state.invoked, true); assert.ok(state.admittedAt);
assert.equal(state.admission.claimId, 'claim'); assert.equal(invokedOpenCodeDispatch(state), true);
assert.equal(state.observation.actualModel, null); assert.equal(state.observation.measuredCost, null);
assert.equal(state.observation.inputTokens, null); assert.equal(state.observation.providerRequests, null);

const notSent = makeOptions(); notSent.api.create = async () => { throw new Error('create failed'); };
await assert.rejects(dispatchAgent(notSent), /create failed/);
assert.equal(notSent.store.get('state').admission, undefined);
assert.equal(invokedOpenCodeDispatch(notSent.store.get('state')), false);

const uncertain = makeOptions(); uncertain.api.send = async () => { throw new TypeError('fetch failed'); };
uncertain.api.outcome = async () => { throw new Error('poll unavailable'); };
uncertain.api.admissionKnown = async () => false;
await assert.rejects(dispatchAgent(uncertain), /poll unavailable/);
assert.equal(uncertain.store.get('state').admission, undefined);
assert.equal(invokedOpenCodeDispatch(uncertain.store.get('state')), false);

const recovered = makeOptions(); recovered.api.send = uncertain.api.send; recovered.api.admissionKnown = async () => true;
await assert.rejects(dispatchAgent(recovered), /provider unavailable/);
assert.equal(recovered.store.get('state').admission.source, 'durable-input');

const temp = mkdtempSync(join(tmpdir(), 'admission-portable-'));
try {
  mkdirSync(join(temp, 'dispatch'));
  writeFileSync(join(temp, 'dispatch/d-session.json'), JSON.stringify(state));
  const progress = { id: 'I', runId: 'run', attemptId: 'claim', claimId: 'claim', res: { id: 'I', runId: 'run', claimId: 'claim', toState: 'FAILED' } };
  attachDispatchEvidence(progress, temp);
  const portable = JSON.parse(JSON.stringify({ runId: 'run', results: [progress.res] }));
  assert.equal(portable.results[0].admission.attempted, true);
  assert.equal(portable.results[0].attemptObservations.length, 1);
  rmSync(join(temp, 'dispatch'), { recursive: true });
  const row = { runId: 'run', claimId: 'claim', attemptIdentity: { runId: 'run', claimId: 'claim', attemptNumber: 1, band: 'FULL', recovery: false } };
  const events = [];
  assert.equal(observeAdmission(portable.results[0], row, e => events.push(e)), true);
  assert.equal(row.attemptIdentity.admitted, true);
  assert.equal(events.length, 1, 'portable failed result proves admission without session mappings or usage');
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log('Admission receipts: acknowledged/recovered failures, unknown usage, uninvoked failures and portable driver admission passed');
