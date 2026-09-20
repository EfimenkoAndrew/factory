import { makeObservation, observationEvent } from '../lib/observations.mjs';
import { emit } from '../lib/telemetry.mjs';

const iso = n => Number.isFinite(n) ? new Date(n).toISOString() : null;
const count = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

export function dispatchObservation(state, descriptor) {
  const usage = state.outcome?.usage;
  return makeObservation({ kind: 'dispatch', id: 'opencode:' + state.dispatchId, runId: state.runId,
    itemId: state.itemId, attemptId: state.attemptId, dispatchId: state.dispatchId,
    stage: descriptor.stage || descriptor.phase || null, role: descriptor.role,
    runtimeVersion: typeof state.runtimeVersion === 'string' ? state.runtimeVersion : state.runtimeVersion?.version || null,
    sessionId: state.sessionId || null, requestedModel: state.requestedModel.providerID + '/' + state.requestedModel.modelID,
    actualModel: state.outcome?.actualModel || null, effort: descriptor.route?.effort || null,
    retry: descriptor.retry ?? 0, fallback: false, promptHash: state.promptHash, evidenceHash: state.inputHash,
    startedAt: iso(state.startedAt), completedAt: iso(state.completedAt), outcome: state.status,
    inputTokens: count(usage?.input), outputTokens: count(usage?.output),
    cacheReadTokens: count(usage?.cache?.read), cacheWriteTokens: count(usage?.cache?.write),
    measuredCost: count(state.outcome?.cost), currency: count(state.outcome?.cost) === null ? null : 'USD',
    costSource: count(state.outcome?.cost) === null ? null : 'opencode-session-messages',
    attributionConfidence: usage || count(state.outcome?.cost) !== null ? 'direct' : 'unknown',
    cacheSource: usage?.cache ? 'opencode-session-messages' : null, cacheScope: usage?.cache ? 'dispatch' : null,
    queueMs: count(state.startedAt - (descriptor.queuedAt || state.startedAt)),
    executionMs: count(state.completedAt - state.startedAt),
  });
}

export function emitObservation(row) {
  try { emit(observationEvent(row)); }
  catch (e) { process.stderr.write('[opencode observations] ' + e.message + '\n'); }
}

// Compatibility formatter for historical producer arrays/tests. Runtime does not call or emit it:
// admission and final lifecycle verdicts belong exclusively to the driver.
export function itemAttemptObservation(progress, phase) {
  return makeObservation({ kind: 'item-attempt', id: 'opencode:' + progress.attemptId + ':' + phase,
    runId: progress.runId, itemId: progress.id, attemptId: progress.attemptId,
    attemptNumber: progress.attemptNumber ?? null, phase, band: progress.band,
    outcome: phase === 'completed' ? progress.res.toState : null,
    startedAt: iso(progress.startedAt), completedAt: phase === 'completed' ? iso(progress.completedAt) : null,
    recovery: !!progress.reFix,
  });
}
