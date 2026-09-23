import { isDeepStrictEqual } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { emptyLedger, syncFromGraph, transition, foldResults, FORWARD } from './ledger.mjs';
import { computeReady } from './graph.mjs';
import { parseVerifyRaw, verdictFromParse, parseRedRaw } from './verify.mjs';
import { execSmoke, smokeBatch, defaultAgentStub } from './_execsmoke.mjs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { nativeRequestJson } from './native-evidence-request.mjs';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dispatchAgent } from '../opencode/dispatcher.mjs';
import { digest, acceptSubmission } from '../opencode/identity.mjs';
import { lintCandidates, guardMechanical } from '../opencode/contracts.mjs';
import { resolveBash } from './bash.mjs';
import { runMainGuardDriverTests } from './_mainguard-driver-tests.mjs';
import { EVIDENCE_IDENTITY_VERSION } from './evidence-identity.mjs';
import { selectTestSuite } from './_test-suites.mjs';

// Run: node _workflow/lib/_coretest.mjs. Read-only source loading; in-memory fixtures only.
// Dedicated suites: lib/*.coretest.mjs or opencode/*.coretest.mjs, exporting async
// runCoreTests({ ok, eq }). No filesystem writes, subprocesses, or import-time tests.
let pass = 0, fail = 0, suites = 0;
function ok(condition, message) {
  if (condition) pass++;
  else { fail++; console.error('  FAIL: ' + message); }
}
function eq(actual, expected, message) {
  ok(isDeepStrictEqual(actual, expected), `${message} (got ${JSON.stringify(actual)})`);
}
async function suite(name, run) {
  suites++;
  const before = pass + fail;
  try {
    await run({ ok, eq });
    if (before === pass + fail) ok(false, name + ': no assertions executed');
  } catch (error) {
    ok(false, name + ': ' + (error?.stack || error));
  }
}

console.log('core-test: read-only/in-memory mode');
await suite('explicit portable/integration suite selection', () => {
  eq(selectTestSuite([]), 'portable', 'default suite never auto-enables SDK integration');
  eq(selectTestSuite(['--integration']), 'all', 'integration alias requests the full repository gate');
  for (const name of ['portable', 'integration', 'all']) eq(selectTestSuite(['--suite', name]), name, 'explicit suite ' + name);
  let rejected = false;
  try { selectTestSuite(['--suite', 'automatic']); } catch { rejected = true; }
  ok(rejected, 'invalid suite cannot silently downgrade coverage');
});
for (const kind of ['main-check', 'fold']) {
  await suite('root-aware driver diagnostic: ' + kind, assertions => runMainGuardDriverTests(kind, assertions));
}
await suite('driver extraction survives async signatures and formatting', async assertions => {
  const source = readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8')
    .replace(/function cmdMainCheck\(rest, flags\)/, 'async function cmdMainCheck(rest, flags, extra = { nested: { text: "}" } })')
    .replace(/function cmdFold\(file, flags\)/, 'async function cmdFold(file, flags, extra = /[{}]/)')
    .replace(/\btry\s*\{/g, 'try /* fixture delimiter } */ {')
    .replace(/\r?\n/g, '\r\n\t');
  for (const kind of ['main-check', 'fold']) await runMainGuardDriverTests(kind, assertions, source);
});
await suite('usable Bash resolution', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: command === 'bash' ? 0 : 1, stderr: 'unusable executable' };
  };
  eq(resolveBash({ env: { OPENCODE_FACTORY_BASH: 'broken-override' }, platform: 'linux', spawn }), 'bash', 'unusable override falls back to an actually probed PATH Bash');
  eq(calls.map(call => call.command), ['broken-override', 'bash'], 'override is preferred but existence alone does not imply usability');
  ok(calls.every(call => call.args.join(' ') === '-c exit 0' && call.options.timeout === 10000), 'every candidate receives a bounded nonmutating usability probe');
  const windowsCalls = [];
  const selected = resolveBash({ env: {}, platform: 'win32', spawn: command => {
    windowsCalls.push(command);
    return { status: /Git[\\/]bin[\\/]bash.exe$/.test(command) ? 0 : 1 };
  } });
  ok(/Git[\\/]bin[\\/]bash.exe$/.test(selected), 'Git Bash is preferred on Windows');
  ok(!windowsCalls.includes('bash'), 'working Git Bash avoids the PATH WSL stub');
  let message = '';
  try { resolveBash({ env: {}, platform: 'linux', spawn: () => ({ error: new Error('ENOENT') }) }); }
  catch (error) { message = error.message; }
  ok(message.includes('No usable Bash') && message.includes('ENOENT'), 'missing Bash fails explicitly with its probe diagnostic');
});
await suite('eligibility and fold', () => {
  const item = (id, extra = {}) => ({ id, files: [id + '.cs'], dependsOn: [], autonomyTier: 'auto', severity: 'HIGH', layer: 'service', ...extra });
  const graph = { items: [item('A'), item('B', { dependsOn: ['A'] }), item('OWNER', { autonomyTier: 'blocked' }), item('LOCKED', { files: ['A.cs'] })] };
  const ledger = emptyLedger('coretest');
  syncFromGraph(ledger, graph);
  const ready = () => computeReady(graph, ledger, { maxItemRetries: 2 }).map((w) => w.id);
  eq(ready(), ['A', 'LOCKED'], 'owner ruling and unmet dependency exclude items');
  transition(ledger, 'A', 'CLAIMED', 'coretest');
  eq(ready(), [], 'active file lock excludes overlapping work');
  const rejected = foldResults(ledger, [{ id: 'OWNER', toState: 'CLOSED' }]);
  eq(rejected.rejected.length, 1, 'fold rejects owner-BLOCKED direct closure');
  eq(ledger.items.OWNER.state, 'BLOCKED', 'rejected fold preserves owner stop');
  foldResults(ledger, [{ id: 'A', transitions: FORWARD.slice(2) }]);
  eq(ledger.items.A.state, 'CLOSED', 'legal forward chain closes');
  eq(ready(), ['B', 'LOCKED'], 'closure releases dependency and file lock');
  ledger.items.B.state = 'FAILED';
  ledger.items.B.attempts = 3;
  eq(ready(), ['LOCKED'], 'retry-exhausted work stays unschedulable');
});

await suite('evidence parser boundaries', () => {
  const raw = 'FACTORY::BUILD::RESULT exit=0 errors=0\nPassed!  - Failed: 0, Passed: 2, Skipped: 0, Total: 2\nFACTORY::TEST::SUITE::RESULT exit=0';
  eq(verdictFromParse(parseVerifyRaw(raw), 0).pass, true, 'completed green build and suite pass');
  eq(verdictFromParse(parseVerifyRaw('FACTORY::BUILD::RESULT exit=1 errors=1'), 0).pass, false, 'explicit build failure fails');
  eq(parseVerifyRaw('').hasData, false, 'missing transcript is not machine evidence');
  eq(parseRedRaw('FACTORY::RED::1\nFACTORY::RED::0').red, false, 'last RED marker controls retry outcome');
});

await suite('native execution to fold', async () => {
  const source = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const nativeVersion = Number(/const EVIDENCE_IDENTITY_VERSION = (\d+);/.exec(source)?.[1]);
  eq(nativeVersion, EVIDENCE_IDENTITY_VERSION, 'native consumer identity version matches shared collector producer version');
  const batch = smokeBatch();
  const { result } = await execSmoke(source, batch);
  eq(result.results.length, batch.items.length, 'every smoke item produces a terminal result');
  const ledger = emptyLedger('core-smoke');
  syncFromGraph(ledger, { items: batch.items });
  const folded = foldResults(ledger, result.results);
  eq(folded.rejected, [], 'native terminal transitions satisfy the ledger contract');
  for (const item of batch.items) eq(ledger.items[item.id].state, 'CLOSED', item.id + ' happy path closes through fold: ' + result.results.find(row => row.id === item.id)?.note);
  const failedBatch = smokeBatch();
  failedBatch.items = failedBatch.items.filter((item) => item.id === 'SMOKE-CODE');
  const failed = await execSmoke(source, failedBatch, {
    agentOverride: (_prompt, opts) => opts?.schema?.properties?.build
      ? { build: 'fail', targetedTest: 'fail', suite: { passed: 0, failed: 1, skipped: 0 }, realInfraExercised: false, debris: [], evidence: 'build failed', note: 'coretest failure' }
      : undefined,
  });
  eq(failed.result.results[0]?.toState, 'FAILED', 'failed verification cannot close');
  ok(!failed.calls.some((call) => /:gate-/.test(call.label)), 'failed verification stops before role gates');
});

await suite('full native source in the restricted Workflow sandbox', async () => {
  const source = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const batch = smokeBatch();
  batch.items[1].acceptance = 'Enforce policy for Zażółć 😀 and preserve "quoted" input';
  const requests = [];
  const sandbox = vm.createContext({
    args: JSON.stringify(batch),
    agent: async (prompt, opts) => {
      const value = defaultAgentStub(opts);
      if (opts.label.endsWith(':evidence-identity')) {
        const metadata = JSON.parse(prompt.split('\n').at(-1));
        const worktree = prompt.match(/^WORKTREE: (.+)$/m)?.[1];
        const artifactDir = prompt.match(/^ARTIFACTS DIR: (.+)$/m)?.[1];
        const expected = createHash('sha256').update(nativeRequestJson({ worktree, metadata, artifactDir })).digest('hex');
        eq(value.request.digest, expected, opts.label + ': sandbox SHA-256 binds the actual full metadata and paths');
        requests.push({ itemId: metadata.requestIdentity.itemId, boundary: metadata.requestIdentity.boundary });
      }
      return value;
    },
    parallel: async thunks => Promise.all(thunks.map(thunk => Promise.resolve().then(thunk).catch(() => null))),
    pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) value = await stage(value, item, index);
      return value;
    })),
    log: () => {}, phase: () => {},
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    workflow: async () => { throw new Error('nested Workflow unavailable in sandbox fixture'); },
  });
  vm.runInContext(`
    const OriginalDate = Date;
    globalThis.Date = class extends OriginalDate {
      constructor(...args) { if (!args.length) throw new Error('argless Date is forbidden'); super(...args); }
      static now() { throw new Error('Date.now is forbidden'); }
    };
    Math.random = () => { throw new Error('Math.random is forbidden'); };
  `, sandbox);
  eq(vm.runInContext('[typeof process, typeof require, typeof Buffer, typeof crypto, typeof TextEncoder].join(",")', sandbox),
    'undefined,undefined,undefined,undefined,undefined', 'sandbox exposes no Node or Web encoding/crypto shortcuts');
  const script = new vm.Script('(async function () {\n' + source.replace(/^export const meta =/m, 'const meta =') + '\n})()', { filename: 'factory-workflow-sandbox.js' });
  const result = await script.runInContext(sandbox, { timeout: 10000 });
  eq(result.results.length, batch.items.length, 'complete current native source compiles and executes all smoke lanes in sandbox');
  for (const item of batch.items) {
    eq(result.results.find(row => row.id === item.id)?.toState, 'CLOSED', item.id + ': restricted sandbox reaches terminal happy path');
    ok(requests.some(request => request.itemId === item.id && request.boundary === 'post-integrate'), item.id + ': request binding executes through integration');
  }
});

await suite('in-memory dispatch to validated submission', async () => {
  const value = { gate: 'qa', verdict: 'APPROVED', headline: 'verified fixture' };
  const descriptor = { itemId: 'A', runId: 'run', attemptId: 'claim', dispatchId: 'dispatch', promptRef: 'prompt', promptHash: digest('Review this immutable snapshot'), inputHash: 'snapshot', role: 'gate-qa', schema: 'GATE_SCHEMA', route: { model: 'fixture' } };
  const store = new Map([['prompt', { prompt: 'Review this immutable snapshot', inputHash: 'snapshot' }]]);
  const observations = [];
  let sends = 0, polls = 0;
  const options = {
    descriptor, directory: 'C:/fixture worktree', statePath: 'dispatch-state',
    config: { models: { fixture: { providerID: 'fixture', modelID: 'reviewer', agent: 'fixture-reviewer' } } },
    persist: (key, data) => store.set(key, structuredClone(data)),
    load: key => structuredClone(store.get(key)), present: key => store.has(key),
    observe: observation => observations.push(structuredClone(observation)), wait: async () => {},
    api: { create: async () => 'ses_fixture', send: async () => { sends++; },
      outcome: async () => ++polls === 1 ? { pending: true } : { settled: true, text: JSON.stringify(value), actualModel: 'fixture/reviewer' } },
  };
  const result = await dispatchAgent(options);
  ok(polls > 1, 'prompt admission and an intermediate pending response are not completion');
  eq(result.value, value, 'dispatcher validates the actual structured response');
  eq(store.get('dispatch-state').status, 'completed', 'settled valid response is durably completed');
  const call = { key: 'gate-qa', dispatchId: descriptor.dispatchId };
  const progress = { phase: 'gates', pendingSet: { phaseKey: 'gates', received: {} } };
  eq(acceptSubmission(progress, call, result.value, descriptor.dispatchId), true, 'validated dispatch result reaches its pending role');
  eq(acceptSubmission(progress, call, result.value, descriptor.dispatchId), false, 'same submission replay is idempotent');
  const pollsBeforeReplay = polls;
  const replay = await dispatchAgent(options);
  eq(sends, 1, 'durable completed dispatch replay never resends the worker');
  ok(polls > pollsBeforeReplay, 'durable completed replay rechecks current execution settlement');
  eq(replay.value, value, 'settled replay preserves the validated verdict');
  ok(observations.length > 0 && observations.every(o => o.actualModel === 'fixture/reviewer'), 'observations report the actual completed model');
  for (const [name, action] of [
    ['stale dispatch', () => acceptSubmission(progress, call, value, 'old-dispatch')],
    ['conflicting replay', () => acceptSubmission(progress, call, { ...value, verdict: 'CHANGES_REQUIRED' }, descriptor.dispatchId)],
    ['wrong mechanical phase', () => guardMechanical({ phase: 'gates' }, 'verify')],
    ['positive lint count without candidates', () => lintCandidates('FACTORY::LEFTOVER::1\n', 'leftover')],
  ]) {
    let rejected = false;
    try { action(); } catch { rejected = true; }
    ok(rejected, name + ' is rejected');
  }
  eq(lintCandidates('FACTORY::LEFTOVER-HIT::C:/work/a.cs::TODO::// TODO fix :: details\nFACTORY::LEFTOVER::1\n', 'leftover'),
    [{ file: 'C:/work/a.cs', lexeme: 'TODO', text: '// TODO fix :: details' }], 'positive lint producer payload reaches classifier without losing Windows path or text');
  store.delete('dispatch-state');
  let invalidRejected = false;
  try { await dispatchAgent({ ...options, api: { ...options.api, outcome: async () => ({ settled: true, text: '{"verdict":"APPROVED"}' }) } }); }
  catch (e) { invalidRejected = /invalid structured response/.test(e.message); }
  ok(invalidRejected, 'incomplete green-looking response fails schema validation');
  eq(store.get('dispatch-state').status, 'failed', 'invalid response persists failure rather than completion');
});

let dedicated = 0;
for (const directory of ['./', '../opencode/']) {
  const url = new URL(directory, import.meta.url);
  const names = readdirSync(url).filter((name) => name.endsWith('.coretest.mjs')).sort();
  for (const name of names) {
    dedicated++;
    await suite(directory + name, async (assertions) => {
      const module = await import(new URL(name, url));
      if (typeof module.runCoreTests !== 'function') throw new Error('expected runCoreTests({ ok, eq }) export');
      await module.runCoreTests(assertions);
    });
  }
}
console.log(`core-test: ${dedicated} dedicated *.coretest.mjs suites discovered`);
for (const file of ['./_prompt-selftest.mjs']) {
  suites++;
  let count = 0;
  for await (const event of run({ files: [fileURLToPath(new URL(file, import.meta.url))], isolation: 'none' })) {
    if (event.type === 'test:pass') { count++; ok(true, event.data.name); }
    if (event.type === 'test:fail') { count++; ok(false, `${file}: ${event.data.name}: ${event.data.details?.error?.stack || event.data.details?.error}`); }
  }
  ok(count > 0, file + ': tests were discovered and completed');
}
console.log(`core-test: ${pass} passed, ${fail} failed (${suites} suites)`);
process.exitCode = fail ? 1 : 0;
