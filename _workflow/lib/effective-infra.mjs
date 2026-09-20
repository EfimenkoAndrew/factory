export function effectiveInfraRequirement(result, originalRequirement) {
  const c = result && result.infraClassification;
  if (!c) return originalRequirement === true || !!(result && result.needsRealInfra);
  if (c.version !== 1 || typeof c.original !== 'boolean' || typeof c.effective !== 'boolean') return true;
  if (!c.original) return originalRequirement === true || !!result.needsRealInfra || c.effective;
  const a = c.adjudication;
  const key = 'adjudicator:realinfra-override';
  const detail = result.gateDetails && result.gateDetails[key];
  return !(c.effective === false && a && a.verdict === 'OVERRULED' && typeof a.reason === 'string' && a.reason.trim() && typeof a.headline === 'string' && a.headline.trim() && Array.isArray(a.reasons) && a.reasons.length > 0 && a.reasons.every(r => typeof r === 'string' && r.trim()) && result.gates && result.gates[key] === 'OVERRULED' && detail && detail.verdict === a.verdict && detail.headline === a.headline && JSON.stringify(detail.reasons) === JSON.stringify(a.reasons));
}
