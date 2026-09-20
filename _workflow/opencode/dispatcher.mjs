import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OpenCodeServer, resolveRoute } from './server-api.mjs';
import { digest, writeJsonAtomic } from './identity.mjs';
import { extractJson } from './runtime.mjs';
import { validateNamed } from './schemas.mjs';
import { dispatchObservation, emitObservation } from './observations.mjs';
import { buildCapacity } from './build-lease.mjs';
import { agentReady, detectOpenCodeApi, openCodeAuthHeaders } from './compatibility.mjs';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = path => JSON.parse(readFileSync(path, 'utf8'));

export class Semaphore {
  constructor(limit) { if (!Number.isInteger(limit) || limit < 1) throw new Error('positive concurrency limit required'); this.limit = limit; this.active = 0; this.queue = []; }
  async run(fn) {
    if (this.active >= this.limit) await new Promise(resolve => this.queue.push(resolve));
    else this.active++;
    try { return await fn(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.active--; }
  }
}

export async function dispatchAgent({ descriptor, directory, statePath, api, config, persist = writeJsonAtomic, load = read, present = existsSync, wait = sleep, observe = emitObservation }) {
  if (!descriptor.itemId || !descriptor.attemptId || !descriptor.dispatchId) throw new Error('dispatch requires item/lifecycle-attempt/physical-dispatch identity');
  const existing = present(statePath) ? load(statePath) : null;
  const fencedError = message => { const e = new Error(message); if (existing && existing.stopped !== true) { e.unsettled = true; e.retryable = false; } return e; };
  const payload = load(descriptor.promptRef);
  if (digest(payload.prompt) !== descriptor.promptHash || payload.inputHash !== descriptor.inputHash) throw fencedError('dispatch payload identity mismatch');
  const route = existing?.requestedModel || (api.agents
    ? await agentReady(api, directory, definitions => resolveRoute(descriptor, config, definitions, api.version), { timeoutMs: config.profileReadyTimeoutMs ?? 30000, intervalMs: config.profileReadyPollMs ?? 250 })
    : api.route ? await api.route(descriptor, config, directory) : resolveRoute(descriptor, config));
  let state = existing || { dispatchId: descriptor.dispatchId, attemptId: descriptor.attemptId, runId: descriptor.runId || descriptor.attemptId, itemId: descriptor.itemId, directory, server: api.url || null, apiVersion: api.version || null, messageId: 'msg_' + digest(descriptor.dispatchId).slice(0, 32), requestedModel: route, inputHash: descriptor.inputHash, promptHash: descriptor.promptHash, status: 'creating', startedAt: Date.now(), runtimeVersion: api.runtimeInfo };
  if (state.dispatchId !== descriptor.dispatchId || state.attemptId !== descriptor.attemptId || state.inputHash !== descriptor.inputHash || state.promptHash !== descriptor.promptHash || state.directory !== directory || state.server !== (api.url || null) || state.apiVersion !== (api.version || null)) throw fencedError('persisted dispatch mapping mismatch');
  const save = () => {
    if (['completed', 'failed'].includes(state.status)) {
      state.completedAt ||= Date.now();
      state.observation ||= dispatchObservation(state, descriptor);
    }
    persist(statePath, state);
    if (state.observation) observe(state.observation);
  };
  const recordAdmission = source => {
    state.invoked = true;
    state.admittedAt ||= new Date().toISOString();
    state.admission ||= { version: 1, attempted: true, status: 'admitted', runId: state.runId,
      claimId: state.attemptId, itemId: state.itemId, dispatchId: state.dispatchId,
      sessionId: state.sessionId, messageId: state.messageId, startedAt: state.admittedAt, source };
    save();
  };
  let provenStopped = state.stopped === true && ['completed', 'failed'].includes(state.status);
  if (state.status === 'completed' && provenStopped) {
    if (!state.outcome?.value || !validateNamed(descriptor.schema, state.outcome.value).ok) throw new Error('cached completion missing valid response');
    try {
      if (api.verifySession) await api.verifySession(state, directory);
      const current = await api.outcome(state, directory);
      if (current?.settled !== true || current.pending || current.failed || digest(extractJson(current.text)) !== digest(state.outcome.value)) throw new Error('cached session completion no longer settled or matching');
      save(); return state.outcome;
    } catch (e) {
      state.status = 'uncertain'; state.stopped = false; state.error = e.message;
      delete state.observation; delete state.completedAt; persist(statePath, state);
      e.unsettled = true; e.retryable = false; throw e;
    }
  }
  if (state.status === 'failed' && provenStopped) { save(); throw new Error('dispatch has terminal failure; runtime must explicitly retry: ' + state.error); }
  save();
  try {
  if (['uncertain', 'cancelling', 'failed', 'completed'].includes(state.status)) throw new Error('reconcile previously uncertain execution before retry');
  if (!state.sessionId) {
    state.sessionId = await api.create(descriptor, directory, route);
    if (typeof state.sessionId !== 'string' || !state.sessionId.startsWith('ses')) throw new Error('missing session identity');
    state.status = 'created'; save();
  }
  if (api.verifySession) await api.verifySession(state, directory);
  if (state.status === 'created') {
    const priorMessages = api.messages ? await api.messages(state, directory) : [];
    const priorInput = priorMessages.some(m => (m.info?.id || m.id) === state.messageId);
    if (priorInput) state.status = 'admitted';
    else if (priorMessages.some(m => ['user', 'assistant', 'synthetic'].includes(m.info?.role || m.type))) throw new Error('nonempty reused dispatch session');
    if (!priorInput) {
    state.status = 'sending'; save();
    // On an uncertain response, recovery polls this same session; it never resends admission.
    try { await api.send(state, payload.prompt, route, directory); state.status = 'admitted'; recordAdmission('server-acknowledgement'); }
    catch (e) {
      state.admissionError = e.message;
      if (e.status && e.status < 500 && e.status !== 408) throw e;
      save();
    }
    }
  }
  const deadline = state.startedAt + (config.agentTimeoutMs || 20 * 60 * 1000);
  while (Date.now() < deadline) {
    let outcome;
    try {
      if (!state.invoked && api.admissionKnown && await api.admissionKnown(state, directory)) recordAdmission('durable-input');
      outcome = await api.outcome(state, directory);
    }
    catch (e) { if (e.retryable || e.name === 'TimeoutError' || (e instanceof TypeError && /fetch failed/i.test(e.message))) { await wait(config.pollMs || 1000); continue; } throw e; }
    if (!outcome || typeof outcome !== 'object') throw new Error('missing agent response');
    if (!outcome.pending && outcome.settled !== true) throw new Error('agent response lacks settled execution proof');
    if (outcome.settled === true) { provenStopped = true; state.stopped = true; }
    if (outcome.failed) {
      state.outcome = outcome;
      state.status = 'failed'; state.error = JSON.stringify(outcome.error); state.completedAt = Date.now(); save();
      const error = new Error(state.error); error.retryable = false; throw error;
    }
    if (!outcome.pending) {
      state.outcome = outcome;
      let value;
      try { value = extractJson(outcome.text); }
      catch (e) { state.status = 'failed'; state.error = 'malformed structured response: ' + e.message; state.completedAt = Date.now(); save(); throw new Error(state.error); }
      const validation = validateNamed(descriptor.schema, value);
      if (!validation.ok) { state.status = 'failed'; state.error = validation.errors.join('; '); save(); throw new Error('invalid structured response: ' + state.error); }
      state.status = 'completed'; state.completedAt = Date.now(); state.outcome = { ...outcome, value };
      save(); return state.outcome;
    }
    await wait(config.pollMs || 1000);
  }
  const e = new Error('agent timeout'); e.retryable = true; throw e;
  } catch (e) {
    if (!provenStopped && state.sessionId) {
      if (!state.invoked && api.admissionKnown) {
        try { if (await api.admissionKnown(state, directory)) recordAdmission('durable-input'); } catch { /* unknown admission stays unknown */ }
      }
      state.status = 'cancelling'; state.error = e.message; persist(statePath, state);
      try {
        if (!api.stop || (await api.stop(state, directory))?.stopped !== true) throw new Error('durable termination not proven');
        provenStopped = true; state.stopped = true;
      } catch (stop) {
        state.status = 'uncertain'; state.error = 'termination unavailable: ' + stop.message;
        delete state.observation; delete state.completedAt; persist(statePath, state);
        e.retryable = false; e.unsettled = true; throw e;
      }
    }
    // No prompt can have been sent before obtaining and persisting a session ID.
    if (!state.sessionId && existing && ['sending', 'admitted', 'uncertain', 'cancelling'].includes(existing.status)) {
      state.status = 'uncertain'; state.error = 'potentially live execution has no session identity'; persist(statePath, state);
      e.unsettled = true; e.retryable = false; throw e;
    }
    if (!state.sessionId) state.stopped = true;
    state.status = 'failed'; state.error = e.message; save();
    throw e;
  }
}

async function runtime(args) {
  const { stdout } = await exec(process.execPath, [join(HERE, 'runtime.mjs'), ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function driveItems(ids, config, api = new OpenCodeServer(config)) {
  const agents = new Semaphore(config.agentConcurrency || 4), builds = new Semaphore(config.buildConcurrency || 1);
  let unsettled = false;
  await api.check();
  // Drain persisted in-flight sessions before admitting any new work after controller restart.
  const resumed = [];
  for (const id of ids) {
    const progress = read(join(ROOT, 'state/items', id, 'opencode-progress.json'));
    for (const call of progress.pendingSet?.calls || []) {
      if (call.key in progress.pendingSet.received) continue;
      const statePath = join(ROOT, 'state/items', id, 'dispatch', call.dispatchId + '-session.json');
      if (!existsSync(statePath)) continue;
      const mapping = read(statePath);
      if (['completed', 'failed'].includes(mapping.status) && mapping.stopped === true) continue;
      resumed.push(agents.run(async () => {
        if (unsettled) throw new Error('batch stopped: unresolved server execution');
        try { await dispatchAgent({ descriptor: { ...call, schema: call.schema, attemptId: progress.attemptId, runId: progress.runId, itemId: id }, directory: progress.ctx.worktreePath, statePath, api, config }); }
        catch (e) { if (e.unsettled) { unsettled = true; throw e; } await runtime(['fail', id, '--dispatch', call.dispatchId, '--reason', e.message, ...(e.retryable ? ['--retryable'] : [])]); }
      }));
    }
  }
  const resumedResults = await Promise.allSettled(resumed);
  const resumeFailure = resumedResults.find(r => r.status === 'rejected');
  if (resumeFailure) throw resumeFailure.reason;
  return Promise.all(ids.map(async id => {
    try {
      for (;;) {
        if (unsettled) throw new Error('batch stopped: unresolved server execution');
        const text = await runtime(['next', id]);
        const plan = JSON.parse(text.slice(text.indexOf('{')));
        if (plan.done) { await runtime(['finalize', id]); return { id, ...plan }; }
        const path = join(ROOT, 'state/items', id, 'opencode-progress.json');
        const progress = read(path);
        if (plan.mechanical) {
          const args = ['mech', id, plan.mechanical];
          if (plan.mechanical === 'verify' && progress.res.codeChange && !progress.verifyFilter) {
            const target = config.items?.[id]?.target || progress.item.solution || progress.config?.solution;
            const filter = config.items?.[id]?.filter;
            if (!target || !filter) throw new Error('dispatch config items.' + id + ' requires target/filter for first code verification');
            args.push('--', target, filter);
          }
          await builds.run(() => runtime(args));
        } else {
          const outcomes = await Promise.allSettled(plan.agents.map(d => agents.run(async () => {
            if (unsettled) throw new Error('batch stopped: unresolved server execution');
            const statePath = join(dirname(path), 'dispatch', d.dispatchId + '-session.json');
            try {
              const result = await dispatchAgent({ descriptor: { ...d, itemId: id, runId: progress.runId }, directory: progress.ctx.worktreePath, statePath, api, config });
              const resultPath = join(dirname(path), 'dispatch', d.dispatchId + '-result.json');
              writeJsonAtomic(resultPath, result.value);
              await runtime(['submit', id, '--role', d.key, '--dispatch', d.dispatchId, '--model', result.actualModel || 'unknown', '--json', resultPath]);
            } catch (e) {
              if (e.unsettled) { unsettled = true; throw e; }
              const current = read(path);
              if (current.pendingSet?.calls.some(c => c.dispatchId === d.dispatchId)) await runtime(['fail', id, '--dispatch', d.dispatchId, '--reason', e.message, ...(e.retryable ? ['--retryable'] : [])]);
            }
          })));
          const failed = outcomes.find(r => r.status === 'rejected');
          if (failed) throw failed.reason;
        }
      }
    } catch (e) { return { id, unavailable: true, error: e.message }; }
  }));
}

export function parseDispatchArgs(argv) {
  if (!argv[0]?.startsWith('--')) return { config: read(argv[0]), ids: argv.slice(1) };
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--config', '--url', '--ids', '--version'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('unknown/incomplete dispatch option: ' + argv[i]);
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  const defaultPath = join(ROOT, 'config', 'opencode-dispatch.local.json');
  const config = flags.config ? read(flags.config) : existsSync(defaultPath) ? read(defaultPath) : {};
  if (flags.url) config.url = flags.url;
  if (flags.version) config.version = flags.version.startsWith('v') ? flags.version : 'v' + flags.version;
  return { config, ids: (flags.ids || '').split(',').filter(Boolean) };
}

export async function prepareDispatchConfig(config, { env = process.env, fetchImpl = fetch } = {}) {
  const detected = await detectOpenCodeApi({ url: config.url, version: config.version, fetchImpl: (url, init) => fetchImpl(url, { ...init, headers: openCodeAuthHeaders(config.headers, env, new URL(url).pathname.endsWith('/api/info') ? 'v2' : 'v1') }), timeoutMs: config.apiDetectionTimeoutMs ?? 10000 });
  return { ...config, headers: openCodeAuthHeaders(config.headers, env, detected.apiVersion), version: detected.apiVersion };
}

export async function main(argv = process.argv.slice(2)) {
  const { config, ids } = parseDispatchArgs(argv);
  if (!config.url || !ids.length || ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) throw new Error('usage: dispatch.mjs --url <server> --ids <id[,id]> [--version v1|v2] [--config <file>]');
  Object.assign(config, await prepareDispatchConfig(config));
  const lock = join(ROOT, 'state/opencode-dispatch.lock');
  mkdirSync(dirname(lock), { recursive: true });
  if (existsSync(lock)) {
    const pid = read(join(lock, 'owner.json')).pid;
    try { process.kill(pid, 0); throw new Error('dispatcher already active: ' + pid); }
    catch (e) { if (e.code !== 'ESRCH') throw e; rmSync(lock, { recursive: true }); }
  }
  mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  try {
    const batchPath = join(ROOT, 'state', 'opencode-dispatch-batch.json');
    const batch = { ids: [...new Set(ids)].sort(), configHash: digest({ ...config, headers: undefined }), completed: false };
    const prior = existsSync(batchPath) ? read(batchPath) : null;
    if (prior && !prior.completed && (digest(prior.ids) !== digest(batch.ids) || prior.configHash !== batch.configHash)) throw new Error('resume the entire active dispatcher batch with its original config before starting another batch');
    writeJsonAtomic(batchPath, batch);
    const limit = buildCapacity(ROOT, config.buildConcurrency);
    writeJsonAtomic(join(ROOT, 'state', 'build-capacity.json'), { limit });
    const results = await driveItems(batch.ids, config);
    batch.completed = results.every(r => r.done); writeJsonAtomic(batchPath, batch);
    if (!batch.completed) process.exitCode = 1;
    console.log(JSON.stringify(results, null, 2));
  }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
