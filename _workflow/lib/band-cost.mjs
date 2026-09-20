export function projectedCallBreakdown(item = {}, band, conditions = {}) {
  const full = band === 'FULL';
  const files = (item.files || []).map((f) => f.replace(/\\/g, '/'));
  const docFile = (f) => /\.md$/i.test(f) || /(^|\/)docs?\//i.test(f);
  const code = files.length ? files.some((f) => !docFile(f)) : true;
  const codeChange = conditions.codeChange ?? (files.length ? files.some((f) => /\.cs$/.test(f)) : true);
  const doc = files.some(docFile);
  const planner = item.fixType === 'mechanical' ? 0 : 3;
  const lenses = new Set(['code']);
  if (full) {
    const theme = (item.theme || '').toLowerCase();
    if (/security|auth|crypto|multitenan|token|secret/.test(theme)) lenses.add('security');
    if (/concurren|idempoten|race|dataflow|money|payment|financ/.test(theme)) lenses.add('edge-case');
    if (/architect|layer|design|cross-service|contract/.test(theme) || item.severity === 'CRITICAL') lenses.add('architecture');
  }
  const components = {
    admission: 1,
    implementation: 4,
    initialVerificationPreparation: 1,
    integrationPreparation: codeChange ? 1 : 0,
    checkpoints: 5,
    postPlanCheckpoint: planner ? 1 : 0,
    postTestCheckpoint: planner ? 0 : 1,
    planAndTwoReviews: planner,
    roleGates: full ? (item.gateSet?.length || 5) : 2,
    methodReviews: code ? 3 : 2,
    editorial: doc ? 2 : 0,
    earlyEdge: code ? 1 : 0,
    redProof: codeChange && conditions.redProofFallback === true ? 1 : 0,
    rootCause: codeChange && conditions.rootCauseFallback === true ? 1 : 0,
    leftover: codeChange ? 1 : 0,
    evidenceIdentity: conditions.identityCalls ?? 4,
    refuter: full || conditions.needsRealInfra === true ? 1 : 0,
    reaudit: lenses.size,
  };
  for (const name of ['redCoverage', 'acceptanceScan', 'planCommitment', 'efProbe', 'breadthProbe', 'ledgerProbe', 'commentProbe', 'shadowScan', 'realInfraMarker', 'mainDriftProbe', 'priorFindingProbe']) {
    components[name] = conditions[name] === true ? 1 : 0;
  }
  if (!Number.isInteger(components.evidenceIdentity) || components.evidenceIdentity < 0) throw new TypeError('identityCalls must be a nonnegative integer');
  return { total: Object.values(components).reduce((sum, n) => sum + n, 0), components,
    assumptions: 'Fresh successful native item path; one physical invocation per dispatch; default review flows; four evidence collectors unless overridden; one predispatch admission relay, five later checkpoints plus post-plan when planning or post-test otherwise. Initial verification preparation always runs; integration preparation runs for codeChange. Collectors subsume RED/rootcause relays unless explicit fallback flags are set. No reuse, retries, fallback, amendments, adjudication, plan nudge or final-verification refresh. Conditional probes count only when explicitly enabled; absent files assume code. Early failure and reuse may cost less. SWEEP site admission requires separate calibration.' };
}

export function projectedCalls(item, band, conditions) {
  return projectedCallBreakdown(item, band, conditions).total;
}

export function projectBatch(items, bandOf, conditionsOf) {
  const byBand = {};
  let total = 0;
  for (const wi of items || []) {
    const b = (bandOf ? bandOf(wi) : 'LIGHT') === 'FULL' ? 'FULL' : 'LIGHT';
    const c = projectedCalls(wi, b, conditionsOf ? conditionsOf(wi) : undefined);
    const slot = byBand[b] = byBand[b] || { items: 0, calls: 0 };
    slot.items += 1;
    slot.calls += c;
    total += c;
  }
  return { total, byBand };
}

export function renderProjection(proj) {
  if (!proj || !proj.total) return '';
  const parts = ['LIGHT', 'FULL'].filter((b) => proj.byBand[b])
    .map((b) => `${proj.byBand[b].items} ${b} x ~${Math.round(proj.byBand[b].calls / proj.byBand[b].items)}`);
  return `projected ~${proj.total} native agent invocations (${parts.join(' + ')}) — conditional fresh-success floor including predispatch admission, initial verification preparation, code integration preparation, four evidence collectors, five later checkpoints plus post-plan or post-test, and two fresh-plan reviews; collectors subsume RED/rootcause relays. Retries/amends/adjudication and enabled probes add calls. Reuse or early failure can cost less. Physical invocations are not legacy successful-call cost maps, API requests, tokens or bills.`;
}
