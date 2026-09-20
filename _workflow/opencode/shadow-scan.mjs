import { digest } from './identity.mjs';
import { splitAcceptanceClauses } from '../lib/acceptance.mjs';
import { normalizePlanSteps, hasPlanCommitmentLanguage } from '../lib/plan-commitment.mjs';

export function shadowEligible(progress) {
  const plan = progress.plan;
  return progress.policies?.shadowConsolidatedScan === true && !progress.verificationOnly && progress.reFix &&
    splitAcceptanceClauses(progress.item.acceptance, 8).length >= 2 && !!plan &&
    (normalizePlanSteps(plan.steps, 8).length >= 2 || hasPlanCommitmentLanguage((plan.approach || '') + '\n' + (plan.blastRadius || '')));
}

export function shadowSnapshot(progress, pack, feedback) {
  const inputs = { contentHash: progress.content?.hash, contractHash: progress.contractHash,
    acceptance: splitAcceptanceClauses(progress.item.acceptance, 8), plan: progress.plan, feedback, pack,
    calls: originalScanCalls(progress) };
  return { version: 1, snapshotId: digest(inputs), runId: progress.runId, claimId: progress.claimId,
    itemId: progress.id, beforeAmendment: true, inputs };
}

export function priorFindingPrompt(feedback) {
  return 'Independently verify each PRIOR finding against the CURRENT worktree and review-pack.md. Prior findings are hypotheses; do not copy them as conclusions. Check current findings above any ## PRIOR CYCLE(S)\' FEEDBACK divider. honored=false for any unresolved defect (including verification-only items). Return concrete gaps. Do not edit anything.\nPRIOR FEEDBACK:\n' + feedback;
}

export function originalScanCalls(progress) {
  const plan = progress.plan || {}, steps = normalizePlanSteps(plan.steps, 8);
  const common = 'Read the CURRENT worktree and ' + progress.ctx.factoryRoot + '/state/items/' + progress.id + '/review-pack.md. Judge concrete evidence, never promises. Do not edit source, pack or feedback, and do not read other probe verdicts or dispatch artifacts. ';
  return [
    { role: 'acceptance-probe', schema: 'ACCEPT_SCHEMA', extra: common + 'ACCEPTANCE CLAUSE COVERAGE PROBE. covered=true only if EVERY clause has evidence. CLAUSES: ' + JSON.stringify(splitAcceptanceClauses(progress.item.acceptance, 8)) },
    { role: 'plan-commitment-probe', schema: 'PLAN_COMMITMENT_SCHEMA', extra: common + (steps.length >= 2 ? 'PLAN-STEP SCAN: honored=true only if EVERY step has evidence. STEPS: ' + JSON.stringify(steps) : 'PLAN-COMMITMENT SCAN: honored=true only if EVERY MUST/required commitment has evidence. PLAN TEXT: ' + (plan.approach || '') + '\n' + (plan.blastRadius || '')) },
  ];
}

export function shadowCalls(snapshot) {
  const originals = [...snapshot.inputs.calls, { role: 'prior-finding-probe', schema: 'PLAN_COMMITMENT_SCHEMA', extra: priorFindingPrompt(snapshot.inputs.feedback) }];
  return [...originals,
    { role: 'consolidated-scan-shadow', schema: 'SHADOW_SCAN_SCHEMA', extra: 'OBSERVATIONAL BLINDED PRE-AMENDMENT SCAN. Independently judge these THREE original probe contracts against the SAME current snapshot. Do not read original verdicts or edit anything. Return ALL THREE independent booleans: acceptanceCovered, planHonored, findingHonored.\n' + originals.map(c => c.extra).join('\n') },
  ].map(c => ({ ...c, phaseLabel: 'EdgeScan' }));
}

export function shadowComparison(snapshot, received, failures = {}) {
  const merged = received['consolidated-scan-shadow'];
  const axes = {};
  for (const [axis, role, field] of [['acceptanceCovered', 'acceptance-probe', 'covered'], ['planHonored', 'plan-commitment-probe', 'honored'], ['findingHonored', 'prior-finding-probe', 'honored']]) {
    const separate = received[role]?.[field], consolidated = merged?.[axis];
    axes[axis] = { separate: typeof separate === 'boolean' ? separate : null, consolidated: typeof consolidated === 'boolean' ? consolidated : null,
      verdict: typeof separate !== 'boolean' || typeof consolidated !== 'boolean' ? 'SKIPPED' : separate === consolidated ? 'AGREE' : 'DISAGREE' };
  }
  const values = Object.values(axes);
  const verdict = values.some(a => a.verdict === 'SKIPPED') ? 'SKIPPED' : values.every(a => a.verdict === 'AGREE') ? 'AGREE' : 'DISAGREE';
  return { ...snapshot, observational: true, verdict, axes, failures, responses: received };
}
