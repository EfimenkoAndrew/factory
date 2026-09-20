import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync, readlinkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { collectEvidenceIdentity, evidenceIdentity } from '../lib/evidence-identity.mjs';
export { EVIDENCE_IDENTITY_VERSION } from '../lib/evidence-identity.mjs';
export { writeJsonAtomic } from '../lib/ledger.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export function digest(value) { return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex'); }
export function newIdentity(prefix) { return prefix + '-' + randomUUID(); }

export function snapshotTree(worktree, contract, git, options = {}) {
  const { engineMount, briefs, ...collectorOptions } = options;
  const metadata = { reviewerContract: engineMount ? { contractHash: contract, briefs } : contract || 'unspecified', context: { runtime: 'opencode' }, ...(engineMount ? { engineMount } : {}) };
  if (!git) {
    const identity = collectEvidenceIdentity(worktree, metadata, collectorOptions);
    return { ...identity, base: identity.baseRevision, codeHash: digest({ code: identity.codeHash, contract }) };
  }
  if (engineMount) throw new Error('engineMount requires the shared recursive identity collector');
  const base = git(['rev-parse', 'HEAD']).trim();
  const names = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const entries = names.map(name => {
    try {
      const p = join(worktree, name), s = lstatSync(p);
      if (s.isDirectory()) throw new Error('identity cannot prove submodule/directory contents: ' + name);
      return { path: name, mode: s.isSymbolicLink() ? 'symlink' : s.mode & 0o111 ? 'executable' : 'file', content: s.isSymbolicLink() ? readlinkSync(p) : readFileSync(p) };
    } catch (e) { if (e.code === 'ENOENT') return { path: name, deleted: true }; throw e; }
  });
  const identity = evidenceIdentity({ ...metadata, baseRevision: base, entries });
  return { ...identity, base, codeHash: digest({ code: identity.codeHash, contract }) };
}

export function withItemLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  let acquired = false;
  for (let i = 0; i < 200; i++) {
    try { mkdirSync(path); acquired = true; break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
        try { process.kill(owner.pid, 0); }
        catch (dead) { if (dead.code === 'ESRCH') { rmSync(path, { recursive: true }); continue; } }
      } catch { /* A creator may not have written its owner yet. Never steal by age. */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (!acquired) throw new Error('item writer busy: ' + path);
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }));
  try { return fn(); } finally { rmSync(path, { recursive: true, force: true }); }
}

export function isWriter(role) { return role === 'test-author' || role === 'fixer' || role.startsWith('review-editorial-'); }

export function acceptSubmission(progress, call, value, dispatchId) {
  if (!dispatchId || dispatchId !== call.dispatchId) throw new Error('stale or missing dispatch ID');
  if (progress.phase !== progress.pendingSet?.phaseKey) throw new Error('submission phase mismatch');
  const hash = digest(value);
  progress.submissions ||= {};
  const prior = progress.submissions[dispatchId];
  if (prior) {
    if (prior !== hash) throw new Error('conflicting replay for dispatch ' + dispatchId);
    return false;
  }
  progress.submissions[dispatchId] = hash;
  progress.pendingSet.received[call.key] = value;
  return true;
}
