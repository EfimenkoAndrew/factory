import { createHash } from 'node:crypto';
import { canonicalJson, aggregateFindings } from './observations.mjs';
import { aggregateCosts, costBasis, COST_BASES } from './cost-accounting.mjs';
import { validateDecision, severityKnown, reviewDecision, decisionMetrics } from './review-decisions.mjs';

const fail = (condition, message) => { if (!condition) throw new TypeError(message); };
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const nonnegative = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
export const snapshotHash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function unique(rows, key, name) {
  fail(Array.isArray(rows), name + ' must be an array');
  const ids = rows.map((r) => r?.[key]);
  fail(ids.every(text) && new Set(ids).size === ids.length, name + ' needs unique ' + key);
}

function validateSnapshot(snapshot) {
  fail(snapshot && text(snapshot.baseRevision) && text(snapshot.acceptance), 'snapshot needs baseRevision and acceptance');
  fail(snapshot.policy && typeof snapshot.policy === 'object' && !Array.isArray(snapshot.policy), 'snapshot needs explicit policy');
  fail(text(snapshot.reviewerContract), 'snapshot needs complete reviewerContract');
  fail(snapshot.files && typeof snapshot.files === 'object' && !Array.isArray(snapshot.files) && Object.keys(snapshot.files).length, 'snapshot needs embedded files');
  for (const [path, contents] of Object.entries(snapshot.files)) {
    fail(text(path) && !/^(?:[a-z]:|[\\/])/i.test(path) && !path.split(/[\\/]/).includes('..'), 'snapshot paths must be relative and contained');
    fail(typeof contents === 'string', 'snapshot files must contain full text (binary inputs require a separate contract)');
  }
}

export function freezeExperiment(input) {
  fail(input && text(input.experimentId), 'experimentId required');
  unique(input.arms, 'id', 'arms');
  fail(input.arms.length >= 2 && input.arms.some((r) => r.id === input.baselineArm), 'baselineArm must identify one of at least two arms');
  for (const arm of input.arms) fail(text(arm.contract) && (arm.requestedModel === null || text(arm.requestedModel)), 'arm needs complete contract and explicit requestedModel (null if unknown)');
  unique(input.cases, 'caseId', 'cases');
  fail(input.cases.length > 0, 'at least one case required');
  for (const c of input.cases) {
    fail(text(c.itemId) && ['documentation', 'ordinary-code', 'high-risk'].includes(c.stratum), 'case needs itemId and known stratum');
    fail(['approved', 'rejected', 'mixed'].includes(c.originalOutcome), 'originalOutcome must include the real approved/rejected/mixed disposition');
    validateSnapshot(c.snapshot);
  }
  const manifest = JSON.parse(JSON.stringify({ version: 1, experimentId: input.experimentId,
    baselineArm: input.baselineArm, arms: input.arms,
    cases: input.cases.map((c) => ({ ...c, snapshotHash: snapshotHash(c.snapshot) })) }));
  manifest.digest = snapshotHash(manifest);
  return manifest;
}

export function validateFrozenExperiment(manifest) {
  fail(manifest?.version === 1, 'unsupported experiment version');
  const { digest, ...body } = manifest;
  fail(digest === snapshotHash(body), 'frozen experiment digest mismatch');
  freezeExperiment(manifest);
  for (const c of manifest.cases) fail(c.snapshotHash === snapshotHash(c.snapshot), 'frozen snapshot hash mismatch: ' + c.caseId);
  return manifest;
}

export function blindId(manifest, caseId, armId) {
  return snapshotHash([manifest.digest, caseId, armId]).slice(0, 24);
}

function validateSubmissions(manifest, submissions) {
  unique(submissions, 'blindId', 'submissions');
  for (const s of submissions) {
    const c = manifest.cases.find((r) => r.caseId === s.caseId);
    fail(c && manifest.arms.some((r) => r.id === s.armId), 'submission outside frozen cohort');
    fail(s.blindId === blindId(manifest, s.caseId, s.armId), 'submission blindId mismatch');
    fail(s.snapshotHash === c.snapshotHash, 'submission snapshot mismatch');
    fail(['completed', 'error', 'timeout'].includes(s.status), 'invalid submission status');
    fail(s.actualModel === null || text(s.actualModel), 'actualModel must be explicit, not inferred from arm');
    fail(nonnegative(s.measuredCost) && (s.measuredCost === null || (text(s.costSource) && /^[A-Z]{3}$/.test(s.currency))), 'cost needs value, source and currency (or explicit null)');
    fail(s.costBasis === undefined || COST_BASES.includes(s.costBasis), 'invalid costBasis');
    fail(validateDecision(s.decision), 'invalid versioned review decision');
    unique(s.findings, 'findingId', 'submission findings');
    for (const f of s.findings) {
      fail(text(f.role) && text(f.text), 'finding needs role and text');
      fail(f.severity == null || severityKnown(f.severity), 'invalid structured finding severity');
    }
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'extraReads', 'formatFailures', 'physicalCalls', 'reusedCalls']) fail(nonnegative(s[key]), key + ' must be explicit nonnegative number or null');
  }
}

export function blindPacket(manifest, submissions) {
  validateFrozenExperiment(manifest);
  validateSubmissions(manifest, submissions);
  return { version: 2, experimentDigest: manifest.digest,
    instructions: 'Adjudicate independently. Do not consult the arm mapping. Canonicalize equivalent findings within each snapshot. Supply unresolved for unknowns; record accepted/rejected/mixed review-quality outcomes and a complete reference-finding set only when actually adjudicated. Preserve candidate decisions separately from finding quality. Each truth row should include findingSeverities:[{canonicalFindingId,severity}] for its validFindingIds; independently assign LOW/MEDIUM/HIGH/CRITICAL or null if unknown. HIGH/CRITICAL is the decision-metric blocking threshold. Never infer severity from candidate prose or copy a reviewer severity as reference truth. Complete empty truth supports approval; incomplete or missing reference severity leaves decision accuracy unknown.',
    cases: manifest.cases.map((c) => ({ caseId: c.caseId, snapshotHash: c.snapshotHash, snapshot: c.snapshot,
      candidates: submissions.filter((s) => s.caseId === c.caseId).map((s) => ({ blindId: s.blindId,
        status: s.status, decision: s.decision ? { version: s.decision.version, rawVerdict: s.decision.rawVerdict,
          verdict: s.decision.verdict, rule: s.decision.rule,
          ...(s.decision.sources ? { sources: s.decision.sources.map((r, i) => ({ role: 'reviewer-' + (i + 1), rawVerdict: r.rawVerdict })) } : {}) } : reviewDecision(),
        findings: s.findings.map((f) => ({ findingId: f.findingId, text: f.text, severity: f.severity ?? null })) })).sort((a, b) => a.blindId.localeCompare(b.blindId)) })) };
}

export function reportExperiment(manifest, submissions, adjudications) {
  validateFrozenExperiment(manifest);
  validateSubmissions(manifest, submissions);
  fail(adjudications?.version === 1 && adjudications.experimentDigest === manifest.digest, 'adjudication experiment mismatch');
  unique(adjudications.outcomes, 'blindId', 'blind outcomes');
  unique(adjudications.truth, 'caseId', 'reference truth');
  fail(Array.isArray(adjudications.findings), 'adjudicated findings required');
  const findingKeys = new Set();
  const canonicalOutcomes = new Map();
  for (const a of [...adjudications.outcomes, ...adjudications.findings, ...adjudications.truth]) {
    fail(a.blind === true && a.independent === true && text(a.adjudicator), 'adjudication must explicitly be independent and blind with an adjudicator');
  }
  for (const a of adjudications.outcomes) {
    fail(submissions.some((s) => s.blindId === a.blindId), 'outcome references missing submission');
    fail(['accepted', 'rejected', 'mixed', 'unresolved'].includes(a.outcome), 'invalid blind outcome');
    if (a.outcome === 'accepted') fail(submissions.find((s) => s.blindId === a.blindId).status === 'completed', 'non-completed submission cannot be accepted');
    fail(nonnegative(a.escapedDefects) && nonnegative(a.correctionMinutes), 'quality unknowns must be explicit');
  }
  for (const a of adjudications.truth) {
    fail(manifest.cases.some((c) => c.caseId === a.caseId), 'truth references missing case');
    fail(typeof a.complete === 'boolean' && Array.isArray(a.validFindingIds) && a.validFindingIds.every(text)
      && new Set(a.validFindingIds).size === a.validFindingIds.length, 'truth needs completeness and unique validFindingIds');
    if (a.findingSeverities !== undefined) {
      unique(a.findingSeverities, 'canonicalFindingId', 'truth finding severities');
      fail(a.findingSeverities.every(f => a.validFindingIds.includes(f.canonicalFindingId) && (f.severity === null || severityKnown(f.severity))), 'invalid reference severity');
    }
  }
  for (const a of adjudications.findings) {
    const s = submissions.find((r) => r.blindId === a.blindId);
    fail(s?.findings.some((f) => f.findingId === a.findingId), 'adjudication references missing finding');
    const key = JSON.stringify([a.blindId, a.findingId]);
    fail(!findingKeys.has(key), 'duplicate finding adjudication'); findingKeys.add(key);
    fail(['valid', 'false-positive', 'unresolved'].includes(a.outcome), 'invalid finding outcome');
    fail(a.canonicalFindingId === null || text(a.canonicalFindingId), 'canonical finding identity must be explicit');
    fail(a.outcome === 'unresolved' || text(a.canonicalFindingId), 'resolved finding needs canonical identity');
    if (a.outcome !== 'unresolved') {
      const canonicalKey = JSON.stringify([s.caseId, a.canonicalFindingId]);
      fail(!canonicalOutcomes.has(canonicalKey) || canonicalOutcomes.get(canonicalKey) === a.outcome, 'conflicting canonical adjudication');
      canonicalOutcomes.set(canonicalKey, a.outcome);
    }
    const truth = adjudications.truth.find((r) => r.caseId === s.caseId);
    if (truth?.complete && a.outcome !== 'unresolved') fail((a.outcome === 'valid') === truth.validFindingIds.includes(a.canonicalFindingId), 'finding conflicts with complete reference truth');
  }
  const counts = { strata: {}, originalOutcomes: {} };
  for (const c of manifest.cases) {
    counts.strata[c.stratum] = (counts.strata[c.stratum] || 0) + 1;
    counts.originalOutcomes[c.originalOutcome] = (counts.originalOutcomes[c.originalOutcome] || 0) + 1;
  }
  const arms = Object.create(null);
  for (const arm of manifest.arms) {
    const rows = submissions.filter((s) => s.armId === arm.id);
    const outcomes = adjudications.outcomes.filter((a) => rows.some((s) => s.blindId === a.blindId));
    const findings = rows.flatMap((s) => s.findings.map((f) => {
      const a = adjudications.findings.find((r) => r.blindId === s.blindId && r.findingId === f.findingId);
      return { itemId: s.caseId, snapshotId: s.snapshotHash, role: f.role, findingId: f.findingId, severity: f.severity ?? null,
        canonicalFindingId: a?.canonicalFindingId ?? null, adjudication: a?.outcome || 'unresolved', blind: a?.blind ?? null };
    }));
    const valid = findings.filter((f) => f.adjudication === 'valid');
    let falseNegatives = 0, referenceFindings = 0, truthCases = 0;
    for (const c of manifest.cases) {
      const truth = adjudications.truth.find((r) => r.caseId === c.caseId && r.complete);
      const submission = rows.find((r) => r.caseId === c.caseId);
      if (!truth || !submission || submission.status !== 'completed'
        || findings.some((f) => f.itemId === c.caseId && f.adjudication === 'unresolved')) continue;
      truthCases++;
      referenceFindings += truth.validFindingIds.length;
      falseNegatives += truth.validFindingIds.filter((id) => !valid.some((f) => f.itemId === c.caseId && f.canonicalFindingId === id)).length;
    }
    const accepted = outcomes.filter((r) => r.outcome === 'accepted').length;
    const accounting = aggregateCosts(rows, { expected: manifest.cases.length });
    const usdGroups = accounting.groups.filter(g => g.currency === 'USD');
    const knownCost = usdGroups.length === 1 ? usdGroups[0].measuredCost : usdGroups.length ? null : 0;
    const costComplete = accounting.complete && accounting.currency === 'USD';
    const metrics = {};
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'extraReads', 'formatFailures', 'physicalCalls', 'reusedCalls']) {
      const known = rows.filter((r) => r[key] !== null);
      metrics[key] = { known: known.length, total: manifest.cases.length, subtotal: known.reduce((n, r) => n + r[key], 0) };
    }
    arms[arm.id] = { baseline: arm.id === manifest.baselineArm, cases: manifest.cases.length, submitted: rows.length,
      completed: rows.filter((s) => s.status === 'completed').length, accepted,
      rejected: outcomes.filter((r) => r.outcome === 'rejected').length, mixed: outcomes.filter((r) => r.outcome === 'mixed').length,
      unresolved: manifest.cases.length - outcomes.filter((r) => r.outcome !== 'unresolved').length,
      knownCostUSD: knownCost, costComplete, accounting, decisions: decisionMetrics(manifest.cases, rows, adjudications.truth),
      costPerBlindAccepted: costComplete && accepted ? knownCost / accepted : null,
      actualModelCoverage: rows.filter((r) => r.actualModel !== null).length,
      findings: aggregateFindings(findings), falseNegatives, referenceFindings, truthCases,
      falseNegativeRate: referenceFindings ? falseNegatives / referenceFindings : null, metrics,
      escapedDefectsKnown: outcomes.reduce((n, r) => n + (r.escapedDefects ?? 0), 0),
      escapedDefectsUnknown: manifest.cases.length - outcomes.filter((r) => r.escapedDefects !== null).length,
      correctionMinutesKnown: outcomes.reduce((n, r) => n + (r.correctionMinutes ?? 0), 0) };
  }
  const paired = Object.create(null);
  for (const arm of manifest.arms.filter((r) => r.id !== manifest.baselineArm)) {
    let cases = 0, acceptedDelta = 0, knownCostDeltaUSD = 0, costPairs = 0;
    const costDeltas = new Map();
    for (const c of manifest.cases) {
      const base = submissions.find((r) => r.caseId === c.caseId && r.armId === manifest.baselineArm);
      const candidate = submissions.find((r) => r.caseId === c.caseId && r.armId === arm.id);
      const b = adjudications.outcomes.find((r) => r.blindId === base?.blindId);
      const a = adjudications.outcomes.find((r) => r.blindId === candidate?.blindId);
      if (!a || !b || [a.outcome, b.outcome].includes('unresolved')) continue;
      cases++; acceptedDelta += Number(a.outcome === 'accepted') - Number(b.outcome === 'accepted');
      if (base.measuredCost !== null && candidate.measuredCost !== null && base.currency === 'USD' && candidate.currency === 'USD'
        && costBasis(base) !== 'unknown' && costBasis(base) === costBasis(candidate)) {
        costPairs++; knownCostDeltaUSD += candidate.measuredCost - base.measuredCost;
        const basis = costBasis(base);
        const group = costDeltas.get(basis) || { currency: 'USD', costBasis: basis, pairs: 0, delta: 0 };
        group.pairs++; group.delta += candidate.measuredCost - base.measuredCost; costDeltas.set(basis, group);
      }
    }
    paired[arm.id] = { cases, acceptedDelta, costPairs, knownCostDeltaUSD: costDeltas.size > 1 ? null : knownCostDeltaUSD,
      costDeltas: [...costDeltas.values()] };
  }
  return { version: 2, experimentId: manifest.experimentId, digest: manifest.digest, cohort: counts, arms, paired,
    recommendation: 'collect-data-and-human-review', automaticChanges: false,
    limitations: [
      'Offline blind acceptance is not human-accepted delivered change or lifetime cost.',
      '30–50 stratified pilot items are a baseline, not evidence of rare-defect safety.',
      'Missing, rejected, mixed, timeout and error cases remain in cohort denominators.',
      'False negatives require independently adjudicated complete reference truth; unknown truth is excluded and counted.',
      'Decision errors use complete independent reference truth with structured severity; HIGH/CRITICAL blocks. Review-quality acceptance is not a gate expectation. Missing verdict/severity stays unknown; prose is never parsed.',
      'Cost totals are qualified by currency and accounting basis; list, runtime and synthetic costs are not invoices. Linked inclusive parents replace children.',
      'No automatic model, reviewer, routing, policy or evidence changes.',
    ] };
}

export function renderExperimentReport(report) {
  return ['# Offline calibration report', '', `Experiment: ${report.experimentId} (${report.digest})`, '',
    `Frozen cohort: ${JSON.stringify(report.cohort)}`, '',
    '| Arm | Baseline | Completed / cohort | Blind accepted | Rejected | Mixed | Unresolved | Known USD | USD / blind accepted | Missed / reference findings |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(report.arms).map(([id, r]) => `| ${id} | ${r.baseline} | ${r.completed}/${r.cases} | ${r.accepted} | ${r.rejected} | ${r.mixed} | ${r.unresolved} | ${r.knownCostUSD} | ${r.costPerBlindAccepted ?? 'unknown'} | ${r.falseNegatives}/${r.referenceFindings} (${r.truthCases} truth-covered cases) |`), '',
    ...Object.entries(report.arms).flatMap(([id, r]) => [
      `## ${id}: coverage and reviewer value`, '',
      `Actual model known: ${r.actualModelCoverage}/${r.cases}. Escaped defects known: ${r.escapedDefectsKnown}; unknown cases: ${r.escapedDefectsUnknown}. Correction minutes known: ${r.correctionMinutesKnown}.`, '',
      `Decision metrics: ${JSON.stringify(r.decisions)}`, '',
      `Accounting (currency/basis, role/model/runtime): ${JSON.stringify(r.accounting)}`, '',
      '| Metric | Known / cohort | Known subtotal |', '|---|---|---|',
      ...Object.entries(r.metrics).map(([key, m]) => `| ${key} | ${m.known}/${m.total} | ${m.subtotal} |`), '',
      '| Role | Valid | Exclusive valid | False positives | Unresolved |', '|---|---|---|---|---|',
      ...Object.entries(r.findings.perRole).map(([role, f]) => `| ${role} | ${f.valid} | ${f.uniqueValid} | ${f.falsePositives} | ${f.unresolved} |`), '',
      `Valid reviewer overlap: ${JSON.stringify(r.findings.overlap)}`, '',
    ]),
    `Paired comparisons: ${JSON.stringify(report.paired)}`, '',
    ...report.limitations.map((line) => '- ' + line), '',
    'Decision: collect data and obtain human review; automaticChanges=false.',
  ].join('\n');
}
