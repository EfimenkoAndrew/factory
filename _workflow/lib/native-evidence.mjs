import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { collectEvidenceIdentity } from './evidence-identity.mjs';
import { parseRedRaw, decodeTranscript, nonTestChanged } from './verify.mjs';
import { changedFiles } from './worktree.mjs';
import { completeVerificationTranscript } from './stage-evidence.mjs';
import { assertArtifactTree, writeArtifactAtomic } from './native-artifact-guard.mjs';
import { createHash } from 'node:crypto';
import { nativeRequestJson } from './native-evidence-request.mjs';

export function hydrateNativeEvidenceMetadata(input, options = {}) {
  if (!Object.hasOwn(input, 'relayBriefs')) return input;
  const { relayBriefs, ...metadata } = input;
  if (!relayBriefs || relayBriefs.directory !== metadata.reviewerContract?.briefsDirectory ||
      !/^[0-9a-f]{64}$/.test(relayBriefs.digest || '') ||
      Object.keys(metadata.reviewerContract.briefs || {}).length) throw new Error('invalid native briefs relay reference');
  const { trustedBriefsDirectory, io = {} } = options;
  if (typeof trustedBriefsDirectory !== 'string' || !isAbsolute(trustedBriefsDirectory)) throw new Error('trustedBriefsDirectory required for native briefs relay');
  const ls = io.lstatSync || lstatSync;
  const rp = io.realpathSync || realpathSync;
  const rd = io.readdirSync || readdirSync;
  const rf = io.readFileSync || readFileSync;
  const expected = resolve(trustedBriefsDirectory);
  if (typeof relayBriefs.directory !== 'string' || !isAbsolute(relayBriefs.directory) ||
      relative(expected, resolve(relayBriefs.directory)) !== '') throw new Error('native briefs relay directory mismatch');
  const directoryStat = ls(expected);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('invalid native briefs directory');
  const directory = rp(expected);
  if (relative(directory, rp(relayBriefs.directory)) !== '') throw new Error('native briefs relay directory mismatch');
  const files = rd(directory).filter(name => /\.md$/i.test(name)).map(name => {
    if (/[\\/]/.test(name) || relative(directory, dirname(resolve(directory, name))) !== '') throw new Error('invalid native brief path');
    const file = join(directory, name);
    const stat = ls(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('invalid native brief file (regular non-symlink required)');
    if (relative(directory, dirname(rp(file))) !== '') throw new Error('native brief path outside trusted directory');
    return { name, file };
  });
  const briefs = Object.fromEntries(files.map(({ name, file }) => [name.replace(/\.md$/i, ''), String(rf(file, 'utf8'))]));
  if (createHash('sha256').update(nativeRequestJson(briefs)).digest('hex') !== relayBriefs.digest) throw new Error('native briefs relay digest mismatch');
  return { ...metadata, reviewerContract: { ...metadata.reviewerContract, briefs } };
}

export function validateNativeMetadata(metadata) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const present = (v, keys) => object(v) && keys.every(k => Object.prototype.hasOwnProperty.call(v, k));
  if (!present(metadata, ['requestVersion', 'requestIdentity', 'acceptance', 'policies', 'profile', 'reviewerContract', 'context', 'inputs', 'engineMount', 'verificationTranscript', 'integrationTranscript']) || metadata.requestVersion !== 1) throw new Error('incomplete native evidence metadata (requestVersion 1 required)');
  const r = metadata.requestIdentity;
  if (!present(r, ['itemId', 'runId', 'claimId', 'attemptNumber', 'boundary', 'passId', 'codeChange', 'integrationRequired']) ||
      !['itemId', 'runId', 'boundary', 'passId'].every(k => typeof r[k] === 'string' && r[k].length > 0) ||
      !(r.claimId === null || typeof r.claimId === 'string') || !(r.attemptNumber === null || Number.isInteger(r.attemptNumber)) ||
      typeof r.codeChange !== 'boolean' || typeof r.integrationRequired !== 'boolean') throw new Error('incomplete native request identity');
  if (typeof metadata.verificationTranscript !== 'string' || !metadata.verificationTranscript.trim()) throw new Error('native verificationTranscript required; legacy verify-raw fallback forbidden');
  if (r.integrationRequired ? typeof metadata.integrationTranscript !== 'string' || !metadata.integrationTranscript.trim() : metadata.integrationTranscript !== null) throw new Error('invalid native integrationTranscript');
  if (!present(metadata.reviewerContract, ['version', 'briefs', 'briefsDirectory', 'routes', 'band', 'gates', 'portfolio']) ||
      !present(metadata.context, ['title', 'files', 'regressionTest', 'planner', 'infraClassification', 'verificationOnly', 'baselineFailures', 'acceptedPlanDeviation', 'verificationContract', 'verificationTargets']) ||
      (r.codeChange ? !present(metadata.context.verificationContract, ['expected', 'integrationExpected']) : metadata.context.verificationContract !== null) ||
      !object(metadata.policies) || !object(metadata.inputs) || !object(metadata.reviewerContract.briefs) || !object(metadata.reviewerContract.routes) ||
      typeof metadata.acceptance !== 'string' || typeof metadata.profile !== 'string') throw new Error('incomplete native review/verification contract');
}

export function persistNativeAdmission(artifactDir, snapshot) {
  if (snapshot?.toState !== 'IN_PROGRESS' || snapshot.progressStage !== 'admission' ||
      !snapshot.id || !snapshot.runId || snapshot.admission?.itemId !== snapshot.id ||
      snapshot.admission.runId !== snapshot.runId || snapshot.admission.claimId !== snapshot.claimId ||
      snapshot.admission.attempted !== true ||
      !snapshot.attemptObservations?.some(o => o.itemId === snapshot.id && o.runId === snapshot.runId && o.stage === snapshot.id + ':progress:admission' && o.outcome === 'started')) {
    throw new Error('invalid native admission snapshot');
  }
  return writeArtifactAtomic(artifactDir, 'progress.json', JSON.stringify(snapshot));
}

export function collectNativeEvidence(worktree, metadata, artifactDir, options = {}) {
  if (!options.legacy) assertArtifactTree(artifactDir);
  if (!options.legacy) validateNativeMetadata(metadata);
  const request = { version: 1, digest: createHash('sha256').update(nativeRequestJson({ worktree, metadata, artifactDir })).digest('hex'), worktree, artifactDir,
    verificationTranscript: metadata.verificationTranscript ?? null, integrationTranscript: metadata.integrationTranscript ?? null };
  if (options.expectedDigest && request.digest !== options.expectedDigest) throw new Error('native evidence request digest mismatch');
  const { verificationTranscript, integrationTranscript, ...identityMetadata } = metadata;
  const identity = collectEvidenceIdentity(worktree, identityMetadata);
  let verification = { pass: false, reason: 'verification transcript unavailable' };
  try {
    const raw = decodeTranscript(readFileSync(verificationTranscript || join(artifactDir, 'verify-raw.txt')));
    verification = !options.legacy && metadata.requestIdentity.codeChange === false
      ? { pass: !!raw.trim(), reason: raw.trim() ? 'non-code transcript present; acceptance remains runner/reviewer authority' : 'empty non-code verification transcript' }
      : completeVerificationTranscript(raw, { band: metadata.reviewerContract?.band, baseline: metadata.context?.verificationContract?.baseline, worktree, expected: metadata.context?.verificationContract?.expected });
  } catch (e) { verification.reason = e.message; }
  let integration = null;
  if (integrationTranscript) {
    try {
      const raw = decodeTranscript(readFileSync(integrationTranscript));
      integration = completeVerificationTranscript(raw, { baseline: metadata.context?.verificationContract?.baseline, worktree, required: ['build', 'suite'], expected: metadata.context?.verificationContract?.integrationExpected });
    } catch (e) { integration = { pass: false, reason: e.message }; }
  }
  let red = { hasData: false, exit: null };
  try { red = parseRedRaw(decodeTranscript(readFileSync(join(artifactDir, 'verify-red-raw.txt')))); } catch {}
  let rootCause = { nonTestCount: 0, files: [], skipped: true };
  try {
    const changed = changedFiles(worktree);
    if (Array.isArray(changed)) {
      const files = nonTestChanged(changed);
      rootCause = { nonTestCount: files.length, files: files.slice(0, 25), skipped: false };
    }
  } catch {}
  let shadowSnapshotHash = null;
  try {
    const shadowInputs = ['review-pack.md', 'feedback.md'].map(file => {
      try { return readFileSync(join(artifactDir, file), 'utf8'); }
      catch (e) { if (e.code === 'ENOENT' && file === 'feedback.md') return null; throw e; }
    });
    shadowSnapshotHash = createHash('sha256').update(JSON.stringify([identity.hash, ...shadowInputs])).digest('hex');
  } catch {}
  const result = { ...identity, request, shadowSnapshotHash, verification, integration, redProof: { markerFound: red.hasData, exitCode: red.exit ?? 0 }, rootCause };
  if (!options.legacy) writeArtifactAtomic(artifactDir, 'native-evidence-' + request.digest + '.json', JSON.stringify({ metadata, result }, null, 2));
  return result;
}
