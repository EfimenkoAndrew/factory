import { aggregateCosts, COST_BASES } from './cost-accounting.mjs';
import { severityKnown } from './review-decisions.mjs';

export const OBSERVATION_VERSION = 1;

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const number = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nullableText = (v) => v === null || text(v);
const timestamp = (v) => v === null || (text(v) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)));
const oneOf = (v, values) => values.includes(v);
const fields = {
  dispatch: {
    itemId: null, attemptId: null, dispatchId: null, stage: null, role: null,
    runtimeVersion: null, sessionId: null, taskId: null, requestedModel: null, actualModel: null,
    effort: null, retry: null, fallback: null, promptHash: null, evidenceHash: null,
    startedAt: null, completedAt: null, outcome: null, inputTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null,
    costSource: null, measuredCost: null, currency: null, attributionConfidence: 'unknown',
    bucket: 'item', usageScope: 'dispatch', cacheSource: null, cacheScope: null,
    providerRequests: null, queueMs: null, executionMs: null,
  },
  'item-attempt': { itemId: null, attemptId: null, attemptNumber: null, phase: 'completed',
    band: null, outcome: null, recovery: false, startedAt: null, completedAt: null,
    lateDeterministicFailure: null },
  acceptance: { itemId: null, status: 'pending', delivered: null, actor: null,
    sourceRef: null, recordedAt: null, escapedDefects: null, correctionMinutes: null },
  finding: { itemId: null, snapshotId: null, role: null, findingId: null,
    canonicalFindingId: null, adjudication: 'unresolved', independent: null, blind: null },
  reuse: { itemId: null, attemptId: null, stage: null, status: null, reason: null, savedCalls: null },
};
const extensions = {
  dispatch: { costBasis: 'unknown', costParentDispatchId: null, costIncludesChildren: false },
  finding: { severity: null },
};

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

export function makeObservation(input) {
  const row = { version: OBSERVATION_VERSION, ...fields[input?.kind], ...extensions[input?.kind], ...input };
  const errors = validateObservation(row);
  if (errors.length) throw new TypeError(errors.join('; '));
  return row;
}

export function validateObservation(row) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['observation must be an object'];
  check(row.version === OBSERVATION_VERSION, 'unsupported observation version');
  for (const key of ['id', 'runId']) check(text(row[key]), key + ' required');
  if (!Object.hasOwn(fields, row.kind)) return [...errors, 'unknown observation kind'];
  for (const key of Object.keys(row)) check(['version', 'id', 'runId', 'kind', ...Object.keys(fields[row.kind]), ...Object.keys(extensions[row.kind] || {})].includes(key), 'unknown field ' + key);
  for (const key of Object.keys(fields[row.kind])) check(Object.hasOwn(row, key), key + ' must be explicit (null if unknown)');
  for (const key of ['itemId', 'attemptId', 'stage', 'role', 'runtimeVersion', 'sessionId', 'taskId', 'requestedModel', 'actualModel', 'effort', 'promptHash', 'evidenceHash', 'costSource', 'cacheSource', 'cacheScope', 'band', 'outcome', 'actor', 'sourceRef', 'reason']) {
    if (key in row) check(nullableText(row[key]), key + ' must be text or null');
  }
  for (const key of ['startedAt', 'completedAt', 'recordedAt']) if (key in row) check(timestamp(row[key]), key + ' must be an ISO timestamp or null');
  for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'measuredCost', 'providerRequests', 'queueMs', 'executionMs', 'escapedDefects', 'correctionMinutes', 'savedCalls']) {
    if (key in row) check(row[key] === null || number(row[key]), key + ' must be nonnegative or null');
  }
  for (const key of ['fallback', 'delivered', 'independent', 'blind', 'lateDeterministicFailure']) if (key in row) check(row[key] === null || typeof row[key] === 'boolean', key + ' must be boolean or null');
  if (row.startedAt && row.completedAt) check(Date.parse(row.completedAt) >= Date.parse(row.startedAt), 'completion precedes start');
  if (row.kind === 'dispatch') {
    if ('costBasis' in row) check(COST_BASES.includes(row.costBasis), 'invalid costBasis');
    if ('costParentDispatchId' in row) check(nullableText(row.costParentDispatchId) && row.costParentDispatchId !== row.dispatchId, 'invalid costParentDispatchId');
    if ('costIncludesChildren' in row) check(typeof row.costIncludesChildren === 'boolean', 'invalid costIncludesChildren');
    check(text(row.dispatchId), 'dispatchId required');
    check(row.retry === null || (Number.isInteger(row.retry) && row.retry >= 0), 'retry must be a zero-based integer or null');
    check(oneOf(row.bucket, ['item', 'shared-overhead']), 'invalid cost bucket');
    if (row.bucket === 'item') check(text(row.itemId) && text(row.attemptId), 'item dispatch needs itemId and attemptId');
    check(oneOf(row.attributionConfidence, ['direct', 'estimated', 'shared', 'unknown']), 'invalid attribution confidence');
    check(oneOf(row.usageScope, ['dispatch', 'shared-counter-delta', 'unknown']), 'invalid usage scope');
    check(row.currency === null || /^[A-Z]{3}$/.test(row.currency), 'currency must be ISO code or null');
    if (row.measuredCost !== null) check(text(row.costSource) && text(row.currency), 'measured cost needs source and currency');
  } else if (row.kind === 'item-attempt') {
    check(text(row.itemId) && text(row.attemptId), 'item-attempt needs itemId and attemptId');
    check(row.attemptNumber === null || (Number.isInteger(row.attemptNumber) && row.attemptNumber >= 1), 'attemptNumber must be positive or null');
    check(oneOf(row.phase, ['started', 'completed']), 'invalid attempt phase');
    check(typeof row.recovery === 'boolean', 'recovery must be boolean');
  } else if (row.kind === 'acceptance') {
    check(text(row.itemId) && text(row.actor) && text(row.sourceRef) && row.recordedAt !== null, 'acceptance needs explicit item, human actor, source reference and timestamp');
    check(oneOf(row.status, ['accepted', 'rejected', 'pending']), 'invalid acceptance status');
  } else if (row.kind === 'finding') {
    if ('severity' in row) check(row.severity === null || severityKnown(row.severity), 'invalid finding severity');
    for (const key of ['itemId', 'snapshotId', 'role', 'findingId']) check(text(row[key]), key + ' required');
    check(oneOf(row.adjudication, ['valid', 'false-positive', 'unresolved']), 'invalid adjudication');
    check(nullableText(row.canonicalFindingId), 'canonicalFindingId must be text or null');
    if (row.adjudication !== 'unresolved') check(text(row.canonicalFindingId) && row.independent === true, 'resolved finding needs independent adjudication and canonical identity');
  } else if (row.kind === 'reuse') {
    check(text(row.itemId) && text(row.attemptId) && text(row.stage) && text(row.reason), 'reuse needs item, attempt, stage and reason');
    check(oneOf(row.status, ['hit', 'miss']), 'reuse status must be hit or miss');
  }
  return errors;
}

export function deduplicateImmutable(rows, keyOf = (r) => r.id) {
  const groups = new Map();
  let duplicates = 0;
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, new Map());
    const variants = groups.get(key), serialized = canonicalJson(row);
    if (variants.has(serialized)) duplicates++;
    else variants.set(serialized, row);
  }
  const records = [], conflicts = [];
  for (const [id, variants] of groups) {
    if (variants.size === 1) records.push([...variants.values()][0]);
    else conflicts.push(id);
  }
  return { records, duplicates, conflicts };
}

export function observationEvent(observation) {
  const row = makeObservation(observation);
  return { event: 'attempt_observation', source: 'driver', runId: row.runId,
    item: row.itemId, attrs: { observation: row } };
}

export function adaptNativeAttemptObservation(raw, context = {}) {
  if (raw?.version !== 1 || !text(raw.runId) || !text(raw.attemptId) || !text(raw.dispatchId)) throw new TypeError('native v1 observation needs immutable run/dispatch/physical attempt IDs');
  const overhead = raw.overhead === true;
  const itemId = context.itemId ?? (overhead ? null : raw.itemId);
  if (!text(raw.outcome)) throw new TypeError('native observation needs explicit outcome');
  const phase = raw.outcome === 'started' ? 'started' : 'terminal';
  const row = { kind: 'dispatch', id: 'native:' + raw.attemptId + ':' + phase, runId: raw.runId,
    dispatchId: raw.attemptId, itemId, attemptId: context.itemAttemptId ?? null,
    stage: String(raw.phase || '').toLowerCase() || null, role: raw.stage || null,
    bucket: overhead ? 'shared-overhead' : 'item' };
  for (const key of ['runtimeVersion', 'requestedModel', 'actualModel', 'effort', 'retry', 'fallback',
    'startedAt', 'completedAt', 'outcome', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'promptHash', 'evidenceHash', 'costSource', 'measuredCost', 'attributionConfidence', 'costBasis', 'costParentDispatchId', 'costIncludesChildren']) if (raw[key] !== undefined) row[key] = raw[key];
  if (raw.measuredCost !== null && raw.measuredCost !== undefined) row.currency = context.currency ?? null;
  return makeObservation(row);
}

export function normalizeAttemptObservations(input, contextFor = () => ({})) {
  if (!Array.isArray(input)) throw new TypeError('producer observations must be an array');
  const records = [], invalid = [];
  for (const raw of input) {
    try {
      if (raw?.kind) {
        const errors = validateObservation(raw);
        if (errors.length) throw new TypeError(errors.join('; '));
        records.push({ ...raw });
      } else records.push(adaptNativeAttemptObservation(raw, contextFor(raw)));
    } catch (error) { invalid.push({ id: raw?.id ?? raw?.attemptId ?? null, errors: [error.message] }); }
  }
  return { records, invalid };
}

const dispatchPending = (row) => row.outcome === null || ['started', 'creating', 'created', 'sending', 'admitted', 'running', 'pending', 'uncertain'].includes(row.outcome);

function reconcileDispatches(rows, poisonedIds) {
  const groups = new Map(), records = [], conflicts = [];
  for (const row of rows.filter((r) => r.kind === 'dispatch')) {
    const key = JSON.stringify([row.runId, row.dispatchId]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  let supersededStarts = 0;
  for (const [key, group] of groups) {
    if (group.some((r) => poisonedIds.includes(r.id))) continue;
    const starts = group.filter(dispatchPending), terminal = group.filter((r) => !dispatchPending(r));
    const unique = deduplicateImmutable(group);
    const uniqueStarts = unique.records.filter(dispatchPending), uniqueTerminal = unique.records.filter((r) => !dispatchPending(r));
    if (uniqueStarts.length > 1 || uniqueTerminal.length > 1) { conflicts.push(key); continue; }
    if (starts.length && terminal.length) {
      const a = starts[0], b = terminal[0];
      const immutable = ['runId', 'dispatchId', 'itemId', 'attemptId', 'stage', 'role', 'bucket', 'requestedModel', 'effort', 'retry', 'fallback', 'runtimeVersion', 'sessionId', 'taskId', 'promptHash', 'evidenceHash', 'startedAt'];
      if (immutable.some((k) => a[k] !== b[k])) { conflicts.push(key); continue; }
      supersededStarts++;
    }
    records.push(uniqueTerminal[0] || uniqueStarts[0]);
  }
  return { records, conflicts, supersededStarts };
}

export function aggregateFindings(findings) {
  const canonical = new Map(), perRole = Object.create(null);
  const severity = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, unknown: 0 };
  for (const f of findings) {
    severity[severityKnown(f.severity) ? f.severity : 'unknown']++;
    const role = perRole[f.role] ||= { reported: 0, valid: 0, uniqueValid: 0, falsePositives: 0, unresolved: 0, blindAdjudicated: 0 };
    const key = JSON.stringify([f.itemId, f.snapshotId, f.canonicalFindingId || f.findingId]);
    if (!canonical.has(key)) canonical.set(key, { roles: new Set(), rows: [], outcomes: new Set() });
    const group = canonical.get(key);
    group.rows.push(f);
    group.outcomes.add(f.adjudication);
    group.roles.add(f.role);
    role.reported++;
  }
  const overlap = Object.create(null);
  let validFindings = 0, conflictingAdjudications = 0;
  for (const group of canonical.values()) {
    const resolved = [...group.outcomes].filter((v) => v !== 'unresolved');
    const outcome = resolved.length === 1 ? resolved[0] : 'unresolved';
    const validRoles = new Set(group.rows.filter((r) => r.adjudication === 'valid').map((r) => r.role));
    if (resolved.length > 1) conflictingAdjudications++;
    if (outcome === 'valid') validFindings++;
    for (const role of group.roles) {
      const p = perRole[role];
      const roleResolved = group.rows.some((r) => r.role === role && r.adjudication === outcome && outcome !== 'unresolved');
      if (outcome === 'valid' && roleResolved) { p.valid++; if (validRoles.size === 1) p.uniqueValid++; }
      else if (outcome === 'false-positive' && roleResolved) p.falsePositives++;
      else p.unresolved++;
      if (roleResolved && group.rows.some((r) => r.role === role && r.adjudication === outcome && r.blind === true)) p.blindAdjudicated++;
    }
    if (outcome === 'valid') {
      const roles = [...validRoles].sort();
      for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++) {
        const key = JSON.stringify([roles[i], roles[j]]);
        overlap[key] = (overlap[key] || 0) + 1;
      }
    }
  }
  for (const p of Object.values(perRole)) p.falsePositiveRate = p.valid + p.falsePositives ? p.falsePositives / (p.valid + p.falsePositives) : null;
  return { validFindings, perRole, overlap, conflictingAdjudications, reportedSeverity: severity };
}

export function aggregateObservations(input, options = {}) {
  if (!Array.isArray(input)) throw new TypeError('observations must be an array');
  if (options.currency !== undefined && !/^[A-Z]{3}$/.test(options.currency)) throw new TypeError('currency must be ISO code');
  if (options.cohort && (!text(options.cohort.id) || !['itemIds', 'runIds'].every((k) => Array.isArray(options.cohort[k])
    && options.cohort[k].every(text) && new Set(options.cohort[k]).size === options.cohort[k].length)
    || typeof options.cohort.lifetimeComplete !== 'boolean')) throw new TypeError('cohort needs id, unique itemIds/runIds and explicit lifetimeComplete');
  const invalid = [], valid = [];
  for (const row of input || []) {
    const errors = validateObservation(row);
    if (errors.length) invalid.push({ id: row?.id ?? null, errors }); else valid.push(row);
  }
  const dedup = deduplicateImmutable(valid);
  const physical = reconcileDispatches(valid, dedup.conflicts);
  const cohort = options.cohort || null;
  const selected = (r) => !cohort || (r.itemId ? cohort.itemIds.includes(r.itemId) : cohort.runIds.includes(r.runId));
  const records = dedup.records.filter(selected);
  const dispatches = physical.records.filter(selected);
  const attempts = records.filter((r) => r.kind === 'item-attempt');
  const firstItems = [...new Set(attempts.filter((r) => r.attemptNumber === 1).map((r) => r.itemId))];
  const firstPassItems = firstItems.filter((id) => {
    const first = attempts.filter((r) => r.itemId === id && r.attemptNumber === 1);
    return new Set(first.map((r) => r.attemptId)).size === 1 && first.some((r) => r.phase === 'completed' && r.outcome === 'CLOSED' && !r.recovery)
      && !first.some((r) => r.phase === 'completed' && r.outcome !== 'CLOSED');
  });
  const acceptance = new Map();
  for (const row of records.filter((r) => r.kind === 'acceptance')) {
    const prev = acceptance.get(row.itemId);
    if (!prev || Date.parse(row.recordedAt) > Date.parse(prev.recordedAt)) acceptance.set(row.itemId, row);
    else if (Date.parse(row.recordedAt) === Date.parse(prev.recordedAt) && canonicalJson(row) !== canonicalJson(prev)) acceptance.set(row.itemId, { ...prev, status: 'pending' });
  }
  const accepted = [...acceptance.values()].filter((r) => r.status === 'accepted' && r.delivered === true);
  const currency = options.currency || 'USD';
  const eligible = r => !dispatchPending(r) && (r.usageScope === 'dispatch'
    || (r.usageScope === 'shared-counter-delta' && r.costIncludesChildren === true && r.attributionConfidence === 'shared'))
    && ['direct', 'shared'].includes(r.attributionConfidence);
  const accounting = aggregateCosts(dispatches, { eligible });
  const excluded = new Set(accounting.excludedChildren);
  const measured = dispatches.filter((r) => eligible(r) && r.measuredCost !== null && r.currency === currency
    && !excluded.has(JSON.stringify([r.runId, r.dispatchId])));
  const currencyGroups = accounting.groups.filter(g => g.currency === currency);
  const knownCost = currencyGroups.length === 1 ? currencyGroups[0].measuredCost : currencyGroups.length ? null : 0;
  const costByBucket = { item: 0, 'shared-overhead': 0 };
  for (const r of measured) costByBucket[r.bucket] += r.measuredCost;
  if (currencyGroups.length > 1) for (const key of Object.keys(costByBucket)) costByBucket[key] = null;
  const complete = !!cohort?.lifetimeComplete && accounting.complete && accounting.currency === currency
    && !invalid.length && !dedup.conflicts.length && !physical.conflicts.length
    && cohort.itemIds.every((id) => dispatches.some((r) => r.itemId === id));
  const reuse = { hits: 0, misses: 0, reasons: Object.create(null), savedCallsKnown: 0, unknownSavedCalls: 0 };
  for (const r of records.filter((r) => r.kind === 'reuse')) {
    reuse[r.status === 'hit' ? 'hits' : 'misses']++;
    const key = JSON.stringify([r.status, r.reason]);
    reuse.reasons[key] = (reuse.reasons[key] || 0) + 1;
    if (r.savedCalls === null) reuse.unknownSavedCalls++; else reuse.savedCallsKnown += r.savedCalls;
  }
  const coverage = {};
  for (const field of ['actualModel', 'requestedModel', 'runtimeVersion', 'retry', 'fallback', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'measuredCost', 'queueMs', 'executionMs']) {
    const known = dispatches.filter((r) => r[field] !== null).length;
    coverage[field] = { known, total: dispatches.length, rate: dispatches.length ? known / dispatches.length : null };
  }
  const cacheScopes = Object.create(null);
  const modelPairs = Object.create(null);
  const usageByScope = Object.create(null);
  const timing = { queueMsKnown: 0, queueUnknown: 0, executionMsKnown: 0, executionUnknown: 0 };
  for (const r of dispatches) {
    const key = JSON.stringify([r.cacheSource, r.cacheScope, r.usageScope]);
    cacheScopes[key] = (cacheScopes[key] || 0) + 1;
    const modelKey = JSON.stringify([r.requestedModel, r.actualModel]);
    modelPairs[modelKey] = (modelPairs[modelKey] || 0) + 1;
    const usageKey = JSON.stringify([r.usageScope, r.attributionConfidence, r.cacheSource, r.cacheScope]);
    const usage = usageByScope[usageKey] ||= { dispatches: 0, known: {}, subtotal: {} };
    usage.dispatches++;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      usage.known[field] = (usage.known[field] || 0) + Number(r[field] !== null);
      usage.subtotal[field] = (usage.subtotal[field] || 0) + (r[field] ?? 0);
    }
    for (const field of ['queue', 'execution']) {
      if (r[field + 'Ms'] === null) timing[field + 'Unknown']++;
      else timing[field + 'MsKnown'] += r[field + 'Ms'];
    }
  }
  return {
    version: 1, cohort: cohort?.id || 'observed stream (left-censoring possible)',
    invalid, duplicates: dedup.duplicates, supersededStarts: physical.supersededStarts,
    conflicts: [...new Set([...dedup.conflicts, ...physical.conflicts])],
    firstPass: { closed: firstPassItems.length, items: firstItems.length, rate: firstItems.length ? firstPassItems.length / firstItems.length : null,
      unknownOrdinalItems: new Set(attempts.filter((r) => r.attemptNumber === null).map((r) => r.itemId)).size },
    calls: { physical: dispatches.length, retries: dispatches.filter((r) => r.retry > 0).length,
      terminal: dispatches.filter((r) => !dispatchPending(r)).length,
      incomplete: dispatches.filter(dispatchPending).length,
      fallbacks: dispatches.filter((r) => r.fallback === true).length,
      sharedOverhead: dispatches.filter((r) => r.bucket === 'shared-overhead').length,
      checkpoints: dispatches.filter((r) => r.stage === 'checkpoint').length },
    accounting,
    delivery: { accepted: accepted.length, explicitDecisions: acceptance.size, currency, knownCost, costByBucket, complete,
      costBasis: accounting.costBasis, measurementComplete: accounting.measurementComplete,
      costPerAccepted: complete && accepted.length ? knownCost / accepted.length : null,
      knownCostPerAccepted: accepted.length && knownCost !== null ? knownCost / accepted.length : null,
      missingCostDispatches: dispatches.length - excluded.size - measured.length,
      escapedDefectsKnown: accepted.reduce((s, r) => s + (r.escapedDefects ?? 0), 0),
      escapedDefectsUnknown: accepted.filter((r) => r.escapedDefects === null).length,
      correctionMinutesKnown: [...acceptance.values()].reduce((s, r) => s + (r.correctionMinutes ?? 0), 0),
      correctionMinutesUnknown: [...acceptance.values()].filter((r) => r.correctionMinutes === null).length },
    findings: aggregateFindings(records.filter((r) => r.kind === 'finding')), reuse, coverage, cacheScopes, modelPairs, usageByScope, timing,
    lateDeterministicFailures: attempts.filter((r) => r.phase === 'completed' && r.lateDeterministicFailure === true).length,
  };
}

export function renderObservationReport(report) {
  const pct = (n) => n === null ? 'unknown' : (n * 100).toFixed(1) + '%';
  const show = (n) => n === null ? 'unknown' : n;
  return [
    '## Attempt observations (v1; observational only)', '',
    `Cohort: ${report.cohort}. First-pass closes / all observed first-attempt items: **${report.firstPass.closed}/${report.firstPass.items} (${pct(report.firstPass.rate)})**. Unknown attempt ordinal: ${report.firstPass.unknownOrdinalItems}.`, '',
    `Physical dispatches: ${report.calls.physical}; terminal: ${report.calls.terminal}; incomplete/unknown: ${report.calls.incomplete}; retries: ${report.calls.retries}; fallbacks: ${report.calls.fallbacks}; shared overhead: ${report.calls.sharedOverhead}; checkpoints: ${report.calls.checkpoints}. Provider-internal retries are unknown unless supplied separately.`, '',
    `Requested / actual model pairs (null = unknown): ${JSON.stringify(report.modelPairs)}. A route alias never proves the actual model.`, '',
    `Human-accepted delivered changes (explicit input): ${report.delivery.accepted}. Lifetime cost per accepted delivery: **${show(report.delivery.costPerAccepted)} ${report.delivery.currency} (${report.delivery.costBasis ?? 'mixed bases'})**. Known-cost subtotal: ${show(report.delivery.knownCost)}; known subtotal / accepted: ${show(report.delivery.knownCostPerAccepted)}. Only invoice basis represents billed cost.`, '',
    `Accounting by currency/basis and role/model/runtime: ${JSON.stringify(report.accounting)}. Measurement completeness is separate from accounting basis; unknown or mixed bases cannot yield a complete unqualified total.`, '',
    `Known cost by bucket: ${JSON.stringify(report.delivery.costByBucket)}. Queue milliseconds known: ${report.timing.queueMsKnown} (${report.timing.queueUnknown} dispatches unknown); execution milliseconds known: ${report.timing.executionMsKnown} (${report.timing.executionUnknown} dispatches unknown). Concurrent execution sums are not elapsed run time.`, '',
    `Escaped defects known: ${report.delivery.escapedDefectsKnown} (${report.delivery.escapedDefectsUnknown} accepted items unknown); correction minutes known: ${report.delivery.correctionMinutesKnown} (${report.delivery.correctionMinutesUnknown} decisions unknown).`, '',
    '| Role | Adjudicated valid | Exclusive valid | False positives | Unresolved | False-positive rate |',
    '|---|---|---|---|---|---|',
    ...Object.entries(report.findings.perRole).map(([role, r]) => `| ${role} | ${r.valid} | ${r.uniqueValid} | ${r.falsePositives} | ${r.unresolved} | ${pct(r.falsePositiveRate)} |`), '',
    `Valid finding overlap (role pairs): ${JSON.stringify(report.findings.overlap)}. Canonical findings are adjudicator-supplied, never inferred from similar prose.`, '',
    `Reuse: ${report.reuse.hits} hits / ${report.reuse.misses} misses; reasons: ${JSON.stringify(report.reuse.reasons)}. Known saved calls: ${report.reuse.savedCallsKnown}; unknown: ${report.reuse.unknownSavedCalls}.`, '',
    '| Telemetry field | Known / observed dispatches | Coverage |', '|---|---|---|',
    ...Object.entries(report.coverage).map(([key, r]) => `| ${key} | ${r.known}/${r.total} | ${pct(r.rate)} |`), '',
    `Cache source / scope / attribution: ${JSON.stringify(report.cacheScopes)}. Coverage describes observed dispatches, not proof that every dispatch was observed.`, '',
    `Token subtotals with known-bucket counts by scope / confidence / cache source / cache scope: ${JSON.stringify(report.usageByScope)}. Shared deltas are not direct per-item measurements; do not add run totals again.`, '',
    `Duplicate observations: ${report.duplicates}; starts superseded by terminal records: ${report.supersededStarts}; conflicting identities excluded: ${report.conflicts.length}; invalid observations excluded: ${report.invalid.length}; late deterministic failures: ${report.lateDeterministicFailures}.`,
  ].join('\n');
}
