export const COST_BASES = ['invoice', 'list-equivalent', 'runtime-reported', 'synthetic', 'unknown'];

export function costBasis(row) {
  return COST_BASES.includes(row.costBasis) ? row.costBasis : 'unknown';
}

export function aggregateCosts(rows, { eligible = () => true, expected = rows.length } = {}) {
  const keyOf = r => JSON.stringify([r.runId ?? null, r.dispatchId ?? r.blindId ?? r.id]);
  const keyed = new Map(rows.map(r => [keyOf(r), r]));
  const conflicts = [], excluded = [], selected = [];
  for (const row of rows) {
    let current = row, covered = false;
    const seen = new Set([keyOf(row)]);
    while (current.costParentDispatchId != null) {
      const key = JSON.stringify([current.runId ?? null, current.costParentDispatchId]);
      const parent = keyed.get(key);
      if (!parent || seen.has(key) || parent.costIncludesChildren !== true) {
        conflicts.push(keyOf(row)); covered = true; break;
      }
      seen.add(key); covered = true; current = parent;
    }
    if (covered) excluded.push(keyOf(row)); else selected.push(row);
  }
  const measured = selected.filter(r => eligible(r) && Number.isFinite(r.measuredCost) && r.measuredCost >= 0
    && typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency));
  const group = (dimensions) => {
    const groups = new Map();
    for (const row of measured) {
      const identity = { currency: row.currency, costBasis: costBasis(row) };
      for (const dimension of dimensions) identity[dimension] = row[dimension] ?? null;
      const key = JSON.stringify(identity);
      const total = groups.get(key) || { ...identity, measuredCost: 0, records: 0, costSources: [] };
      total.measuredCost += row.measuredCost; total.records++;
      if (!total.costSources.includes(row.costSource ?? null)) total.costSources.push(row.costSource ?? null);
      groups.set(key, total);
    }
    return [...groups.values()];
  };
  const groups = group([]);
  const measurementComplete = rows.length === expected && selected.length > 0 && measured.length === selected.length && !conflicts.length;
  const basisComplete = groups.length === 1 && groups[0].costBasis !== 'unknown';
  return { version: 1, groups, byRole: group(['role']), byModel: group(['actualModel']), byRuntime: group(['runtimeVersion']),
    byBucket: group(['bucket']), measurementComplete, basisComplete, complete: measurementComplete && basisComplete,
    total: groups.length === 1 && !conflicts.length ? groups[0].measuredCost : null,
    currency: groups.length === 1 ? groups[0].currency : null, costBasis: groups.length === 1 ? groups[0].costBasis : null,
    selectedRecords: selected.length, measuredRecords: measured.length, excludedChildren: excluded, conflicts,
    attribution: 'Inclusive parent totals replace explicitly linked children; breakdowns describe selected totals, never allocated child costs.' };
}
