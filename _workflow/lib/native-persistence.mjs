import { createHash } from 'node:crypto';
import { nativeRequestJson } from './native-evidence-request.mjs';
import { readArtifactInput, writeArtifactAtomic, assertArtifactTree } from './native-artifact-guard.mjs';
import { resolve, relative, isAbsolute } from 'node:path';
import { nativeCheckpointRequest } from './native-checkpoint.mjs';

export function persistNativeCheckpoint(artifactDir, input, digest) {
  if (!/^[0-9a-f]{64}$/.test(digest || '')) throw new Error('invalid checkpoint digest');
  assertArtifactTree(artifactDir);
  const snapshot = JSON.parse(readArtifactInput(artifactDir, input, 'checkpoint-input-' + digest + '.json'));
  const request = nativeCheckpointRequest(artifactDir, snapshot?.toState === 'IN_PROGRESS' ? 'progress.json' : 'result.json', snapshot || {});
  if (createHash('sha256').update(nativeRequestJson(request)).digest('hex') !== digest) throw new Error('checkpoint digest mismatch');
  const { version, output, payload, itemId, runId, claimId, attemptNumber } = request;
  if (version !== 1 || !['progress.json', 'result.json'].includes(output) || !isAbsolute(request.artifactDir || '') || relative(resolve(artifactDir), resolve(request.artifactDir)) !== '') throw new Error('invalid checkpoint destination');
  if (!payload || typeof itemId !== 'string' || !itemId || typeof runId !== 'string' || !runId ||
      !(claimId === null || typeof claimId === 'string') || !(attemptNumber === null || Number.isInteger(attemptNumber) && attemptNumber >= 0) ||
      payload.id !== itemId || payload.runId !== runId || payload.claimId !== claimId || payload.attemptNumber !== attemptNumber || payload.budgetStopped) throw new Error('checkpoint identity mismatch');
  if (output === 'progress.json' ? payload.toState !== 'IN_PROGRESS' || !['admission', 'post-plan', 'post-test', 'post-verify', 'post-preband', 'post-gates', 'post-reaudit', 'sweep-apply-started', 'sweep-post-apply'].includes(payload.progressStage) : !['CLOSED', 'FAILED', 'BLOCKED', 'ESCALATED'].includes(payload.toState)) throw new Error('invalid checkpoint state');
  if (payload.progressStage === 'admission' && (payload.admission?.itemId !== itemId || payload.admission.runId !== runId || payload.admission.claimId !== claimId || payload.admission.attempted !== true || !payload.attemptObservations?.some(o => o.itemId === itemId && o.runId === runId && o.stage === itemId + ':progress:admission' && o.outcome === 'started'))) throw new Error('invalid native admission snapshot');
  return writeArtifactAtomic(artifactDir, output, JSON.stringify(payload));
}
