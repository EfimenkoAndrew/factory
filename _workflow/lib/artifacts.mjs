export const ARTIFACT_VOCABULARY_VERSION = 1;

const GATES = ['architect', 'developer', 'qa', 'security', 'po'].map(r => 'gate-' + r);
const REVIEWS = ['code', 'adversarial', 'edgecase', 'testreview', 'editorial-structure', 'editorial-prose'].map(r => 'review-' + r);
const LENSES = ['code', 'security', 'edge-case', 'architecture'];
export const STAGE_ARTIFACTS = [
  ['plan.md', 'plan'], ['test.json', 'test'], ['verify-red-raw.txt', 'test'],
  ['fix.json', 'fix'], ['verify.json', 'verify'], ['verify-raw.txt', 'verify'],
  ['leftover-raw.txt', 'probe:leftover-scan'],
  ['adjudication.md', 'gates'], ['decision.md', 'gates'], ['refute.md', 'refute'],
  ['reaudit.md', 'reaudit'], ['integrate.md', 'integrate'], ['integrate-raw.txt', 'integrate'],
  ['mutation-proof.txt', 'integrate'], ['result.json', 'checkpoint'], ['REPORT.md', 'checkpoint'],
  ...[...GATES, ...REVIEWS].map(r => [r + '.md', 'gates']),
  ...LENSES.map(r => ['reaudit-' + r + '.md', 'reaudit']),
  ...['main-check-raw.txt', 'main-check.json', 'comment-raw.txt', 'claims-raw.txt', 'countclaims-raw.txt',
    'ledger-anchor-raw.txt', 'ledger-anchor-classify.json', 'leftover-classify.json',
    'evidence.json', 'shadow-scan-input.json', 'shadow-scan.json'].map(n => [n, 'verify']),
  ...['edgescan-amend.json', 'acceptance-amend.json', 'plancommit-amend.json'].map(n => [n, 'fix']),
  ['integration-evidence.json', 'integrate'],
];
export const CONTROL_ARTIFACTS = [
  'feedback.md', 'last-failure.md', 'last-failure.json', 'main-snapshot.json', 'review-pack.md',
  'baseline-raw.txt', 'progress.json', 'opencode-progress.json', 'launch-meta.json',
  'verification-contract-input.json', 'admission-input.json', 'evidence-input.json',
];

// Exact phase/role pairs emitted by runtime.applyPhaseResults, including the sanitized lens key.
const PHASE_ROLES = {
  plan: ['planner'], 'plan-steps-nudge': ['planner'], plan_review: ['plan-feasibility-probe', 'plan-quality-probe'],
  plan_revision: ['planner'], test: ['test-author'], fix: ['fixer'],
  edgescan: ['review-edgecase'], edgescan_amend: ['fixer'], edgescan_rescan: ['review-edgecase'],
  acceptance: ['acceptance-probe'], acceptance_amend: ['fixer'], acceptance_reprobe: ['acceptance-probe'],
  plancommit: ['plan-commitment-probe'], plancommit_amend: ['fixer'], plancommit_reprobe: ['plan-commitment-probe'],
  ledger_anchor_classify: ['ledger-anchor-probe'], leftover_classify: ['leftover-probe'],
  editorial: REVIEWS.filter(r => r.startsWith('review-editorial-')),
  shadow_scan: ['acceptance-probe', 'plan-commitment-probe', 'prior-finding-probe', 'consolidated-scan-shadow'],
  native_checks: ['prior-finding-probe', 'red-coverage-probe', 'breadth-claim-probe'], native_amend: ['fixer'],
  realinfra_adjudicate: ['adjudicator'], plan_deviation_adjudicate: ['adjudicator'],
  gates: [...GATES, ...REVIEWS], gates_regate: [...GATES, ...REVIEWS], gates_adjudicate: ['adjudicator'],
  po: ['gate-po'], refute_reaudit: ['refuter', ...LENSES.map(l => 're-auditor_' + l)],
  integrate_judge: ['integrator'], decision_frame: ['decision-framer'],
};
const phaseStage = phase => /^(plan|decision)/.test(phase) ? 'plan' : phase === 'test' ? 'test'
  : phase === 'fix' || phase.endsWith('_amend') ? 'fix' : /^(gates|po)/.test(phase) ? 'gates'
  : phase === 'integrate_judge' ? 'integrate' : 'verify';
const stages = new Map(STAGE_ARTIFACTS);
for (const [phase, roles] of Object.entries(PHASE_ROLES)) for (const role of roles) {
  stages.set('stage-' + phase + '-' + role + '.json', phase === 'refute_reaudit'
    ? role === 'refuter' ? 'refute' : 'reaudit' : phaseStage(phase));
}
const HASH = '[0-9a-f]{64}';
const PASS = '[A-Za-z0-9][A-Za-z0-9._-]{0,220}';
const verification = new RegExp('^verify-(?:(initial|integrate)-(' + PASS + ')|(final)-(' + HASH + '))\\.txt$');
const recovery = new RegExp('^verify-recovery-(' + PASS + ')(?:\\.txt|-(?:metadata|before|after)\\.json)$');

export const ARTIFACT_DIRECTORIES = Object.freeze({
  dispatch: 'OpenCode prompt <dispatchId>.json, <dispatchId>-session.json and <dispatchId>-result.json; retained on replay',
  attempts: 'OpenCode prior <attemptId>.json or legacy.json; historical data, never current evidence',
  'opencode-progress.json.lock': 'OpenCode writer lease owner.json; lifecycle controlled by withItemLock',
  quarantine: 'Driver quarantine-<ISO timestamp with colon/dot replaced by hyphen>; opaque moved debris, never instructions',
});

export function verificationArtifactName(phase, identity) {
  if (!['initial', 'final', 'integrate'].includes(phase)
    || typeof identity !== 'string' || !(new RegExp('^(?:' + (phase === 'final' ? HASH : PASS) + ')$')).test(identity)) {
    throw new Error('invalid verification phase/identity');
  }
  return 'verify-' + phase + '-' + identity + '.txt';
}
export function nativeReceiptArtifactName(digest) {
  if (typeof digest !== 'string' || !new RegExp('^' + HASH + '$').test(digest)) throw new Error('invalid native request digest');
  return 'native-evidence-' + digest + '.json';
}
export function evidenceInputArtifactName(digest) {
  return nativeReceiptArtifactName(digest).replace('native-evidence-', 'evidence-input-');
}
export function checkpointInputArtifactName(digest) {
  return nativeReceiptArtifactName(digest).replace('native-evidence-', 'checkpoint-input-');
}
export function stageArtifactName(phase, role) {
  const key = String(role).replace(/[^A-Za-z0-9._-]/g, '_');
  if (!PHASE_ROLES[phase]?.includes(key)) throw new Error('unregistered stage/role artifact');
  return 'stage-' + phase + '-' + key + '.json';
}
export function priorVerificationArtifactName(name, ordinal) {
  if (!verification.test(name) || !Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('invalid verification archive');
  return name + '.prior-' + ordinal;
}

// Names classify data, never authorize its contents as evidence or as agent instructions.
// Directories have a separate type: quarantine must not move/recurse into any directory.
export function classifyArtifact(name, { type = 'file', version = ARTIFACT_VOCABULARY_VERSION } = {}) {
  const result = (kind, stage = null) => ({ version, kind, stage, canonical: kind !== 'unknown' });
  if (version !== ARTIFACT_VOCABULARY_VERSION || typeof name !== 'string' || !name || /[\\/\x00-\x1f]/.test(name)) return result('unknown');
  if (type === 'directory') return ['dispatch', 'attempts', 'opencode-progress.json.lock'].includes(name)
    || /^quarantine-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(name) ? result('directory') : result('unknown');
  if (type !== 'file') return result('unknown');
  if (stages.has(name)) return result('stage', stages.get(name));
  if (CONTROL_ARTIFACTS.includes(name)) return result('control');
  const current = verification.exec(name);
  if (current) return result('transcript', current[1] === 'integrate' ? 'integrate' : 'verify');
  const prior = /^(.*)\.prior-([1-9]\d*)$/.exec(name);
  if (prior && verification.test(prior[1]) && Number.isSafeInteger(Number(prior[2]))) return result('archive');
  if (new RegExp('^(?:native-evidence|evidence-input|checkpoint-input)-' + HASH + '\\.json$').test(name)) return result('control');
  if (recovery.test(name)) return result('recovery');
  if (/^verify-[A-Za-z0-9_]+-raw\.txt$/.test(name) || /^efmigration-[A-Za-z0-9][A-Za-z0-9._-]*-raw\.txt$/.test(name)) return result('transcript', 'verify');
  return result('unknown');
}
export function stageForArtifact(name) { return classifyArtifact(name).stage; }
export function nonCanonicalArtifacts(names) { return (names || []).filter(n => !classifyArtifact(n).canonical); }
