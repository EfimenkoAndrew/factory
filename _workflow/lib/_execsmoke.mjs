// KI-L43 — EXECUTION smoke for factory.js.
//
// `node --check` is syntax-only: a temporal-dead-zone reference (KI-L36 — `RF` read above its
// `const` after a block reorder) parses clean, crashes at runtime, and burned two full item bands
// in cycle 24 before any agent ran. The lib self-test never executed factory.js (it is a Workflow
// script, not an importable module). This harness EXECUTES the script body in-process with stubbed
// agent/parallel/log/phase globals over a tiny synthetic batch, so any reference/TDZ/shape crash in
// the orchestration paths surfaces in milliseconds at self-test time — before a launcher is emitted.
//
// Faithful to the Workflow runtime: the script is wrapped in an AsyncFunction whose parameters are
// the runtime globals (same execution model — top-level `return` is legal), `export const meta` is
// neutralised to `const meta`, and `__FACTORY_BATCH__` stays undefined so the `args` path runs.
// Stubs return schema-shaped happy-path objects keyed off each call's schema properties; a
// label-predicate lets a test force CHANGES_REQUIRED on chosen gates to exercise the dispute lane.

// Build a schema-shaped stub reply for one agent() call. `blockedGate(label)` (optional) forces a
// CHANGES_REQUIRED verdict for matching gate/review calls — used to exercise the dispute/adjudicate
// lane without bespoke stubs per role.
export function defaultAgentStub(opts, blockedGate) {
  const s = (opts && opts.schema) || {};
  const p = s.properties || {};
  const req = s.required || [];
  const label = (opts && opts.label) || '';
  if (p.written) return { written: true };
  if (p.covered !== undefined) return { covered: true, gaps: [] }; // KI-E18 AcceptanceScan probe (happy path)
  if (p.red) return { red: true, testFiles: ['X/src/X.Tests/SomeTests.cs'], runCmd: 'stub', evidence: 'stub', note: 'stub' };
  if (p.applied) return { applied: true, filesChanged: ['X/src/Some.cs'], summary: 'stub', scopeStop: false, divergence: null, note: 'stub' };
  if (p.build) return { build: 'pass', targetedTest: 'pass', suite: { passed: 2, failed: 0, skipped: 0 }, realInfraExercised: false, debris: [], evidence: 'FACTORY::BUILD::RESULT exit=0 (stub)', note: 'stub' };
  if (req.includes('gate')) {
    const blocked = blockedGate && blockedGate(label);
    return blocked
      ? { gate: label, verdict: 'CHANGES_REQUIRED', findings: [{ severity: 'HIGH', title: 'stub finding', file: 'X/src/Some.cs', fix: 'stub fix' }], scopeViolation: false, acceptanceMet: false, redGreenConfirmed: true, headline: 'stub blocked' }
      : { gate: label, verdict: 'APPROVED', findings: [], scopeViolation: false, acceptanceMet: true, redGreenConfirmed: true, headline: 'stub ok' };
  }
  if (req.includes('verdict')) return { verdict: 'OVERRULED', reasons: ['stub'], headline: 'stub adjudication' }; // ADJUDICATE_SCHEMA
  if (p.refuted) return { refuted: false, headline: 'stub not refuted' };
  if (p.converged) return { converged: true, findingGone: true, newFindings: [], headline: 'stub converged' };
  if (p.globalGreen) return { globalGreen: true, branch: '', changedFiles: [], regressionDelta: 0, handoff: 'stub', note: 'stub' };
  if (p.rootCause) return { rootCause: 'stub', approach: 'stub', files: [], testStrategy: 'stub', blastRadius: 'stub', ruleRisks: 'stub', recommendEscalate: false, recommendScopeStop: false };
  if (req.includes('decision')) return { decision: 'stub', options: [], recommendation: 'stub', headline: 'stub' };
  if (p.pattern) return { pattern: 'stub', applicationNotes: 'stub', conformanceCheck: 'stub', headline: 'stub' };
  return { note: 'stub' };
}

// Execute the factory script source over `batch`. Returns { result, calls } where `calls` is every
// agent() invocation's { label, model }. Throws whatever the script throws (TDZ, ReferenceError…) —
// the caller's assertion IS that it does not throw and returns a sane result shape.
export async function execSmoke(factorySrc, batch, options) {
  const o = options || {};
  const src = factorySrc.replace(/^export const meta =/m, 'const meta =');
  if (/^export\s/m.test(src)) throw new Error('execSmoke: factory.js grew a second export — extend the neutraliser');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ label: (opts && opts.label) || '', model: (opts && opts.model) || 'inherit' });
    if (o.agentOverride) { const r = o.agentOverride(prompt, opts); if (r !== undefined) return r; }
    return defaultAgentStub(opts, o.blockedGate);
  };
  const parallel = async (thunks) => Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null)));
  const pipeline = async (items, ...stages) => {
    const out = [];
    for (let i = 0; i < (items || []).length; i++) {
      let v = items[i];
      try { for (const s of stages) v = await s(v, items[i], i); } catch { v = null; }
      out.push(v);
    }
    return out;
  };
  const log = () => {};
  const phase = () => {};
  const budget = o.budget || { total: null, spent: () => 0, remaining: () => Infinity }; // o.budget: KI-C2 — force the budget-active lane (total set, remaining inside the reserve)
  const workflow = async () => { throw new Error('workflow() unavailable in exec-smoke'); };
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', 'workflow', src);
  const result = await fn(agent, parallel, pipeline, log, phase, JSON.stringify(batch), budget, workflow);
  return { result, calls };
}

// The canonical smoke batch: four items covering the lanes that have historically crashed or
// regressed — (A) doc item: LIGHT band + the editorial lane (the KI-L36 TDZ site); (B) CRITICAL
// security code item: FULL band, full gate panel, refute + multi-lens re-audit, integrate, and the
// KI-L40 checkpoint; (C) CRITICAL code item with a forced single-gate dissent: the KI-C8
// adjudicate → re-gate lane; (D) verification-only reFix (KI-L37): fixer skipped, straight to
// verify + gates. Worktree paths are synthetic — stubs never touch the filesystem.
export function smokeBatch() {
  const wt = (id) => ({ path: '/tmp/exec-smoke-wt/' + id, branch: 'factory/' + id });
  const base = { target: 'X', layer: 'service', dependsOn: [], gateSet: [], autonomyTier: 'auto', source: 'smoke', solution: 'X/X.sln', peers: [] };
  return {
    cycle: 0, concurrency: 2, attempts: 1, repoRoot: '.', templatesDir: '_bmad-output/ai-factory/agents', config: {}, dryRun: false,
    items: [
      { ...base, id: 'SMOKE-DOC', title: 'doc drift', severity: 'HIGH', theme: 'doc-drift', fixType: 'doc-drift', files: ['doc/data-flows/X.md'], acceptance: 'doc fixed', regressionTest: 'grep', realInfra: false, worktree: wt('SMOKE-DOC') },
      { ...base, id: 'SMOKE-CODE', title: 'authz hole', severity: 'CRITICAL', theme: 'security-multitenancy', fixType: 'non-trivial', files: ['X/src/Some.cs'], acceptance: 'policy enforced', regressionTest: 'test', realInfra: false, worktree: wt('SMOKE-CODE') },
      { ...base, id: 'SMOKE-DISPUTE', title: 'ranking bug', severity: 'CRITICAL', theme: 'money-correctness', fixType: 'non-trivial', files: ['X/src/Other.cs'], acceptance: 'sums right', regressionTest: 'test', realInfra: false, worktree: wt('SMOKE-DISPUTE') },
      { ...base, id: 'SMOKE-VONLY', title: 'pre-applied refix', severity: 'HIGH', theme: 'deployability-oncall', fixType: 'config', files: ['k8s/base/x.yaml'], acceptance: 'manifest right', regressionTest: 'grep', realInfra: false, reFix: true, worktree: wt('SMOKE-VONLY') },
      // (E) KI-L57 pair: a gate returning {verdict:'APPROVED', scopeViolation:true} is
      // self-contradictory and must NOT hard-stop (SCOPEFLAG closes); a gate returning
      // {verdict:'CHANGES_REQUIRED', scopeViolation:true} is a genuine red-line and MUST
      // still block (SCOPESTOP → BLOCKED). Overrides live in the _selftest invocation.
      { ...base, id: 'SMOKE-SCOPEFLAG', title: 'stray scope flag', severity: 'HIGH', theme: 'doc-drift', fixType: 'doc-drift', files: ['doc/runbooks/x.md'], acceptance: 'runbook right', regressionTest: 'grep', realInfra: false, worktree: wt('SMOKE-SCOPEFLAG') },
      { ...base, id: 'SMOKE-SCOPESTOP', title: 'genuine red-line', severity: 'HIGH', theme: 'doc-drift', fixType: 'doc-drift', files: ['doc/runbooks/y.md'], acceptance: 'runbook right', regressionTest: 'grep', realInfra: false, worktree: wt('SMOKE-SCOPESTOP') },
    ],
  };
}
