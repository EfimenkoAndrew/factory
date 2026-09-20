import { randomUUID, createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { computeReady } from './graph.mjs';
import { unreadyItems } from './readiness.mjs';
import { filesOverlapDirty } from './mainguard.mjs';
import { completeCommand } from './stage-evidence.mjs';
import { decodeTranscript } from './verify.mjs';
import { collectEvidenceIdentity, canonicalJson, EVIDENCE_IDENTITY_VERSION } from './evidence-identity.mjs';
import { needsRealInfra } from '../opencode/routing.mjs';
import { observationEvent, normalizeAttemptObservations } from './observations.mjs';
import { normalizeHostPath } from './repo-path.mjs';
import { nativeEvidenceRequest } from './native-evidence-request.mjs';
import { validateNativeMetadata } from './native-evidence.mjs';

const hostPath = (value, base) => normalizeHostPath(value, { base });
const samePath = (a, b) => hostPath(a) === hostPath(b);

export function resolvedBuildCapacity(cfg = {}, flags = {}) {
  const raw = flags['build-capacity'] ?? flags.buildCapacity ?? cfg.concurrency?.builds ?? cfg.buildConcurrency ?? cfg.buildCapacity ?? 1;
  const limit = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid global build capacity');
  return limit;
}

export function eligibleItems(graph, ledger, cfg, flags = {}, { docker = false, dirty = { paths: [], dirs: [] }, repoRoot } = {}) {
  const ready = computeReady(graph, ledger, { maxItemRetries: cfg.maxItemRetries, target: flags.target || null,
    themes: flags.themes ? String(flags.themes).split(',') : null, includeEscalate: !!flags['include-escalate'], repoRoot });
  return ready.filter(w => (!flags.layer || w.layer === flags.layer)
    && !(w.ownerDecision != null && w.ownerDecisionResolved !== true) && w.fixType !== 'owner-decision'
    && (!needsRealInfra(w, (w.files || []).some(f => /\.cs$/i.test(f))) || (flags['include-realinfra'] && (docker || flags['force-realinfra'])))
    && (flags['force-unready'] || !unreadyItems([w]).length)
    && (flags['force-dirty-overlap'] || !filesOverlapDirty(w.files, dirty, { repoRoot }).length));
}

export function disjointItems(items, max = Infinity, options = {}) {
  const seen = [], out = [];
  for (const item of items) {
    if (out.length >= max) break;
    if (filesOverlapDirty(item.files, { paths: seen, dirs: [] }, options).length) continue;
    out.push(item); seen.push(...(item.files || []));
  }
  return out;
}

export function admitAttempt(row, runId, { cycle, recovery = false, band = null, mode = 'run' } = {}) {
  const attemptNumber = (row.observedAttemptNumber || 0) + 1;
  const identity = { runId, claimId: randomUUID(), attemptNumber, cycle, recovery, band, mode, reservedAt: new Date().toISOString(), startedAt: null, admitted: false };
  row.runId = runId; row.claimId = identity.claimId; row.attemptNumber = attemptNumber;
  row.attemptIdentity = identity;
  (row.attemptIdentities ||= {})[identity.claimId] = identity;
  return identity;
}

export function lifecycleObservation(identity, id, phase, outcome = null, late = false) {
  return { kind: 'item-attempt', id: 'driver:' + identity.claimId + ':' + phase, runId: identity.runId,
    itemId: id, attemptId: identity.claimId, attemptNumber: identity.attemptNumber, phase,
    band: identity.band, recovery: identity.recovery, startedAt: identity.startedAt,
    completedAt: phase === 'completed' ? identity.completedAt : null, outcome,
    lateDeterministicFailure: phase === 'completed' ? late : null };
}

export function observeAdmission(result, row, emit, warn = console.warn) {
  try {
    const identity = row?.attemptIdentity;
    if (!identity || result.budgetStopped || !matchesClaim(result, row) || (result.runId && result.runId !== identity.runId)) return false;
    const signal = result.admission;
    if (signal && ((signal.runId && signal.runId !== identity.runId) || (signal.claimId && signal.claimId !== identity.claimId))) return false;
    const physical = (Array.isArray(result.attemptObservations) ? result.attemptObservations : []).some(o => o && o.itemId === result.id && o.runId === identity.runId
      && o.notInvoked !== true && o.overhead !== true && o.bucket !== 'shared-overhead' && o.phase !== 'Checkpoint'
      && o.stage !== 'checkpoint' && o.kind !== 'item-attempt'
      && !(o.kind === 'dispatch' && String(o.id).startsWith('opencode:') && o.outcome === 'failed'
        && (!o.sessionId || (o.actualModel == null && o.inputTokens == null && o.outputTokens == null && !(o.providerRequests > 0)))));
    const admitted = signal?.attempted === true || signal?.admitted === true || result.admitted === true || physical;
    if (!admitted) return false;
    if (!identity.admitted) {
      identity.admitted = true;
      identity.startedAt = signal?.startedAt || null;
      row.observedAttemptNumber = Math.max(row.observedAttemptNumber || 0, identity.attemptNumber);
    }
    observe(lifecycleObservation(identity, result.id, 'started'), emit, warn);
    return true;
  } catch (e) { warn('admission observation skipped: ' + e.message); return false; }
}

export function matchesClaim(result, row) {
  if (!row?.claimId) return true;
  if (result.driverClaimId && result.driverClaimId !== row.claimId) return false;
  if (!result.claimId || result.claimId === row.claimId) return true;
  const claim = (row.history || []).filter(h => h.to === 'CLAIMED').at(-1);
  const legacyPortId = createHash('sha256').update(canonicalJson({ id: result.id, at: claim?.at,
    worktreePath: row.worktree?.replace(/\\/g, '/'), cycle: row.attemptIdentity?.cycle })).digest('hex');
  return result.claimId === legacyPortId;
}

export function observe(row, emit, warn = console.warn) {
  try { emit(observationEvent(row)); } catch (e) { warn('observation skipped: ' + e.message); }
}

export function observePhysical(payload, rows, emit, warn = console.warn) {
  const records = [...(Array.isArray(payload.attemptObservations) ? payload.attemptObservations : []),
    ...(Array.isArray(payload.results) ? payload.results : []).flatMap(r => Array.isArray(r?.attemptObservations) ? r.attemptObservations : [])];
  try {
    const identityFor = raw => Object.values(rows[raw.itemId]?.attemptIdentities || {}).find(i => i.runId === raw.runId);
    const inputs = records.filter(raw => raw?.kind !== 'item-attempt').map(raw =>
      !raw?.kind && !identityFor(raw) ? { ...raw, overhead: true, itemId: null } : raw);
    const normalized = normalizeAttemptObservations(inputs, raw => ({ itemId: identityFor(raw) ? raw.itemId : null,
      itemAttemptId: identityFor(raw)?.claimId || null }));
    for (const bad of normalized.invalid) warn('physical observation skipped: ' + JSON.stringify(bad));
    const seen = new Set();
    for (const record of normalized.records) {
      const key = JSON.stringify(record);
      if (!seen.has(key)) observe(record, emit, warn);
      seen.add(key);
    }
  } catch (e) { warn('physical observations skipped: ' + e.message); }
}

export function originalInfraRequirement(item) {
  return !!item && needsRealInfra(item, (item.files || []).some(f => /\.cs$/i.test(f)));
}

export function affectedVerificationTargets(item, cfg, repoRoot, primary) {
  const files = (item.files || []).filter(f => !/\.(md|rst|txt)$/i.test(f));
  if (!files.length) return [];
  const mappings = Object.entries(cfg.solutions || {}).map(([owner, value]) => ({ owner: owner.replace(/\\/g, '/').replace(/\/$/, ''),
    targets: Array.isArray(value) ? value : [typeof value === 'string' ? value : value?.solution] }));
  const targets = new Set();
  for (const file of files) {
    const path = file.replace(/\\/g, '/');
    const matches = mappings.filter(m => path === m.owner || path.startsWith(m.owner + '/')).sort((a, b) => b.owner.length - a.owner.length);
    if (matches.length) {
      const chosen = matches.filter(m => m.owner.length === matches[0].owner.length);
      if (chosen.length !== 1 || !chosen[0].targets.length || chosen[0].targets.some(t => typeof t !== 'string' || !t.trim())) throw new Error('ambiguous solution mapping for ' + file);
      for (const target of chosen[0].targets) { containedFile(repoRoot, resolve(repoRoot, target)); targets.add(target); }
      continue;
    }
    let dir = dirname(resolve(repoRoot, file)), found = null, projectFallback = null, projectAmbiguous = false;
    while (dir === resolve(repoRoot) || (!relative(resolve(repoRoot), dir).startsWith('..') && !isAbsolute(relative(resolve(repoRoot), dir)))) {
      const entries = existsSync(dir) ? readdirSync(dir) : [];
      const solutions = entries.filter(n => /\.slnx?$/i.test(n));
      const projects = entries.filter(n => /\.(cs|fs|vb)proj$/i.test(n));
      const knownSolution = primary && solutions.find(name => samePath(resolve(dir, name), hostPath(primary, repoRoot)));
      if (solutions.length > 1 && !knownSolution) throw new Error('ambiguous owning build target for ' + file);
      if (solutions.length) {
        found = relative(repoRoot, containedFile(repoRoot, resolve(dir, knownSolution || solutions[0]))).replace(/\\/g, '/');
        break;
      }
      if (!projectFallback && !projectAmbiguous && projects.length) {
        projectAmbiguous = projects.length > 1;
        if (!projectAmbiguous) projectFallback = relative(repoRoot, containedFile(repoRoot, resolve(dir, projects[0]))).replace(/\\/g, '/');
      }
      if (dir === resolve(repoRoot)) break;
      dir = dirname(dir);
    }
    if (!found && primary && (!path.includes('/') || path.startsWith(String(item.target).replace(/\\/g, '/') + '/'))) {
      containedFile(repoRoot, resolve(repoRoot, primary)); found = primary;
    }
    if (!found && projectAmbiguous) throw new Error('ambiguous owning build target for ' + file);
    if (!found) found = projectFallback;
    if (!found) throw new Error('no unambiguous build ownership for ' + file + '; configure solutions');
    targets.add(found);
  }
  return [...targets].sort();
}

export function invokedOpenCodeDispatch(state) {
  if (state?.invoked === false || state?.notInvoked === true || !state?.sessionId) return false;
  if (['admitted', 'completed'].includes(state.status) || state.admittedAt || state.invoked === true) return true;
  const o = state.observation;
  return state.status === 'failed' && o?.kind === 'dispatch' && o.sessionId === state.sessionId
    && (state.outcome != null || o.actualModel != null || o.inputTokens != null || o.outputTokens != null || o.providerRequests > 0);
}

export function worktreeGcGroups(rows, repoRoot) {
  const groups = new Map();
  for (const [id, row] of Object.entries(rows)) {
    if (!row.worktree) continue;
    const path = hostPath(row.worktree, repoRoot);
    const canonical = existsSync(path) ? realpathSync(path) : path;
    const key = hostPath(canonical);
    if (!groups.has(key)) groups.set(key, { path, rows: [] });
    groups.get(key).rows.push({ id, row });
  }
  return [...groups.values()].map(group => ({ ...group, safe: group.rows.every(({ row }) => row.state === 'CLOSED') }));
}

export function normalizedInfraResult(result) {
  if (result.infraClassification || !result.realInfraClassification) return result;
  const c = result.realInfraClassification, a = c.adjudication;
  const key = 'adjudicator:realinfra-override';
  return { ...result, infraClassification: { version: 1, original: c.original, effective: c.effective,
    adjudication: a && { ...a, reason: c.reason } }, gateDetails: { ...result.gateDetails, [key]: result.gateDetails?.[key] || a } };
}

export function containedFile(root, path) {
  const base = hostPath(root), candidate = hostPath(path, base);
  const inside = (a, b) => { const r = relative(a, b); return r !== '' && !r.startsWith('..') && !isAbsolute(r); };
  if (!inside(base, candidate) || !inside(realpathSync(base), realpathSync(candidate)) || !statSync(candidate).isFile()) throw new Error('file missing or outside trusted directory: ' + path);
  return candidate;
}

export function verifyTranscript(text, { worktree, targets = [], expected, required = ['build', 'filter', 'suite'], baseline = 0 } = {}) {
  const contract = expected || { build: targets, suite: required.includes('suite') ? targets : [], filter: targets.map(target => ({ target, filter: null })) };
  const normalize = (sub, value) => ({ sub, target: hostPath(typeof value === 'string' ? value : value.target, worktree),
    filter: sub === 'filter' ? value.filter ?? null : null });
  const invocations = Object.entries(contract).flatMap(([sub, values]) => (values || []).map(v => normalize(sub, v)));
  if (required.some(sub => !invocations.some(v => v.sub === sub))) return { pass: false, reason: 'missing trusted expected invocations' };
  const starts = [...String(text).matchAll(/^FACTORY::(BUILD|TEST::FILTER|TEST::SUITE)::START (.+)\r?$/gm)];
  const seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i], sub = m[1] === 'BUILD' ? 'build' : m[1] === 'TEST::FILTER' ? 'filter' : 'suite';
    const [target, ...filters] = m[2].trim().split(' :: ');
    if (sub === 'filter' && !filters.join(' :: ').trim()) return { pass: false, reason: 'empty regression filter' };
    let path;
    try { path = containedFile(worktree, target); } catch (e) { return { pass: false, reason: e.message }; }
    const match = invocations.findIndex(v => v.sub === sub && samePath(v.target, path) && (sub !== 'filter' || v.filter === null || v.filter === filters.join(' :: ')));
    if (match < 0) return { pass: false, reason: 'unexpected ' + sub + ' target/filter: ' + target + ' :: ' + filters.join(' :: ') };
    const body = text.slice(m.index, starts[i + 1]?.index ?? text.length);
    const summary = new RegExp('^FACTORY::SUMMARY::' + sub + ' exit=(-?\\d+)', 'm').exec(body);
    const verdict = completeCommand({ code: summary ? Number(summary[1]) : -1, output: body }, sub, target, filters.join(' :: '), baseline, { worktree });
    if (!verdict.pass) return verdict;
    seen.add(match);
  }
  return invocations.length && invocations.every((v, i) => seen.has(i))
    ? { pass: true } : { pass: false, reason: 'missing required build/filter/suite invocations for expected targets' };
}

export function verificationExpectations({ item = {}, test = {}, worktree, targets = [], band, redText = '' }) {
  const projectFor = file => {
    let dir = dirname(containedFile(worktree, file));
    while (dir === resolve(worktree) || relative(resolve(worktree), dir).split(/[\\/]/)[0] !== '..') {
      const projects = readdirSync(dir).filter(n => /\.csproj$/i.test(n));
      if (projects.length === 1) return containedFile(worktree, resolve(dir, projects[0]));
      if (projects.length > 1) throw new Error('ambiguous owning project for ' + file);
      if (dir === resolve(worktree)) break;
      dir = dirname(dir);
    }
    throw new Error('no owning project for ' + file);
  };
  const testProjects = [...new Set((test.testFiles || []).filter(f => /\.cs$/i.test(f)).map(projectFor))];
  const red = [...redText.matchAll(/^FACTORY::(?:TEST::FILTER|RED)::START (.+) :: (.+)\r?$/gm)].map(m => ({ target: containedFile(worktree, m[1].trim()), filter: m[2].trim() }));
  if (!red.length) throw new Error('no RED filter provenance');
  const tokens = String(test.runCmd || '').match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(t => t.replace(/^(["'])(.*)\1$/, '$2')) || [];
  let command = null;
  const bt = tokens.findIndex(t => /(?:^|[\\/])build-test(?:\.local)?\.sh$/.test(t));
  const dotnet = tokens.indexOf('dotnet');
  if (bt >= 0 && ['filter', 'red'].includes(tokens[bt + 1])) command = { target: tokens[bt + 2], filter: tokens[bt + 3] };
  else if (dotnet >= 0 && tokens[dotnet + 1] === 'test') {
    const flag = tokens.indexOf('--filter');
    command = { target: tokens[dotnet + 2], filter: flag >= 0 ? tokens[flag + 1] : null };
  }
  if (command) {
    command.target = containedFile(worktree, command.target || '');
    if (!command.filter || !red.some(r => samePath(r.target, command.target) && r.filter === command.filter)) throw new Error('test.json command disagrees with RED target/filter');
  }
  if (!testProjects.length && !command) throw new Error('test.json lacks independently resolvable project provenance');
  if (testProjects.length && red.some(r => !testProjects.some(p => samePath(p, r.target)))) throw new Error('RED filter target is not a test-file owning project');
  const filters = red.filter((r, i) => red.findIndex(other => other.target === r.target && other.filter === r.filter) === i);
  const solutions = (targets.length ? targets : [item.solution].filter(Boolean)).map(t => containedFile(worktree, t));
  const builds = band === 'LIGHT'
    ? [...new Set((item.files || []).filter(f => /\.cs$/i.test(f) && !/Tests?[\\/]|Tests?\.cs$/i.test(f)).map(projectFor))]
    : solutions;
  if (!builds.length && band === 'LIGHT') builds.push(...testProjects);
  if (!builds.length || (band !== 'LIGHT' && !solutions.length)) throw new Error('no trusted build/suite target');
  return { build: builds, filter: filters, suite: band === 'LIGHT' ? [] : solutions };
}

export function requiresNativeReceipt(result) {
  const e = result.evidenceIdentity;
  return Object.hasOwn(result, 'nativeEvidenceVersion') || ['native', 'claude-workflow'].includes(result.runtime)
    || Object.hasOwn(result, 'reviewPortfolio')
    || !!e && (['request', 'verification', 'integration', 'redProof', 'rootCause'].some(k => Object.hasOwn(e, k))
      || Object.hasOwn(result, 'reviewPortfolio') || Object.hasOwn(result, 'initialVerification'));
}

export function verifyNativeReceipt({ result, row, item = {}, itemDir, worktree, repoRoot, codeChange,
  evidenceInputs, engineMount, expectedMetadata, expectedContract, collect = collectEvidenceIdentity }) {
  if (!requiresNativeReceipt(result)) return null;
  try {
    if (Object.hasOwn(result, 'nativeEvidenceVersion') && result.nativeEvidenceVersion !== 1) throw new Error('unsupported native evidence version');
    const evidence = result.evidenceIdentity, request = evidence?.request;
    if (request?.version !== 1 || !/^[a-f0-9]{64}$/.test(request.digest)) throw new Error('native evidence request missing or malformed');
    if (!samePath(request.worktree, worktree) || !samePath(request.artifactDir, itemDir)) throw new Error('native request directory mismatch');
    const readReceipt = req => {
      const path = containedFile(itemDir, resolve(itemDir, 'native-evidence-' + req.digest + '.json'));
      if (row.attemptIdentity?.reservedAt && statSync(path).mtimeMs < Date.parse(row.attemptIdentity.reservedAt)) throw new Error('native receipt predates reservation');
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      validateNativeMetadata(receipt.metadata);
      if (canonicalJson(nativeEvidenceRequest(req.worktree, receipt.metadata, req.artifactDir)) !== canonicalJson(req)
        || canonicalJson(receipt.result?.request) !== canonicalJson(req)) throw new Error('native receipt request digest mismatch');
      return receipt;
    };
    const receipt = readReceipt(request), metadata = receipt.metadata, identity = metadata.requestIdentity;
    if (canonicalJson(receipt.result) !== canonicalJson(evidence)) throw new Error('native receipt/result mismatch');
    if (expectedMetadata !== undefined && canonicalJson(metadata) !== canonicalJson(expectedMetadata)) throw new Error('native expected metadata mismatch');
    if (expectedContract !== undefined) {
      for (const key of ['policies', 'profile']) if (canonicalJson(metadata[key]) !== canonicalJson(expectedContract[key])) throw new Error('native expected ' + key + ' mismatch');
      if (canonicalJson(metadata.reviewerContract.briefs) !== canonicalJson(expectedContract.briefs)
        || !samePath(metadata.reviewerContract.briefsDirectory, expectedContract.briefsDirectory)) throw new Error('native expected reviewer contract mismatch');
    }
    const attempt = row.attemptIdentity;
    const passId = attempt && String(attempt.runId).replace(/[^A-Za-z0-9._-]/g, '_') + '-' + String(attempt.claimId || result.id).replace(/[^A-Za-z0-9._-]/g, '_');
    if (!attempt || identity.itemId !== result.id || identity.runId !== attempt.runId || identity.claimId !== attempt.claimId
      || identity.attemptNumber !== attempt.attemptNumber || result.runId !== attempt.runId || result.claimId !== attempt.claimId
      || identity.passId !== passId || identity.codeChange !== codeChange) throw new Error('native request run/claim/pass mismatch');
    if (!['post-mutation', 'post-final-verify', 'post-final-scans'].includes(identity.boundary) || identity.integrationRequired) throw new Error('native final identity boundary mismatch');
    if (evidenceInputs !== undefined && canonicalJson(metadata.inputs) !== canonicalJson(evidenceInputs)) throw new Error('native input contract mismatch');
    if (engineMount !== undefined && canonicalJson(metadata.engineMount) !== canonicalJson(engineMount)) throw new Error('native engine mount mismatch');
    if (metadata.acceptance !== item.acceptance || canonicalJson(metadata.context.files) !== canonicalJson(item.files)
      || metadata.context.title !== item.title || metadata.context.regressionTest !== item.regressionTest
      || metadata.reviewerContract.band !== result.band
      || (result.reviewPortfolio !== undefined && canonicalJson(metadata.reviewerContract.portfolio) !== canonicalJson(result.reviewPortfolio))) throw new Error('native item/reviewer metadata mismatch');
    const initial = result.initialVerification;
    if (!initial || initial.passId !== passId) throw new Error('native initial verification contract missing');
    const initialPath = containedFile(itemDir, hostPath(initial.transcript || '', repoRoot));
    if (basename(initialPath) !== 'verify-initial-' + passId + '.txt') throw new Error('native initial transcript filename mismatch');
    const final = result.finalVerification;
    if (final && (final.refreshed !== true || typeof final.codeChanged !== 'boolean' || final.evidenceHash !== evidence.hash)) throw new Error('native final verification contract mismatch');
    const requestedPath = final?.codeChanged === true ? final.transcript : initial.transcript;
    const path = containedFile(itemDir, hostPath(metadata.verificationTranscript, repoRoot));
    if (!samePath(path, hostPath(requestedPath || '', repoRoot))
      || (final && !samePath(path, hostPath(final.transcript || '', repoRoot)))) throw new Error('native requested verification transcript mismatch');
    if (statSync(path).mtimeMs < Date.parse(attempt.reservedAt || attempt.startedAt)) throw new Error('native verification predates reservation');
    const validateOutput = (output, integrationRequired) => {
      if (typeof output.verification?.pass !== 'boolean' || typeof output.verification.reason !== 'string'
        || output.verification.pass !== true) throw new Error('native verification output invalid or failed');
      if (integrationRequired ? typeof output.integration?.pass !== 'boolean' || typeof output.integration.reason !== 'string'
        || output.integration.pass !== true : output.integration !== null) throw new Error('native integration output invalid or failed');
    };
    validateOutput(evidence, false);
    const { verificationTranscript, integrationTranscript, ...identityMetadata } = metadata;
    const current = collect(worktree, identityMetadata);
    const keys = ['version', 'hash', 'codeHash', 'baseRevision', 'fileCount'];
    if (current.version !== EVIDENCE_IDENTITY_VERSION || !/^[a-f0-9]{64}$/.test(evidence.hash)
      || !/^[a-f0-9]{64}$/.test(evidence.codeHash) || keys.some(k => current[k] !== evidence[k])) throw new Error('native evidence is stale against current worktree');
    const integrated = (result.transitions || []).concat(result.toState || []).some(s => ['INTEGRATED', 'CLOSED'].includes(s));
    if (integrated) {
      const integration = result.integrationVerification;
      if (codeChange && (!integration || integration.passId !== passId)) throw new Error('native integration verification contract missing');
      const integrationPath = codeChange ? containedFile(itemDir, hostPath(integration.transcript || '', repoRoot)) : null;
      if (integrationPath && basename(integrationPath) !== 'verify-integrate-' + passId + '.txt') throw new Error('native integration transcript filename mismatch');
      const integratedMetadata = { ...metadata, integrationTranscript: codeChange ? integration.transcript : null,
        requestIdentity: { ...identity, boundary: 'post-integrate', integrationRequired: codeChange } };
      const integratedRequest = nativeEvidenceRequest(request.worktree, integratedMetadata, request.artifactDir);
      const integratedReceipt = readReceipt(integratedRequest);
      if (keys.some(k => integratedReceipt.result[k] !== current[k])) throw new Error('native integration identity mismatch');
      validateOutput(integratedReceipt.result, codeChange);
    }
    if (!codeChange && !decodeTranscript(readFileSync(path)).trim()) throw new Error('native non-code verification transcript empty');
    return { pass: true, metadata, current };
  } catch (e) { return { pass: false, reason: e.message }; }
}

export function verifyFinalTranscript({ result, item = {}, itemDir, worktree, repoRoot, claimAt, targets, baseline, evidenceInputs, engineMount, nativeProof, collect = collectEvidenceIdentity }) {
  const f = result.finalVerification;
  if (!f || f.codeChanged === false) return null;
  try {
    if (f.refreshed !== true || f.codeChanged !== true) throw new Error('malformed final verification refresh');
    if (!/^[a-f0-9]{64}$/.test(f.evidenceHash) || result.evidenceIdentity?.version !== EVIDENCE_IDENTITY_VERSION || result.evidenceIdentity.hash !== f.evidenceHash) throw new Error('final verification identity mismatch');
    const path = containedFile(itemDir, hostPath(f.transcript || '', repoRoot));
    if (basename(path) !== 'verify-final-' + f.evidenceHash + '.txt') throw new Error('final transcript filename/hash mismatch');
    if (claimAt && statSync(path).mtimeMs < Date.parse(claimAt)) throw new Error('final transcript predates current claim');
    const metadata = nativeProof?.metadata || JSON.parse(readFileSync(containedFile(itemDir, resolve(itemDir, 'evidence-input.json')), 'utf8'));
    if (evidenceInputs !== undefined && canonicalJson(metadata.inputs || {}) !== canonicalJson(evidenceInputs)) throw new Error('final verification input contract mismatch');
    if (engineMount !== undefined && canonicalJson(metadata.engineMount || null) !== canonicalJson(engineMount)) throw new Error('final verification engine mount mismatch');
    const current = nativeProof?.current || collect(worktree, metadata);
    if (current.version !== EVIDENCE_IDENTITY_VERSION || current.hash !== f.evidenceHash) throw new Error('final verification is stale against current worktree');
    const text = decodeTranscript(readFileSync(path));
    const redPath = resolve(itemDir, 'verify-red-raw.txt');
    const redText = existsSync(redPath) ? decodeTranscript(readFileSync(containedFile(itemDir, redPath))) : '';
    const test = JSON.parse(readFileSync(containedFile(itemDir, resolve(itemDir, 'test.json')), 'utf8'));
    const expected = verificationExpectations({ item, test, worktree, targets, band: result.band, redText });
    const verdict = verifyTranscript(text, { worktree, expected, baseline,
      required: result.band === 'LIGHT' ? ['build', 'filter'] : ['build', 'filter', 'suite'] });
    return { ...verdict, text, mtimeMs: statSync(path).mtimeMs };
  } catch (e) { return { pass: false, reason: e.message }; }
}

export function verifyAttemptTranscript({ result, row, item = {}, itemDir, worktree, repoRoot, targets = [], baseline = 0, phase }) {
  const contract = phase === 'initial' ? result.initialVerification : result.integrationVerification;
  if (!contract) return null;
  try {
    const passId = i => String(i.runId).replace(/[^A-Za-z0-9._-]/g, '_') + '-' + String(i.claimId || result.id).replace(/[^A-Za-z0-9._-]/g, '_');
    const identities = [row.attemptIdentity];
    const identity = identities.find(i => i && passId(i) === contract.passId);
    if (!identity) throw new Error('attempt transcript has stale/unrecognized run/claim identity');
    const path = containedFile(itemDir, hostPath(contract.transcript || '', repoRoot));
    if (basename(path) !== 'verify-' + phase + '-' + passId(identity) + '.txt') throw new Error('attempt transcript filename mismatch');
    if (statSync(path).mtimeMs < Date.parse(identity.reservedAt || identity.startedAt)) throw new Error('attempt transcript predates reservation');
    const text = decodeTranscript(readFileSync(path));
    let expected;
    if (phase === 'initial') {
      const test = JSON.parse(readFileSync(containedFile(itemDir, resolve(itemDir, 'test.json')), 'utf8'));
      const redText = decodeTranscript(readFileSync(containedFile(itemDir, resolve(itemDir, 'verify-red-raw.txt'))));
      expected = verificationExpectations({ item, test, worktree, targets, band: result.band, redText });
    } else {
      if (!targets.length) throw new Error('no trusted integration targets');
      expected = { build: targets, suite: targets };
    }
    const required = phase === 'integrate' ? ['build', 'suite'] : result.band === 'LIGHT' ? ['build', 'filter'] : ['build', 'filter', 'suite'];
    return { ...verifyTranscript(text, { worktree, expected, required, baseline }), text, mtimeMs: statSync(path).mtimeMs };
  } catch (e) { return { pass: false, reason: e.message }; }
}

export function verifyRecoveryTranscript({ result, row, itemDir, worktree, repoRoot, baseline = 0, evidenceInputs, engineMount, collect = collectEvidenceIdentity }) {
  try {
    const contract = row.recoveryVerification;
    if (!contract || !row.attemptIdentity?.recovery || result.runId !== row.runId || result.claimId !== row.claimId) throw new Error('fresh recovery verification contract missing');
    const transcript = containedFile(itemDir, hostPath(contract.transcript, repoRoot));
    if (statSync(transcript).mtimeMs < Date.parse(row.attemptIdentity.reservedAt)) throw new Error('recovery transcript predates reservation');
    const text = decodeTranscript(readFileSync(transcript));
    const verdict = verifyTranscript(text, { worktree, expected: contract.expected, required: ['build', 'filter', 'suite'], baseline });
    if (!verdict.pass) return verdict;
    const metadata = JSON.parse(readFileSync(containedFile(itemDir, contract.metadataFile), 'utf8'));
    if (evidenceInputs !== undefined && canonicalJson(metadata.inputs || {}) !== canonicalJson(evidenceInputs)) throw new Error('recovery verification input contract mismatch');
    if (engineMount !== undefined && canonicalJson(metadata.engineMount || null) !== canonicalJson(engineMount)) throw new Error('recovery verification engine mount mismatch');
    const beforePath = containedFile(itemDir, contract.beforeIdentity), afterPath = containedFile(itemDir, contract.afterIdentity);
    const before = JSON.parse(readFileSync(beforePath, 'utf8')), after = JSON.parse(readFileSync(afterPath, 'utf8'));
    if (statSync(beforePath).mtimeMs < Date.parse(row.attemptIdentity.reservedAt) || statSync(beforePath).mtimeMs > statSync(transcript).mtimeMs
      || statSync(afterPath).mtimeMs < statSync(transcript).mtimeMs) throw new Error('recovery identity does not bracket fresh verification');
    const current = collect(worktree, metadata);
    if (before.version !== EVIDENCE_IDENTITY_VERSION || after.version !== EVIDENCE_IDENTITY_VERSION || current.version !== EVIDENCE_IDENTITY_VERSION
      || !/^[a-f0-9]{64}$/.test(before.hash) || before.hash !== after.hash || current.hash !== after.hash) throw new Error('recovery verification snapshot changed');
    return { pass: true, text, mtimeMs: statSync(transcript).mtimeMs };
  } catch (e) { return { pass: false, reason: e.message }; }
}

export function usageIdentity(payload) {
  const runIds = [...new Set((payload.results || []).map(r => r.runId).filter(Boolean))];
  const runId = payload.runId || (runIds.length === 1 ? runIds[0] : null);
  return runId ? runId + ':usage:final' : 'legacy-usage:' + createHash('sha256').update(JSON.stringify({ cycle: payload.cycle, ids: (payload.results || []).map(r => r.resultId).sort(), usage: payload.usage })).digest('hex');
}
