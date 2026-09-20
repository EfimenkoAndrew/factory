import { readFileSync } from 'node:fs';
import { execSmoke, smokeBatch, defaultAgentStub } from '../lib/_execsmoke.mjs';

export async function nativeObservationFixture(kind, options = {}) {
  const source = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const batch = smokeBatch();
  const doc = kind === 'light-doc';
  const item = { ...batch.items[doc ? 0 : 1] };
  if (kind !== 'full-code') Object.assign(item, { fixType: 'mechanical', band: 'LIGHT', severity: 'MEDIUM', theme: doc ? 'doc-drift' : 'deployability-oncall' });
  batch.items = [item];
  batch.policies = {};
  batch.runId = 'observation-fixture-' + kind;
  if (options.identity) Object.assign(item, { runId: options.identity.runId, claimId: options.identity.claimId, attemptNumber: options.identity.attemptNumber });
  if (options.identity) batch.runId = options.identity.runId;
  batch.attempts = options.retries ? 3 : 1;
  const checkpoints = [];
  let testCalls = 0;
  const execution = await execSmoke(source, batch, { agentOverride: (prompt, opts) => {
    if (opts.schema?.properties.written && prompt.includes('CHECKPOINT-BEGIN\n')) {
      checkpoints.push(JSON.parse(prompt.split('CHECKPOINT-BEGIN\n')[1].split('\nCHECKPOINT-END')[0]));
    }
    if (opts.label.endsWith(':test-author')) {
      if (options.retries && testCalls++ < 2) return null;
      if (doc) return { ...defaultAgentStub(opts), testFiles: ['doc/check.sh'], runCmd: 'grep' };
    }
    if (doc && opts.label.endsWith(':fixer')) return { ...defaultAgentStub(opts), filesChanged: item.files };
  } });
  return { ...execution, item, checkpoints };
}
