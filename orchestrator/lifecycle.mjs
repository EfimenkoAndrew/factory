import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { computeReady } from '../_workflow/lib/graph.mjs';
import { itemReadiness } from '../_workflow/lib/readiness.mjs';
import { bandFor } from '../_workflow/lib/band.mjs';

export function groupArguments(cfg, { label, token, ids } = {}) {
  if (cfg.backend === 'dry') throw new Error('dry planning must not call the lease-claiming driver group command');
  const args = ['group', '--max', String(cfg.maxItemsPerLane), '--conc', String(cfg.modelConcurrency), '--build-capacity', String(cfg.buildCapacity)];
  if (label) args.push('--label', label);
  if (ids) args.push('--ids', ids);
  if (cfg.includeRealinfra) args.push('--include-realinfra');
  if (token) args.push('--controller', token);
  return args;
}

export function schedulerSuggestions(graph, ledger, cfg, engine, ids) {
  const requested = ids ? new Set(ids.split(',').map((id) => id.trim()).filter(Boolean)) : null;
  const ready = computeReady(graph, ledger, { maxItemRetries: engine.maxItemRetries });
  const selected = [], deferred = [], files = new Set();
  for (const item of ready) {
    if (requested && !requested.has(item.id)) continue;
    const readiness = itemReadiness(item);
    const reason = !readiness.ready ? 'input-not-ready' : item.realInfra && !cfg.includeRealinfra ? 'real-infra-excluded' : item.files.some((f) => files.has(f)) ? 'file-overlap' : selected.length >= cfg.maxItemsPerLane ? 'lane-capacity' : null;
    if (reason) { deferred.push({ id: item.id, reason, problems: readiness.problems }); continue; }
    selected.push({ id: item.id, band: bandFor(item) });
    for (const file of item.files) files.add(file);
  }
  return { version: 1, dry: true, advisory: true, cycle: ledger.cycle + 1, selected, deferred, ids: selected.map((i) => i.id), modelConcurrency: cfg.modelConcurrency, buildCapacity: cfg.buildCapacity, buildCapacityEnforced: false, revalidateAtGroup: true };
}

export function launchFromGroup(output, readJson, repoRoot) {
  const script = output.match(/scriptPath:\s*"([^"]+)"/);
  const args = output.match(/(?:claimed \+ per-item worktrees|planned) -> (.+?\.json) \(\d+ bytes\)/);
  if (!script || !args) return null;
  const runArgsPath = resolve(repoRoot, args[1]);
  const batch = readJson(runArgsPath);
  if (!Number.isInteger(batch.cycle) || !Array.isArray(batch.items) || !batch.items.length) throw new Error('invalid launch envelope');
  const ids = batch.items.map((i) => i.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) throw new Error('invalid launch item identities');
  if (!Number.isSafeInteger(batch.buildCapacity) || batch.buildCapacity < 1) throw new Error('invalid launch buildCapacity');
  return { runScript: resolve(repoRoot, script[1]), runArgsPath, batch, ids };
}

export function claimIdentity(row) {
  return createHash('sha256').update(JSON.stringify({ worktree: row?.worktree, branch: row?.branch, claim: row?.history?.filter((h) => h.to === 'CLAIMED').at(-1) })).digest('hex');
}

export function validCheckpoint(result, item, cycle, { mtimeMs, sinceMs, claim, currentClaim }) {
  if (!result || !item || mtimeMs < sinceMs || claim !== currentClaim) return false;
  if (result.id !== item.id || result.resultId !== `${item.id}#${cycle}`) return false;
  if (result.cycle !== undefined && result.cycle !== cycle) return false;
  if (!['CLOSED', 'FAILED', 'BLOCKED', 'ESCALATED'].includes(result.toState)) return false;
  if (!Array.isArray(result.transitions) || result.transitions.at(-1) !== result.toState) return false;
  if (typeof result.worktree !== 'string' || !item.worktree?.path || resolve(result.worktree) !== resolve(item.worktree.path)) return false;
  if (item.worktree.branch && result.branch !== item.worktree.branch) return false;
  for (const key of ['claimId', 'attemptId']) if (item[key] !== undefined && result[key] !== item[key]) return false;
  return true;
}

export function observeChild(child, onEvent = () => {}, maxBytes = 8 * 1024 * 1024) {
  const state = { exited: false, closed: false, code: null, signal: null, error: null, sessionId: null, usage: null, modelUsage: null, totalCostUsd: null, outputTruncated: false };
  let pending = '', dropping = false;
  let wake;
  state.termination = new Promise((r) => { wake = r; });
  let closed;
  state.completion = new Promise((r) => { closed = r; });
  const parse = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    try {
      if (event.session_id) state.sessionId = event.session_id;
      if (event.type === 'result') {
        state.usage = event.usage ?? null;
        state.modelUsage = event.modelUsage ?? null;
        state.totalCostUsd = event.total_cost_usd ?? null;
        state.resultSubtype = event.subtype;
        state.isError = event.is_error === true;
      }
      onEvent(event);
    } catch (e) { state.error = 'metadata capture: ' + e.message; }
  };
  child.stdout?.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) {
      if (dropping) { dropping = false; continue; }
      if (Buffer.byteLength(line) > maxBytes) { state.outputTruncated = true; continue; }
      parse(line);
    }
    if (Buffer.byteLength(pending) > maxBytes) { state.outputTruncated = true; pending = ''; dropping = true; }
  });
  child.on('error', (e) => { state.error = e.message; state.exited = true; wake(); });
  child.on('exit', (code, signal) => { Object.assign(state, { exited: true, code, signal }); wake(); });
  child.on('close', () => { if (pending && !dropping) parse(pending); state.closed = true; wake(); closed(); });
  return state;
}

export async function stopChild(child, state, graceMs = 2000) {
  if (!child || state?.closed) return true;
  const wait = () => new Promise((r) => {
    const timer = setTimeout(() => r(false), graceMs);
    state.completion.then(() => { clearTimeout(timer); r(true); });
  });
  try { child.kill(); } catch { /* termination may have raced */ }
  if (await wait()) return true;
  try { child.kill('SIGKILL'); } catch { /* report unresolved termination below */ }
  return wait();
}

export async function watchLane({ poll, heartbeat, childState, intervalMs, timeoutMs, now = Date.now, sleep }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (!heartbeat()) return { complete: false, done: [], leaseLost: true };
    const { done, complete } = poll();
    if (childState?.error || (childState?.exited && (childState.code !== 0 || childState.signal))) return { complete, done, childFailed: true };
    if (complete && (!childState || childState.closed)) return { complete, done, childFailed: childState?.isError === true };
    if (childState?.closed) return { complete: false, done, childExited: true };
    if (now() >= deadline) return { complete: false, done, timedOut: true };
    const delay = Math.min(childState?.exited ? 100 : intervalMs, Math.max(0, deadline - now()));
    if (sleep) await sleep(delay);
    else await new Promise((r) => {
      const timer = setTimeout(r, delay);
      if (childState && !childState.exited) childState.termination.then(() => { clearTimeout(timer); r(); });
    });
  }
}

export function recoveryAdvice(ids, completed = []) {
  const pending = ids.filter((id) => !completed.includes(id));
  return { pending, inspect: ['resume'], nativeReuse: pending.length ? ['resume', '--reuse'] : null, instruction: 'Check original session/task liveness before reuse; fold only validated terminal checkpoints. Do not reset or re-claim live work.' };
}
