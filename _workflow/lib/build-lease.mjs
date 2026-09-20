import { mkdirSync, readFileSync, readdirSync, unlinkSync, rmdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './ledger.mjs';

export function buildCapacity(root, requested) {
  const limits = requested === undefined ? [] : [capacity(requested)];
  for (const name of ['build-capacity.json', 'opencode-build-capacity.json']) {
    const path = join(root, 'state', name);
    if (existsSync(path)) limits.push(capacity(JSON.parse(readFileSync(path, 'utf8')).limit));
  }
  const read = name => {
    const path = join(root, 'config', name);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  };
  const base = read('factory.config.json'), local = read('factory.config.local.json');
  const configured = local.concurrency?.builds ?? local.buildConcurrency ?? base.concurrency?.builds ?? base.buildConcurrency;
  if (configured !== undefined) limits.push(capacity(configured));
  return limits.length ? Math.min(...limits) : 1;
}

function capacity(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid global build capacity');
  return limit;
}

export function withBuildSlot(root, fn, timeoutMs = 30 * 60 * 1000) {
  const dir = join(root, 'state', 'opencode-build-slots'); mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const admitted = tryAdmission(root, dir);
    if (admitted) {
      const { slot, owner } = admitted;
      let unsettled = false;
      try {
        const result = fn();
        if (result && typeof result.then === 'function') {
          unsettled = true;
          throw new Error('withBuildSlot requires a synchronous callback; lease retained for asynchronous execution');
        }
        return result;
      }
      catch (e) { unsettled ||= !!e.unsettled; throw e; }
      finally {
        if (unsettled) writeJsonAtomic(join(slot, 'owner.json'), { ...owner, status: 'uncertain', updatedAt: new Date().toISOString() });
        else rmSync(slot, { recursive: true, force: true });
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error('global build slot timeout');
}

function tryAdmission(root, dir) {
  const mutex = join(dir, 'admission.lock');
  const token = process.pid + '-' + randomUUID() + '.json';
  try { mkdirSync(mutex); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    recoverAdmissionMutex(mutex);
    return null;
  }
  const ownerPath = join(mutex, token);
  writeJsonAtomic(ownerPath, { pid: process.pid, status: 'admitting' });
  try {
    const limit = buildCapacity(root);
    const slots = readdirSync(dir).filter(name => /^\d+$/.test(name));
    let incomplete = false;
    for (const name of slots) {
      const slot = join(dir, name);
      let owner;
      try { owner = JSON.parse(readFileSync(join(slot, 'owner.json'), 'utf8')); }
      catch { incomplete = true; continue; }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) { incomplete = true; continue; }
      try { process.kill(owner.pid, 0); }
      catch (e) {
        if (e.code === 'ESRCH') throw new Error('orphaned build lease requires process-tree inspection: ' + slot);
        incomplete = true;
      }
    }
    if (incomplete || slots.length >= limit) return null;
    let index = 0;
    while (slots.includes(String(index))) index++;
    const slot = join(dir, String(index));
    mkdirSync(slot);
    const owner = { version: 1, pid: process.pid, leaseId: randomUUID(), status: 'active', startedAt: new Date().toISOString(), capacityAtAdmission: limit };
    writeJsonAtomic(join(slot, 'owner.json'), owner);
    return { slot, owner };
  } finally {
    unlinkSync(ownerPath);
    rmdirSync(mutex);
  }
}

function recoverAdmissionMutex(mutex) {
  let names;
  try { names = readdirSync(mutex); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (names.length !== 1 || !/^[1-9]\d*-[0-9a-f-]+\.json$/.test(names[0])) return;
  const path = join(mutex, names[0]);
  let owner;
  try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !names[0].startsWith(owner.pid + '-')) return;
  try { process.kill(owner.pid, 0); return; } catch (e) { if (e.code !== 'ESRCH') return; }
  try { unlinkSync(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  rmdirSync(mutex);
}

export function leasedCommand(root, command, args = [], options = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('build command required');
  if (options.shell) throw new Error('leasedCommand requires an executable and argv; invoke a shell explicitly if needed');
  return withBuildSlot(root, () => {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options, shell: false });
    if (result.error || result.signal || !Number.isInteger(result.status)) {
      const error = new Error('build command did not complete: ' + (result.error?.message || result.signal || 'unknown status'));
      error.unsettled = result.error?.code !== 'ENOENT' && result.error?.code !== 'EACCES';
      throw error;
    }
    return result;
  });
}
