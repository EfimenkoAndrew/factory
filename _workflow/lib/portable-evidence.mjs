import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './evidence-identity.mjs';

export const PORTABLE_EVIDENCE_VERSION = 1;
export const portableHash = value => createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : canonicalJson(value)).digest('hex');

export function openCodeContract({ item, config, policies, routing, briefs, profiles }) {
  return { item, config, policies, routing, briefs, profiles };
}

export function openCodeMetadata(contractHash, { inputs = {}, engineMount = null, briefs = {} } = {}) {
  return { inputs, engineMount, reviewerContract: { contractHash, briefs }, context: { runtime: 'opencode' } };
}

export function exportPortableEvidence(progress, dir) {
  const proof = (name, evidence) => ({ transcript: name, rawHash: evidence?.rawHash, complete: evidence?.complete === true,
    identityHash: evidence?.hash });
  const auxiliary = {};
  for (const name of ['test.json', 'verify-red-raw.txt', 'baseline-raw.txt']) {
    auxiliary[name] = existsSync(join(dir, name)) ? portableHash(readFileSync(join(dir, name))) : null;
  }
  return { version: PORTABLE_EVIDENCE_VERSION, runtime: 'opencode', claimId: progress.claimId, runId: progress.runId,
    attemptNumber: progress.attemptNumber, contractHash: progress.contractHash, identity: progress.content,
    metadata: openCodeMetadata(progress.contractHash, { inputs: progress.config?.evidenceInputs,
      engineMount: progress.launch?.engineMount, briefs: progress.ctx.briefs }),
    verification: proof('verify-raw.txt', progress.evidence),
    integration: progress.integrationEvidence ? proof('integrate-raw.txt', progress.integrationEvidence) : null, auxiliary };
}
