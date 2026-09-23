export const FINDING_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const CRITICAL_SEVERITIES = ['HIGH', 'CRITICAL'];
export const severityKnown = value => FINDING_SEVERITIES.includes(value);

export function verdictValue(raw) {
  if (raw === 'APPROVED') return 'approved';
  if (raw === 'CHANGES_REQUIRED') return 'blocked';
  return 'unknown';
}

export function reviewDecision(rawVerdict = null) {
  return { version: 1, rawVerdict, verdict: verdictValue(rawVerdict), rule: 'single' };
}

export function portfolioDecision(sources) {
  const values = sources.map(s => verdictValue(s.rawVerdict));
  return { version: 1, rawVerdict: null, rule: 'conservative-dissent',
    verdict: values.includes('blocked') ? 'blocked' : values.length && values.every(v => v === 'approved') ? 'approved' : 'unknown',
    sources: sources.map(s => ({ role: s.role, rawVerdict: s.rawVerdict ?? null })) };
}

export function validateDecision(decision) {
  if (decision === undefined || decision === null) return true;
  if (decision.version !== 1 || !['single', 'conservative-dissent'].includes(decision.rule)
    || !(decision.rawVerdict === null || typeof decision.rawVerdict === 'string')) return false;
  if (decision.rule === 'single') return decision.verdict === verdictValue(decision.rawVerdict) && decision.sources === undefined;
  if (!Array.isArray(decision.sources) || !decision.sources.length || decision.rawVerdict !== null
    || decision.sources.some(s => !s || typeof s.role !== 'string' || !s.role.trim()
      || !(s.rawVerdict === null || typeof s.rawVerdict === 'string'))
    || new Set(decision.sources.map(s => s.role)).size !== decision.sources.length) return false;
  return decision.verdict === portfolioDecision(decision.sources).verdict;
}

export function severityDecision(findings) {
  if (!Array.isArray(findings)) return 'unknown';
  if (findings.some(f => CRITICAL_SEVERITIES.includes(f.severity))) return 'blocked';
  return findings.every(f => severityKnown(f.severity)) ? 'approved' : 'unknown';
}

export function referenceDecision(truth) {
  if (!truth?.complete) return 'unknown';
  if (!truth.validFindingIds.length) return 'approved';
  const severities = truth.findingSeverities || [];
  const findings = truth.validFindingIds.map(id => severities.find(f => f.canonicalFindingId === id));
  if (findings.some(f => !f || !severityKnown(f.severity))) return 'unknown';
  return severityDecision(findings);
}

export function decisionMetrics(cases, rows, truth, includeRoles = true) {
  const details = cases.map(c => {
    const row = rows.find(r => r.caseId === c.caseId);
    const decision = row?.status === 'completed' ? row.decision?.verdict ?? 'unknown' : 'unknown';
    const expected = referenceDecision(truth.find(t => t.caseId === c.caseId));
    const own = row?.status === 'completed' ? severityDecision(row.findings) : 'unknown';
    return { caseId: c.caseId, decision, expected,
      falseApprove: decision === 'unknown' || expected === 'unknown' ? null : decision === 'approved' && expected === 'blocked',
      falseBlock: decision === 'unknown' || expected === 'unknown' ? null : decision === 'blocked' && expected === 'approved',
      inconsistent: decision === 'unknown' || own === 'unknown' ? null : decision !== own,
      dissent: row?.decision?.sources ? new Set(row.decision.sources.map(s => verdictValue(s.rawVerdict)).filter(v => v !== 'unknown')).size > 1 : false };
  });
  const byRole = Object.create(null);
  if (includeRoles) for (const role of new Set(rows.flatMap(r => r.decision?.sources?.map(s => s.role) || []))) {
    const roleRows = rows.map(r => ({ ...r,
      decision: reviewDecision(r.decision?.sources?.find(s => s.role === role)?.rawVerdict ?? null),
      findings: r.findings.filter(f => f.role === role) }));
    byRole[role] = decisionMetrics(cases, roleRows, truth, false);
  }
  return { policy: 'HIGH-or-CRITICAL-blocks', criticalSeverity: CRITICAL_SEVERITIES, cases: cases.length,
    decisionKnown: details.filter(d => d.decision !== 'unknown').length,
    truthKnown: details.filter(d => d.expected !== 'unknown').length,
    scored: details.filter(d => d.falseApprove !== null).length,
    unknown: details.filter(d => d.falseApprove === null).length,
    falseApprove: details.filter(d => d.falseApprove === true).length,
    falseBlock: details.filter(d => d.falseBlock === true).length,
    inconsistent: details.filter(d => d.inconsistent === true).length,
    consistencyUnknown: details.filter(d => d.inconsistent === null).length,
    dissent: details.filter(d => d.dissent).length, details, ...(includeRoles ? { byRole } : {}) };
}
