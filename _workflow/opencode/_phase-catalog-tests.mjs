import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './identity.mjs';
import { validateNamed } from './schemas.mjs';
import { nativeProbeCalls } from './native-checks.mjs';
import { shadowSnapshot } from './shadow-scan.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtime = join(root, '_workflow/opencode/runtime.mjs');
const temp = mkdtempSync(join(tmpdir(), 'phase-catalog-'));
const phases = ['plan', 'plan-steps-nudge', 'plan_review', 'plan_revision', 'test', 'fix',
  'edgescan', 'edgescan_amend', 'edgescan_rescan', 'acceptance', 'acceptance_amend', 'acceptance_reprobe',
  'plancommit', 'plancommit_amend', 'plancommit_reprobe', 'ledger_anchor_classify', 'leftover_classify',
  'editorial', 'shadow_scan', 'native_checks', 'native_amend', 'realinfra_adjudicate', 'plan_deviation_adjudicate',
  'gates', 'gates_adjudicate', 'gates_regate', 'po', 'refute_reaudit', 'integrate_judge', 'decision_frame'];
const samples = {
  PLAN_SCHEMA: { rootCause: 'r', approach: 'MUST validate incoming values', recommendScopeStop: false, recommendEscalate: false, steps: ['Validate incoming values before processing', 'Add regression coverage for invalid values'] },
  PLAN_STEPS_NUDGE_SCHEMA: { steps: ['Validate incoming values before processing', 'Add regression coverage for invalid values'], note: 'decomposed' },
  TEST_SCHEMA: { red: true, note: 'red proven', testFiles: ['A.cs'], runCmd: 'red A.sln Filter' },
  FIX_SCHEMA: { applied: true, scopeStop: false, summary: 'fixed' },
  GATE_SCHEMA: { gate: 'fixture', verdict: 'APPROVED', headline: 'verified' },
  ACCEPT_SCHEMA: { covered: true }, PLAN_COMMITMENT_SCHEMA: { honored: true },
  LEDGER_ANCHOR_SCHEMA: { clean: true }, LEFTOVER_SCHEMA: { clean: true }, RED_COVERAGE_SCHEMA: { covered: true },
  ADJUDICATE_SCHEMA: { verdict: 'OVERRULED', headline: 'verified deviation', reasons: ['concrete independent evidence'] },
  REFUTE_SCHEMA: { refuted: false, headline: 'holds' },
  REAUDIT_SCHEMA: { converged: true, findingGone: true, headline: 'gone' },
  INTEG_SCHEMA: { globalGreen: true, regressionDelta: 0, handoff: 'ready' },
  DECISION_SCHEMA: { decision: 'stop', recommendation: 'stop', headline: 'owner required' },
  SHADOW_SCAN_SCHEMA: { acceptanceCovered: true, planHonored: true, findingHonored: true },
};
const ids = [];
const run = args => execFileSync(process.execPath, [runtime, ...args], { encoding: 'utf8', env: { ...process.env, FACTORY_TELEMETRY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let submissions = 0;
try {
  const source = readFileSync(runtime, 'utf8');
  const handled = [...new Set([...source.matchAll(/phaseKey === '([^']+)'/g)].map(m => m[1]))];
  assert.deepEqual([...phases].sort(), handled.sort(), 'catalog covers every result-consuming phase');
  for (const phase of phases) {
    const id = 'PHASE-' + process.pid + '-' + phase; ids.push(id);
    const dir = join(root, 'state/items', id), fx = join(temp, id + '.json');
    writeFileSync(fx, JSON.stringify({ item: { id, target: 'Fixture', fixType: 'mechanical', severity: 'CRITICAL', theme: 'security', files: ['A.cs', 'README.md'], acceptance: 'Every caller rejects invalid input; valid input succeeds.' }, worktreePath: temp, cycle: 1 }));
    run(['init', id, '--fixture', fx]);
    const path = join(dir, 'opencode-progress.json'), p = JSON.parse(readFileSync(path));
    p.phase = phase; p.band = 'FULL'; p.res.band = 'FULL'; p.reFix = phase === 'native_checks';
    p.plan = samples.PLAN_SCHEMA; p.test = { ...samples.TEST_SCHEMA, realInfraOverride: 'pure formatting logic' };
    p._blockReason = 'owner ruling'; p._adjudicateExtra = 'independent review';
    p._regateCalls = [{ role: 'gate-developer', phaseLabel: 'Gates', schema: 'GATE_SCHEMA', extra: 'regate' }];
    p._failedForRegate = [{ role: 'gate-developer', key: 'gate:developer' }];
    p._ledgerAnchorHits = [{ kind: 'tag', anchor: 'A', file: 'README.md', tagFound: false }];
    p._leftoverHits = [{ file: 'A.cs', lexeme: 'TODO', text: '// TODO' }];
    p.planDeviations = [{ commitment: 'step', reason: 'unnecessary' }];
    p.shadowSnapshot = shadowSnapshot(p, 'diff', 'prior');
    p.shadowResume = 'acceptance';
    p.evidence = { complete: true, ...p.content, rawHash: digest('verify') };
    p.integrationEvidence = { complete: true, ...p.content, rawHash: digest('integrate') };
    writeFileSync(join(dir, 'verify-raw.txt'), 'verify'); writeFileSync(join(dir, 'integrate-raw.txt'), 'integrate');
    writeFileSync(join(dir, 'feedback.md'), 'Prior finding requiring current evidence');
    writeFileSync(path, JSON.stringify(p));
    const next = JSON.parse(run(['next', id]));
    assert.ok(next.agents?.length, phase + ' reachable dispatch');
    for (const call of next.agents) {
      const result = samples[call.schema]; assert.ok(result, phase + ' schema fixture');
      assert.ok(validateNamed(call.schema, result).ok, phase + ' registered schema accepts result');
      const prompt = JSON.parse(readFileSync(call.promptRef));
      assert.ok(prompt.prompt.includes('OUTPUT CONTRACT'), 'actual composed output contract');
      const answer = join(temp, 'answer.json'); writeFileSync(answer, JSON.stringify(result));
      run(['submit', id, '--role', call.key, '--dispatch', call.dispatchId, '--json', answer]); submissions++;
    }
    const after = JSON.parse(readFileSync(path));
    assert.equal(after.pendingSet, null, phase + ' fully satisfied submission advances');
    for (const call of next.agents) {
      const key = 'stage:' + phase + ':' + call.key;
      assert.ok(after.res.artifacts[key], phase + ' role artifact registered');
      const artifact = join(root, after.res.artifacts[key]);
      assert.ok(existsSync(artifact), phase + ' role artifact exists');
      assert.deepEqual(JSON.parse(readFileSync(artifact)), samples[call.schema], phase + ' role result persisted exactly');
    }
  }
  assert.throws(() => nativeProbeCalls({ reFix: true, res: {} }, ''), /feedback missing/);
  assert.ok(nativeProbeCalls({ res: { codeChange: true }, item: {} }).some(c => c.role === 'red-coverage-probe'), 'missing optional runCmd cannot skip RED coverage');
  console.log(`Phase catalog: ${phases.length} agent phases, ${submissions} actual CLI submissions; zero unreachable schemas or missing role artifacts`);
} finally {
  for (const id of ids) rmSync(join(root, 'state/items', id), { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
}
