import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { verificationExpectations } from './driver-integration.mjs';
import { decodeTranscript } from './verify.mjs';
import { completeVerificationTranscript } from './stage-evidence.mjs';
import { normalizeHostPath } from './repo-path.mjs';
import { captureBaseline } from './baseline.mjs';

export function nativeVerificationContract({ item, test, worktree, artifactDir, band }) {
  const targets = Array.isArray(item.verificationTargets) && item.verificationTargets.length ? item.verificationTargets : [item.solution].filter(Boolean);
  const derived = verificationExpectations({ item, test, worktree, targets, band, redText: decodeTranscript(readFileSync(join(artifactDir, 'verify-red-raw.txt'))) });
  const expected = item.verificationExpected || derived;
  // Validate supplied command-specific fields without accepting a vacuous or unconstrained filter.
  const validation = completeVerificationTranscript('', { band, expected, worktree });
  if (!/missing required (?:build\/filter\/suite )?invocation/.test(validation.reason)) throw new Error(validation.reason);
  // Explicit launch expectations may widen but never drop a derived affected target/filter.
  const norm = value => normalizeHostPath(value, { base: worktree });
  for (const sub of ['build', 'filter', 'suite']) {
    for (const entry of derived[sub]) {
      const found = (expected[sub] || []).some(v => norm(typeof v === 'string' ? v : v.target) === norm(typeof entry === 'string' ? entry : entry.target) && (sub !== 'filter' || v.filter === entry.filter));
      if (!found) throw new Error('supplied verificationExpected drops derived ' + sub + ' target/filter');
    }
  }
  let baselineText = null;
  try {
    const path = join(artifactDir, 'baseline-raw.txt');
    if (!item.reFix || (Number.isFinite(Date.parse(item.claimAt)) && statSync(path).mtimeMs < Date.parse(item.claimAt))) baselineText = decodeTranscript(readFileSync(path));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const baseline = captureBaseline(baselineText, { worktree });
  return { expected, integrationExpected: { build: targets, filter: [], suite: targets }, baseline };
}
