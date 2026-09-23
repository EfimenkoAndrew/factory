import { nativeRequestJson } from './native-evidence-request.mjs';
import { completeVerificationTranscript } from './stage-evidence.mjs';
import { createHash } from 'node:crypto';

export function nativeIntegrationReuseDecision({ enabled = false, previous, current, transcript, expected, worktree } = {}) {
  const miss = reason => ({ reuse: false, reason });
  if (enabled !== true) return miss('native integration reuse disabled');
  if (!previous || !current || previous.version !== 1 || current.version !== 1) return miss('missing versioned execution fingerprints');
  for (const key of ['codeHash', 'commandHash', 'environmentHash', 'sdkHash']) {
    if (!/^[0-9a-f]{64}$/.test(previous[key] || '') || previous[key] !== current[key]) return miss('missing or changed ' + key);
  }
  for (const key of ['itemId', 'runId', 'claimId', 'passId']) {
    if (typeof previous[key] !== 'string' || !previous[key] || previous[key] !== current[key]) return miss('missing or changed ' + key);
  }
  if (previous.band !== 'FULL' || current.band !== 'FULL') return miss('FULL proof required');
  if (!expected || !expected.build?.length || !expected.suite?.length || nativeRequestJson(previous.expected) !== nativeRequestJson(expected) || nativeRequestJson(current.expected) !== nativeRequestJson(expected)) return miss('missing or changed all-target contract');
  if (typeof transcript !== 'string' || createHash('sha256').update(transcript).digest('hex') !== previous.transcriptHash) return miss('transcript digest mismatch');
  const proof = completeVerificationTranscript(transcript, { worktree, required: ['build', 'suite'], expected });
  if (!proof.pass) return miss(proof.reason);
  return { reuse: true, reason: 'complete current FULL proof; independent integrator handoff and fold pair still required' };
}
