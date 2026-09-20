// Read-only/in-memory prompt tests: no git commands, subprocesses, fixtures on disk or model calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { readRoleBriefs, readRepoProfiles, PROFILE_CAP } from './promptpack.mjs';
import { commonPromptPrefix, isMinimalPromptRole, selectRoleProfile } from './prompt-context.mjs';
import { compose, composeRequest, outputSchemaFor } from '../opencode/compose.mjs';
import { POLICY_TEXT } from './policy.mjs';
import { FIX_SCHEMA, PLAN_STEPS_NUDGE_SCHEMA, INTEG_SCHEMA, validate } from '../opencode/schemas.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const briefs = readRoleBriefs(join(root, 'agents'));
const ctx = {
  repoRoot: 'C:/host repo', worktreePath: 'C:/host repo/wt/A', factoryRoot: root,
  templatesDir: 'Z:/does-not-exist', briefs, repoProfiles: {}, policies: {},
};
const item = {
  id: 'A', target: 'Service', severity: 'HIGH', fixType: 'code', autonomyTier: 'auto',
  title: 'Fix the defect', acceptance: 'Actual acceptance', regressionTest: 'Actual regression',
  files: ['Service/CONTEXT.md'], docMap: ['Service/CONTEXT.md :: § Heading @L20'],
  peers: [{ id: 'B', files: ['PEER-CONTENT'] }], batchPattern: 'PATTERN-CONTENT',
  precedent: { id: 'P', fixJson: 'PRECEDENT-CONTENT' }, verifyNote: 'VERIFY-CAVEAT',
};

test('oversized briefs and profiles survive loader -> actual composition byte-for-byte', () => {
  const text = 'HEAD\r\n' + 'x'.repeat(PROFILE_CAP + 10000) + '\r\nMANDATORY-TAIL';
  const io = { readdirSync: () => ['fixer.md'], readFileSync: () => text };
  const loaded = readRoleBriefs('/virtual', io);
  assert.equal(loaded.fixer, text);
  const profiles = readRepoProfiles('/virtual', { ...io, readdirSync: () => ['Service.md'] });
  assert.equal(profiles.Service, text);
  const prompt = compose('fixer', item, 'PHASE-TAIL', { ...ctx, briefs: loaded, repoProfiles: profiles });
  assert.equal(prompt.split(text).length - 1, 2);
  assert.ok(prompt.includes('PHASE-TAIL'));
  assert.ok(prompt.indexOf('MANDATORY-TAIL') < prompt.indexOf('TARGET:'));
});

test('complete real briefs, especially previously truncated fixer tail, reach composed prompts', () => {
  const required = {
    fixer: ['SIBLING-PATTERN SWEEP', 'DEAD-CODE SELF-CHECK', 'CANCELLATIONTOKEN CHAIN SELF-CHECK',
      'PLAN-EXCLUSION ADHERENCE', 'filesChanged', 'I EDITED THIS', 'Deviating from the plan',
      'fix.json', 'scopeStop', 'divergence', 'deviations', 'EXACT original text', 'remove the persisted-shape change'],
    'test-author': ['MULTI-TARGET COVERAGE SELF-CHECK', 'REAL-SHAPE SEEDING', 'KEEP the prior test',
      'realInfraOverride', 'FACTORY::REALINFRA::Postgres', 'verify-red-raw.txt', 'test.json',
      'Do NOT modify product code', 'zero comments', 'full suite'],
    runner: ['DEBRIS-GUARD', 'Known-unresolved-findings check', 'FACTORY::REALINFRA::<kind>',
      'dockerAbsent', 'realInfraKind', 'baselineFailures', 'newFailures', 'verify.json', 'verify-raw.txt',
      'REVIEW PACK', 'MUST begin with literal `pass` or `fail`'],
    integrator: ['integrate.md', 'globalGreen', 'regressionDelta', 'handoff', 'Leave the worktree intact'],
  };
  for (const [role, needles] of Object.entries(required)) {
    const prompt = compose(role, item, null, ctx);
    assert.ok(prompt.includes(briefs[role]), role + ' complete brief');
    for (const needle of needles) assert.ok(prompt.includes(needle), role + ': ' + needle);
  }
});

test('actual native compose delivers loaded oversized brief and required fixer tail without filesystem access', () => {
  const source = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const start = source.indexOf('function compose(role, item, extra) {');
  const end = source.indexOf('\nfunction buildCommand(', start);
  assert.ok(start >= 0 && end > start, 'locate actual native compose');
  const huge = briefs.fixer + '\n' + 'x'.repeat(40000) + '\nNATIVE-MANDATORY-TAIL';
  const loaded = readRoleBriefs('/virtual', { readdirSync: () => ['fixer.md'], readFileSync: () => huge });
  const sandbox = vm.createContext({
    A: { briefs: loaded, repoProfiles: {}, policies: {} }, REPO: ctx.repoRoot,
    WT: { path: ctx.worktreePath }, FDIR: root, TPLDIR: ctx.templatesDir,
    itemsDir: () => root + '/state/items/A', needsWriteIsolation: () => false,
    buildCommand: () => 'node "' + root + '/_workflow/opencode/build-lease.mjs" "' + root + '"',
    commonPromptPrefix, isMinimalPromptRole, selectRoleProfile,
  });
  vm.runInContext(source.slice(start, end), sandbox);
  const prompt = sandbox.compose('fixer', item, 'NATIVE-PHASE-TAIL');
  assert.ok(prompt.includes(huge));
  assert.ok(prompt.includes('/_workflow/opencode/build-lease.mjs'));
  for (const needle of ['SIBLING-PATTERN SWEEP', 'DEAD-CODE SELF-CHECK', 'CANCELLATIONTOKEN CHAIN SELF-CHECK',
    'PLAN-EXCLUSION ADHERENCE', 'Deviating from the plan', 'fix.json', 'NATIVE-MANDATORY-TAIL', 'NATIVE-PHASE-TAIL']) assert.ok(prompt.includes(needle));
});

const profile = '# Profile\r\nPREAMBLE\r\n## General\r\nGENERAL\r\n'
  + '## Role: fixer\r\nFIX-ONLY\r\n### Details\r\nFIX-DETAILS\r\n'
  + '## Other general guidance\r\nGENERAL-AFTER\r\n'
  + '## Roles: test-author, gate-qa\r\nTEST-ONLY\r\n'
  + '## Roles: gate-*, review-*\r\nREVIEW-ONLY\r\n'
  + '## Role: common\r\nCOMMON\r\n'
  + '## Examples\r\n```md\r\n## Role: fixer\r\nEXAMPLE-IS-GENERAL\r\n```\r\n'
  + '## Tail\r\nGENERAL-TAIL\r\n';

test('profile selection retains all ordinary sections before, between and after scoped sections', () => {
  for (const role of ['fixer', 'test-author', 'gate-qa', 'review-code', 'planner']) {
    const selected = selectRoleProfile(profile, role);
    for (const general of ['PREAMBLE', 'GENERAL\r\n', 'GENERAL-AFTER', 'COMMON', 'EXAMPLE-IS-GENERAL', 'GENERAL-TAIL']) {
      assert.ok(selected.includes(general), role + ': ' + general);
    }
    assert.equal(selected.includes('FIX-ONLY'), role === 'fixer');
    assert.equal(selected.includes('FIX-DETAILS'), role === 'fixer');
    assert.equal(selected.includes('TEST-ONLY'), ['test-author', 'gate-qa'].includes(role));
    assert.equal(selected.includes('REVIEW-ONLY'), /^(gate-|review-)/.test(role));
    const prompt = compose(role, item, null, { ...ctx, repoProfiles: { Service: profile } });
    assert.ok(prompt.includes(selected));
  }
});

test('legacy, malformed, nested and fenced profiles never silently discard general guidance', () => {
  for (const text of ['PLAIN' + 'z'.repeat(40000) + 'TAIL', '## Role: ???\nKEEP\n',
    '## Role: fixer / runner\nKEEP\n', '~~~md\n## Role: fixer\nKEEP\n~~~\n']) {
    assert.equal(selectRoleProfile(text, 'runner'), text);
  }
  assert.equal(selectRoleProfile('## Role: fixer\nX\n### Role: runner\nY\n## General\nZ\n', 'runner'), '## General\nZ\n');
  assert.ok(selectRoleProfile('## Role: *\nALL\n', 'runner').includes('ALL'));
  assert.equal(selectRoleProfile('', 'runner'), '');
});

test('pure helper source executes unchanged in a filesystem-free native-style sandbox', () => {
  const source = readFileSync(new URL('./prompt-context.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  const sandbox = vm.createContext({});
  vm.runInContext(source, sandbox);
  for (const role of ['fixer', 'test-author', 'gate-qa', 'review-code', 'marker-probe', 'acceptance-probe']) {
    assert.equal(sandbox.selectRoleProfile(profile, role), selectRoleProfile(profile, role));
    assert.equal(sandbox.isMinimalPromptRole(role), isMinimalPromptRole(role));
  }
  assert.equal(sandbox.commonPromptPrefix(true), commonPromptPrefix(true));
  assert.equal(sandbox.commonPromptPrefix(false), commonPromptPrefix(false));
});

test('launch snapshots override current disk and explicit empty maps never fall back', () => {
  const diskCtx = { ...ctx, templatesDir: join(root, 'agents') };
  const prompt = compose('fixer', item, null, { ...diskCtx, briefs: { fixer: 'LAUNCH-BRIEF-TAIL' },
    repoProfiles: { Service: 'LAUNCH-PROFILE-TAIL' }, policies: { noNewComments: true, noSchemaChanges: true } });
  assert.ok(prompt.includes('LAUNCH-BRIEF-TAIL'));
  assert.ok(prompt.includes('LAUNCH-PROFILE-TAIL'));
  assert.ok(!prompt.includes(briefs.fixer));
  assert.ok(prompt.includes(POLICY_TEXT.noNewComments));
  assert.ok(prompt.includes(POLICY_TEXT.noSchemaChanges));
  assert.throws(() => compose('fixer', item, null, { ...diskCtx, briefs: {} }), /Launch snapshot/);
  const empty = compose('fixer', item, null, diskCtx);
  assert.ok(!empty.includes('REPO-SPECIFIC STYLE PROFILE (general'));
  assert.ok(!empty.includes(POLICY_TEXT.noNewComments));
  const { briefs: _briefs, repoProfiles: _profiles, ...legacy } = diskCtx;
  assert.ok(compose('fixer', item, null, legacy).includes(briefs.fixer));
});

test('stable common and role prefixes precede dynamic item data', () => {
  const a = compose('fixer', item, 'EXTRA-A', ctx);
  const b = compose('fixer', { ...item, id: 'B', title: 'Other', acceptance: 'Other acceptance' }, 'EXTRA-B', ctx);
  assert.equal(a.split('\nTARGET:')[0], b.split('\nTARGET:')[0]);
  const reviewer = compose('gate-qa', item, null, ctx);
  assert.equal(a.split('YOUR ROLE BRIEF')[0], reviewer.split('YOUR ROLE BRIEF')[0]);
  assert.ok(a.indexOf('OUTPUT CONTRACT') < a.indexOf('TARGET:'));
});

test('minimal relays omit irrelevant context and preserve isolation, evidence and exact task', () => {
  for (const role of ['marker-probe', 'red-proof-probe', 'rootcause-probe', 'pack-hash-probe', 'main-drift-probe', 'efmigration-probe', 'checkpoint-writer']) {
    const prompt = compose(role, item, 'EXACT-COMMAND-TAIL', { ...ctx, repoProfiles: { Service: 'PROFILE-NOISE' } });
    for (const forbidden of ['PROFILE-NOISE', 'DOC MAP', 'PEER-CONTENT', 'PRECEDENT-CONTENT', 'PATTERN-CONTENT',
      'Actual acceptance', 'WORKTREE STATE CHECK', 'diff HEAD', 'Read applicable .claude/rules']) assert.ok(!prompt.includes(forbidden), role + ': ' + forbidden);
    for (const required of ['ISOLATION', 'NEVER run mutating git', 'Never edit the ledger', 'STOP_REQUESTED.md',
      'EVIDENCE', 'No source edits', ctx.worktreePath, 'ARTIFACTS DIR', 'OUTPUT CONTRACT', 'EXACT-COMMAND-TAIL']) assert.ok(prompt.includes(required), role + ': ' + required);
  }
  for (const role of ['acceptance-probe', 'plan-commitment-probe', 'leftover-probe']) {
    const prompt = compose(role, item, null, { ...ctx, repoProfiles: { Service: 'SEMANTIC-GUIDANCE' } });
    assert.ok(prompt.includes('Actual acceptance'));
    assert.ok(prompt.includes('SEMANTIC-GUIDANCE'));
    assert.ok(!prompt.includes('TOOL RELAY:'));
  }
});

test('review uses pack before targeted verification without a mandatory full preliminary diff', () => {
  const prompt = compose('gate-developer', item, null, ctx);
  assert.ok(prompt.includes('/review-pack.md FIRST'));
  assert.ok(!prompt.includes('WORKTREE STATE CHECK:'));
  assert.ok(!prompt.includes('diff HEAD` before'));
  for (const required of ['VERIFY-CAVEAT', 'independently spot-verify', 'CURRENT WORKTREE', 'omitted/truncated',
    'Re-check verdict-dependent', 'PEER-OWNED SURFACES', 'takes PRECEDENCE', ctx.worktreePath + '/Service/CONTEXT.md']) assert.ok(prompt.includes(required));
});

test('handoff-only is explicit, fail-closed on stale evidence, and retains mandatory output contract', () => {
  const normal = composeRequest('integrator', item, null, ctx);
  assert.ok(!normal.prompt.includes('INTEGRATOR MODE: HANDOFF-ONLY.'));
  const handoff = composeRequest('integrator', item, 'SNAPSHOT-EVIDENCE', ctx, { handoffOnly: true });
  assert.equal(handoff.outputSchema, INTEG_SCHEMA);
  for (const required of ['INTEGRATOR MODE: HANDOFF-ONLY.', 'do NOT repeat build/suite', 'globalGreen=false',
    'controller re-verification', 'integrate.md', 'SNAPSHOT-EVIDENCE', 'regressionDelta']) assert.ok(handoff.prompt.includes(required));
});

test('caller receives exact phase schema; unknown schemas fail rather than inventing a contract', () => {
  assert.equal(composeRequest('fixer', item, null, ctx).outputSchema, FIX_SCHEMA);
  const request = composeRequest('planner', item, null, ctx, { outputSchema: 'PLAN_STEPS_NUDGE_SCHEMA' });
  assert.equal(request.outputSchema, PLAN_STEPS_NUDGE_SCHEMA);
  assert.ok(request.prompt.includes(JSON.stringify(PLAN_STEPS_NUDGE_SCHEMA)));
  assert.ok(validate(request.outputSchema, { steps: ['Do it'], note: 'Done' }).ok);
  assert.ok(!validate(request.outputSchema, { steps: [], note: 'Done', invented: true }).ok);
  assert.throws(() => outputSchemaFor('unknown'), /No output schema/);
  assert.throws(() => outputSchemaFor('fixer', 'MISSING_SCHEMA'), /No output schema/);
  const custom = { type: 'object', additionalProperties: false, required: ['count'], properties: { count: { type: 'number' } } };
  assert.equal(composeRequest('comment-probe', item, 'TASK', ctx, { outputSchema: custom }).outputSchema, custom);
});
