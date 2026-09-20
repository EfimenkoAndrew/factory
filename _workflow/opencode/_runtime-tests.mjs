import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { completeCommand, lintCandidates, guardMechanical } from './contracts.mjs';
import { digest, snapshotTree, acceptSubmission, withItemLock, EVIDENCE_IDENTITY_VERSION } from './identity.mjs';
import { executeVerification, planNext, applyPhaseResults, invalidateSuffix, finalBarrier, evidenceIntact } from './runtime.mjs';
import { validateNamed } from './schemas.mjs';
import { OpenCodeServer, resolveRoute } from './server-api.mjs';
import { dispatchAgent, Semaphore } from './dispatcher.mjs';
import { nativeProbeCalls, serviceRoots, mainDrift } from './native-checks.mjs';
import { withBuildSlot } from './build-lease.mjs';
import { captureBaseline } from '../lib/baseline.mjs';

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const throws = (fn, re) => { assert.throws(fn, re); checks++; };
const temp = mkdtempSync(join(tmpdir(), 'opencode-contracts-'));
const target = 'C:/work item/App.sln';
function runResult(sub, code = 0, counts = 'Failed: 0, Passed: 2') {
  const key = { build: 'BUILD', filter: 'TEST::FILTER', suite: 'TEST::SUITE' }[sub];
  const numbers = /Failed: (\d+), Passed: (\d+)/.exec(counts);
  return { code, output: `FACTORY::${key}::START ${target}${sub === 'filter' ? ' :: Foo' : ''}\nPassed! ${counts}, Skipped: 0\nFACTORY::SUMMARY::${sub} exit=${code}${sub === 'build' ? ' errors=0' : sub === 'suite' ? ` failed=${numbers[1]} passed=${numbers[2]} skipped=0` : ''}\n` };
}
function progress(phase, item = {}) {
  const id = 'CONTRACT-' + phase;
  return { id, item: { id, files: [], acceptance: 'one clause', fixType: 'mechanical', ...item }, ctx: { repoRoot: temp, worktreePath: temp, factoryRoot: temp, briefs: {}, policies: {} }, phase, band: 'LIGHT', content: { hash: 'content' }, history: [], dispatchSequence: 0, attemptId: 'attempt', res: { gates: {}, gateDetails: {}, artifacts: {}, cost: {}, transitions: [], codeChange: false, rootCauseFiles: [], toState: 'FAILED' } };
}
try {
  for (const sub of ['build', 'filter', 'suite']) {
    check(completeCommand(runResult(sub), sub, target, 'Foo').pass, sub + ' complete');
    check(!completeCommand({ code: -1, output: runResult(sub).output }, sub, target, 'Foo').pass, sub + ' spawn failure');
    check(!completeCommand({ code: 0, output: '' }, sub, target, 'Foo').pass, sub + ' missing output');
    check(!completeCommand(runResult(sub), sub, target + 'wrong', 'Foo').pass, sub + ' wrong target');
  }
  check(!completeCommand(runResult('filter'), 'filter', target, 'Wrong').pass, 'filter identity');
  check(!completeCommand(runResult('filter', 0, 'Failed: 0, Passed: 0'), 'filter', target, 'Foo').pass, 'zero tests');
  check(!completeCommand(runResult('filter', 1, 'Failed: 1, Passed: 1'), 'filter', target, 'Foo', 10).pass, 'targeted failures cannot be baseline');
  check(!completeCommand(runResult('suite', 1, 'Failed: 1, Passed: 1'), 'suite', target, null, 1).pass, 'legacy count cannot authorize suite failures');
  const suite = runResult('suite', 1, 'Failed: 1, Passed: 1');
  suite.output += 'FACTORY::TEST::FAILURE {"source":"Tests.dll/net8.0","test":"KnownFailure"}\n';
  const baseline = captureBaseline(suite.output);
  check(completeCommand(suite, 'suite', target, null, baseline).pass, 'captured target/test baseline allowed');
  check(!completeCommand({ ...suite, output: suite.output.replace('KnownFailure', 'NewFailure') }, 'suite', target, null, baseline).pass, 'same-count replacement failure rejected');
  let commands = [];
  const p = progress('verify');
  const failed = executeVerification(p, target, 'Foo', ['build', 'filter', 'suite'], 0, (_root, sub) => { commands.push(sub); return sub === 'filter' ? { code: -1, output: 'timeout' } : runResult(sub); });
  check(!failed.pass && commands.join(',') === 'build,filter', 'filter timeout stops before suite/review');
  throws(() => guardMechanical(p, 'checkpoint'), /invalid in phase/);
  throws(() => guardMechanical({ ...p, pendingSet: {} }, 'verify'), /pending/);
  const leftover = lintCandidates('FACTORY::LEFTOVER-HIT::C:/a.cs::TODO::// TODO fix :: separator\nFACTORY::LEFTOVER::1\n', 'leftover');
  check(leftover[0].text === '// TODO fix :: separator', 'positive leftover source text retained');
  const ledger = lintCandidates('FACTORY::LEDGER-ANCHOR-DUP-HIT::RULE::2::a.md::b.md\nFACTORY::LEDGER-ANCHOR-TAG-HIT::RULE::src/a.cs::false\nFACTORY::LEDGER-ANCHOR::2\n', 'ledger');
  check(ledger.length === 2 && ledger[1].tagFound === false, 'both positive ledger producer formats');
  throws(() => lintCandidates('FACTORY::LEFTOVER::1\n', 'leftover'), /count\/payload/);
  throws(() => lintCandidates('FACTORY::LEDGER-ANCHOR-ERROR::unavailable\nFACTORY::LEDGER-ANCHOR::0\n', 'ledger'), /scanner error/);

  const a = progress('acceptance');
  a.plan = { approach: 'must work', steps: ['first step', 'second step'] };
  const plan = planNext(a);
  check(a.phase === 'plancommit' && plan.agents[0].schema === 'PLAN_COMMITMENT_SCHEMA', 'single clause does not skip plan');
  check(validateNamed(plan.agents[0].schema, { honored: false, gaps: [] }).ok, 'reachable plan schema submits');
  a.pendingSet.received['plan-commitment-probe'] = { honored: false, gaps: [] };
  applyPhaseResults(a);
  check(a.phase === 'plancommit_amend', 'explicit false with empty gaps requires remediation');
  const la = progress('ledger_anchor_classify');
  const lc = planNext(la).agents[0];
  check(validateNamed(lc.schema, { clean: true }).ok, 'reachable ledger schema submits');
  la.pendingSet.received['ledger-anchor-probe'] = { clean: true }; applyPhaseResults(la);
  check(la.phase === 'editorial', 'ledger classifier advances');
  const pooled = progress('gates');
  pooled.ctx.briefs = { 'gate-developer': 'developer', 'gate-qa': 'qa', 'review-adversarial': 'adversarial', 'review-testreview': 'testreview' };
  const batch = planNext(pooled);
  const first = batch.agents[0];
  check(!('prompt' in first) && first.promptRef && first.dispatchId, 'compact descriptors');
  const call = pooled.pendingSet.calls[0], value = { gate: 'developer', verdict: 'APPROVED', headline: 'ok' };
  check(acceptSubmission(pooled, call, value, first.dispatchId), 'dispatch accepted');
  check(!acceptSubmission(pooled, call, value, first.dispatchId), 'duplicate is idempotent');
  throws(() => acceptSubmission(pooled, call, { ...value, headline: 'changed' }, first.dispatchId), /conflicting/);
  throws(() => acceptSubmission(pooled, call, value, 'old'), /stale/);
  check(planNext(pooled).agents.length === batch.agents.length - 1, 'only pending descriptors re-emitted');
  const ed = progress('editorial', { files: ['README.md'] });
  ed.ctx.briefs = { 'review-editorial-structure': 'structure', 'review-editorial-prose': 'prose' };
  const e1 = planNext(ed);
  check(e1.agents.length === 1 && e1.agents[0].role === 'review-editorial-structure', 'first editorial alone');
  ed.pendingSet.received[e1.agents[0].key] = value; applyPhaseResults(ed); ed.pendingSet = null;
  const e2 = planNext(ed);
  check(e2.agents.length === 1 && e2.agents[0].role === 'review-editorial-prose', 'second editorial after first');
  ed.pendingSet.received[e2.agents[0].key] = value; applyPhaseResults(ed); ed.pendingSet = null;
  check(planNext(ed).mechanical === 'verify', 'editorial ends at independent barrier');

  const tree = join(temp, 'tree'); mkdirSync(tree); writeFileSync(join(tree, 'huge.cs'), 'x'.repeat(410000)); writeFileSync(join(tree, 'README.md'), 'one');
  const git = args => args[0] === 'rev-parse' ? 'base' : 'huge.cs\0README.md\0';
  const one = snapshotTree(tree, { policy: 'strict' }, git);
  writeFileSync(join(tree, 'huge.cs'), 'x'.repeat(410000) + 'changed');
  const two = snapshotTree(tree, { policy: 'strict' }, git);
  check(one.hash !== two.hash && one.codeHash !== two.codeHash, 'full untracked content beyond pack truncation affects identity');
  writeFileSync(join(tree, 'README.md'), 'two');
  const three = snapshotTree(tree, { policy: 'strict' }, git);
  check(three.hash !== two.hash && three.codeHash === two.codeHash, 'prose changes invalidate reviews but preserve code evidence');
  check(snapshotTree(tree, { policy: 'other' }, git).hash !== three.hash, 'contract identity included');
  pooled.test = { red: true }; pooled.plan = { recommendEscalate: true }; pooled._escalate = true;
  invalidateSuffix(pooled, three);
  check(pooled.phase === 'verify' && !pooled.pendingSet && pooled._escalate && pooled.plan.recommendEscalate, 'resume retains implementation prefix/signoff and invalidates reviews');
  withItemLock(join(temp, 'lock'), () => check(true, 'serialized writer acquires lock'));
  const probes = nativeProbeCalls({ ...progress('native_checks', { acceptance: 'every consumer' }), reFix: true, res: { codeChange: true }, test: { runCmd: 'filter Foo' } }, 'prior finding');
  check(probes.length === 3 && probes.every(c => validateNamed(c.schema, c.field === 'honored' ? { honored: true } : { covered: true }).ok), 'prior/RED/breadth native probes have submitting contracts');
  check(serviceRoots(['src/Orders/src/Orders.Core/X.cs', 'src/Pay/src/Pay.Api/Y.cs']).length === 2, 'cross-target service roots');
  check(mainDrift(progress('drift'), temp).unavailable, 'missing drift snapshot explicit');
  const ri = progress('realinfra_adjudicate'); ri.test = { realInfraOverride: 'pure string formatting' }; ri.pendingSet = { phaseKey: ri.phase, received: { adjudicator: { verdict: 'OVERRULED', headline: 'provider independent', reasons: ['only transforms a string'] } } };
  applyPhaseResults(ri);
  check(ri.res.needsRealInfra === false && ri.res.infraClassification.original && ri.phase === 'verify', 'adjudicated effective requirement survives checkpoint shape');
  const barrier = progress('final_verify');
  const bd = join(temp, 'state/items', barrier.id); mkdirSync(bd, { recursive: true });
  writeFileSync(join(bd, 'verify-red-raw.txt'), 'FACTORY::RED::1\n'); writeFileSync(join(bd, 'verify-raw.txt'), 'complete verification');
  barrier.evidence = { version: EVIDENCE_IDENTITY_VERSION, complete: true, hash: 'before', codeHash: 'same-code' };
  const refreshed = { version: EVIDENCE_IDENTITY_VERSION, hash: 'after-prose', codeHash: 'same-code' };
  const fakeBarrier = { run: (_root, sub) => ({ code: 0, output: sub === 'claims' ? 'FACTORY::CLAIMS::0\n' : sub === 'countclaims' ? 'FACTORY::COUNTCLAIMS::0\n' : '' }), changedFiles: () => [], mainDrift: () => ({ dirty: [], committed: [] }), efProbe: () => [], content: () => refreshed, save: () => {} };
  finalBarrier(barrier, bd, fakeBarrier);
  check(barrier.phase === 'edgescan' && barrier.evidence.hash === refreshed.hash && evidenceIntact(barrier), 'prose-only final barrier refreshes evidence/pack without redundant code execution');
  writeFileSync(join(bd, 'verify-raw.txt'), 'tampered');
  check(!evidenceIntact(barrier), 'raw evidence mutation invalidates cached verification');
  barrier.phase = 'final_verify'; barrier.policies = { failLaneOnMainDrift: true };
  finalBarrier(barrier, bd, { ...fakeBarrier, mainDrift: () => ({ dirty: [{ file: 'own.cs' }] }) });
  check(barrier.phase === 'done' && barrier.res.toState === 'FAILED', 'main drift policy fails lane before gates');
  barrier.phase = 'final_verify'; barrier.policies = {};
  finalBarrier(barrier, bd, { ...fakeBarrier, efProbe: () => [{ service: 'Service', verdict: 'dirty' }] });
  check(barrier.res.note.includes('EF pending model changes'), 'real EF dirty result fails pre-band');
  barrier.phase = 'final_verify';
  finalBarrier(barrier, bd, { ...fakeBarrier, efProbe: () => [{ service: 'Service', verdict: 'inconclusive' }] });
  check(barrier.phase === 'done' && barrier.res.note.includes('unavailable'), 'inconclusive required EF execution fails before gates');
  withBuildSlot(temp, () => check(true, 'global build lease acquired'));
  throws(() => withBuildSlot(temp, () => { throw new Error('build exception'); }), /build exception/);
  withBuildSlot(temp, () => check(true, 'build lease released after failure'));

  const pr = progress('plan_review'); pr.plan = { steps: ['first', 'second'] };
  const prBatch = planNext(pr);
  check(prBatch.agents.length === 2 && prBatch.agents.every(c => validateNamed(c.schema, { honored: true }).ok), 'plan review schemas dispatch and accept');
  pr.pendingSet.received = { 'plan-feasibility-probe': { honored: false }, 'plan-quality-probe': { honored: true } }; applyPhaseResults(pr);
  check(pr.phase === 'plan_revision', 'infeasible plan gets bounded revision');
  pr.planRevised = true; pr.pendingSet.phaseKey = 'plan_review'; applyPhaseResults(pr);
  check(pr.phase === 'done', 'infeasible revision fails before test author');

  const failedStore = new Map([['p', { prompt: 'x', inputHash: 'i' }]]);
  const failedDescriptor = { itemId: 'TEST', runId: 'run', dispatchId: 'timeout', attemptId: 'a', promptRef: 'p', promptHash: digest('x'), inputHash: 'i', role: 'gate-qa', schema: 'GATE_SCHEMA', route: { model: 'm' } };
  let interrupted = 0, sent = 0;
  const failedOptions = { descriptor: failedDescriptor, directory: temp, statePath: 's', config: { models: { m: { providerID: 'p', modelID: 'm', agent: 'w' } }, agentTimeoutMs: 1 }, load: p => failedStore.get(p), present: p => failedStore.has(p), persist: (p, v) => failedStore.set(p, structuredClone(v)), wait: async () => {}, api: { create: async () => 'ses_t', send: async () => { sent++; }, outcome: async () => ({ pending: true }), stop: async () => { interrupted++; return { stopped: true }; } } };
  await assert.rejects(dispatchAgent(failedOptions), /timeout/); checks++;
  check(interrupted === 1 && sent === 1 && failedStore.get('s').status === 'failed', 'timeout is interrupted and durably failed, never admission-as-success');
  await assert.rejects(dispatchAgent(failedOptions), /terminal failure/); checks++;
  failedStore.delete('s');
  await assert.rejects(dispatchAgent({ ...failedOptions, config: { ...failedOptions.config, agentTimeoutMs: 1000 }, api: { ...failedOptions.api, outcome: async () => ({ settled: true, text: 'not JSON', actualModel: 'p/m' }) } }), /malformed structured response/); checks++;
  check(failedStore.get('s').status === 'failed', 'malformed completed agent result has durable failure');
  failedStore.delete('s');
  await assert.rejects(dispatchAgent({ ...failedOptions, config: { ...failedOptions.config, agentTimeoutMs: 1000 }, api: { ...failedOptions.api, outcome: async () => ({ settled: true, text: '{"verdict":"APPROVED"}', actualModel: 'p/m' }) } }), /invalid structured response/); checks++;
  check(failedStore.get('s').status === 'failed', 'schema-invalid completed result cannot submit');

  let requests = [], polls = 0, version = 'v1', admitted = false, session;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = body ? JSON.parse(body) : null, url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, payload });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/global/health') return res.end(JSON.stringify({ healthy: true, version: '1.2.0' }));
    if (url.pathname === '/api/info') return res.end(JSON.stringify({ version: '2.0.0', ready: true }));
    if (url.pathname === '/session/status') return res.end('{}');
    if (url.pathname === '/api/session/active') return res.end('{"data":{}}');
    if (url.pathname.endsWith('/inbox')) return res.end('{"data":[]}');
    if (url.pathname === '/session' && req.method === 'GET') return res.end('[]');
    if (url.pathname === '/agent' || url.pathname === '/api/agent') return res.end(JSON.stringify(version === 'v1' ? [{ name: 'worker', model: { providerID: 'fake', modelID: 'qa' } }] : { data: [{ id: 'worker', model: { providerID: 'fake', id: 'qa' } }] }));
    if (req.method === 'POST' && ['/session', '/api/session'].includes(url.pathname)) { session = { ...payload, id: payload.id || 'ses_test', directory: url.searchParams.get('directory') }; return res.end(JSON.stringify(version === 'v1' ? session : { data: session })); }
    if (req.method === 'GET' && /^\/(?:api\/)?session\/ses/.test(url.pathname) && !url.pathname.endsWith('/message') && session) return res.end(JSON.stringify(version === 'v1' ? session : { data: session }));
    if (url.pathname.endsWith('/prompt_async') || url.pathname.endsWith('/prompt')) { admitted = true; if (version === 'v1') { res.statusCode = 204; return res.end(); } return res.end(JSON.stringify({ data: { id: payload.id, sessionID: session.id, type: 'user' } })); }
    if (req.method === 'GET' && url.pathname.endsWith('/message')) {
      if (!admitted) return res.end(JSON.stringify(version === 'v1' ? [] : { data: [], cursor: { next: null } }));
      polls++;
      const sent = requests.find(r => r.path.endsWith('/prompt_async') || r.path.endsWith('/prompt'))?.payload;
      const messageId = sent?.messageID || sent?.id;
      const finish = polls < 2 ? 'tool-calls' : 'stop';
      const text = JSON.stringify({ gate: 'qa', verdict: 'APPROVED', headline: 'ok' });
      return res.end(JSON.stringify(version === 'v1' ? [{ info: { role: 'user', id: messageId, sessionID: session.id }, parts: sent.parts }, { info: { role: 'assistant', sessionID: session.id, parentID: messageId, time: { completed: 1 }, finish, providerID: 'fake', modelID: 'qa' }, parts: [{ type: 'text', text }] }] : { data: [{ id: messageId, type: 'user', text: sent.text }, { id: 'msg_answer', type: 'assistant', time: { completed: 1 }, finish, model: { providerID: 'fake', id: 'qa' }, content: [{ type: 'text', text }] }], cursor: { next: null } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    for (version of ['v1', 'v2']) {
      requests = []; polls = 0; admitted = false; session = null;
      const api = new OpenCodeServer({ url: 'http://127.0.0.1:' + server.address().port, version });
      await api.check();
      const store = new Map(), promptRef = 'prompt', statePath = 'state';
      store.set(promptRef, { prompt: 'judge this snapshot', inputHash: 'input' });
      const descriptor = { itemId: 'TEST', runId: 'run', dispatchId: 'dispatch-' + version, attemptId: 'a', promptRef, promptHash: digest('judge this snapshot'), inputHash: 'input', role: 'gate-qa', schema: 'GATE_SCHEMA', route: { model: 'intended', effort: 'medium' } };
      const config = { models: { intended: { providerID: 'fake', modelID: 'qa', agent: 'worker' } }, pollMs: 1, agentTimeoutMs: 2000 };
      const options = { descriptor, directory: 'C:/isolated worktree', statePath, api, config, load: p => structuredClone(store.get(p)), present: p => store.has(p), persist: (p, v) => store.set(p, structuredClone(v)), wait: async () => {} };
      const outcome = await dispatchAgent(options);
      check(admitted && polls > 1 && outcome.settled && outcome.value.verdict === 'APPROVED', version + ' admission and intermediate tool turn are not completion');
      check(outcome.actualModel === 'fake/qa' && store.get(statePath).status === 'completed', version + ' actual model/session outcome persisted');
      const sentCount = requests.filter(r => r.method === 'POST').length, pollsBeforeReplay = polls; await dispatchAgent(options);
      check(requests.filter(r => r.method === 'POST').length === sentCount, version + ' durable completed replay performs no admission calls');
      check(polls > pollsBeforeReplay, version + ' completed replay rechecks durable outcome and settlement');
      const create = requests.find(r => r.method === 'POST' && r.path === (version === 'v1' ? '/session' : '/api/session'));
      check(!create.payload.parentID, version + ' independent fresh session (no implementation history)');
      const send = requests.find(r => r.path.endsWith(version === 'v1' ? '/prompt_async' : '/prompt'));
      check(version === 'v1' ? send.payload.model.modelID === 'qa' && send.query.get('directory') === 'C:/isolated worktree' : create.payload.model.id === 'qa' && create.payload.location.directory === 'C:/isolated worktree', version + ' real route and working directory applied');
      const saved = store.get(statePath); saved.status = 'sending'; delete saved.outcome; store.set(statePath, saved);
      await dispatchAgent(options);
      check(requests.filter(r => r.path.endsWith('/prompt_async') || r.path.endsWith('/prompt')).length === 1, version + ' uncertain admission resumes by durable query, never resends');
      const mapping = store.get(statePath);
      const oldTitle = session.title; session.title = 'foreign session';
      await assert.rejects(api.outcome(mapping, options.directory), /session identity/); checks++;
      session.title = oldTitle;
      await assert.rejects(api.outcome({ ...mapping, promptHash: digest('different prompt') }, options.directory), /prompt content mismatch/); checks++;
      store.set(statePath, { ...mapping, server: 'http://different-server' });
      await assert.rejects(dispatchAgent(options), /mapping mismatch/); checks++;
      store.set(statePath, { ...mapping, outcome: null });
      await assert.rejects(dispatchAgent(options), /cached completion missing/); checks++;
    }
  } finally { await new Promise(r => server.close(r)); }
  throws(() => resolveRoute({ role: 'qa', route: { model: 'missing' } }, {}), /route missing/);
  const semaphore = new Semaphore(2); let active = 0, max = 0;
  await Promise.all(Array.from({ length: 8 }, () => semaphore.run(async () => { max = Math.max(max, ++active); await new Promise(r => setTimeout(r, 2)); active--; })));
  check(max === 2, 'global concurrency bounded across independent work');
  console.log('Runtime/API behavioral contracts: ' + checks + ' passed');
} finally { rmSync(temp, { recursive: true, force: true }); }
