import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateObservation } from '../lib/observations.mjs';

export function attachDispatchEvidence(progress, dir) {
  const dispatchDir = join(dir, 'dispatch');
  if (!existsSync(dispatchDir)) return;
  const observations = new Map((progress.res.attemptObservations || []).map(o => [o.id, o]));
  const admissions = [];
  for (const name of readdirSync(dispatchDir).filter(n => n.endsWith('-session.json'))) {
    const state = JSON.parse(readFileSync(join(dispatchDir, name), 'utf8'));
    if (state.runId !== progress.runId || state.attemptId !== progress.attemptId || state.itemId !== progress.id) continue;
    const a = state.admission;
    if (state.invoked === true && a?.version === 1 && a.attempted === true && a.runId === progress.runId
      && a.claimId === progress.claimId && a.itemId === progress.id && a.dispatchId === state.dispatchId
      && a.sessionId === state.sessionId && a.messageId === state.messageId && Number.isFinite(Date.parse(a.startedAt))) admissions.push(a);
    const o = state.observation;
    if (o && !validateObservation(o).length && o.kind === 'dispatch' && o.runId === progress.runId
      && o.attemptId === progress.attemptId && o.itemId === progress.id && o.dispatchId === state.dispatchId) observations.set(o.id, o);
  }
  if (admissions.length) {
    admissions.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.dispatchId.localeCompare(b.dispatchId));
    progress.res.admission = admissions[0];
  }
  if (observations.size) progress.res.attemptObservations = [...observations.values()].sort((a, b) => a.id.localeCompare(b.id));
}
