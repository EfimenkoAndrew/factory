import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { authenticatedEnvironment, launch, stopServer, availableModels, chooseModel } from './live-opencode-workers.mjs';
import { OpenCodeServer } from './opencode/server-api.mjs';
import { dispatchAgent } from './opencode/dispatcher.mjs';
import { digest, writeJsonAtomic } from './opencode/identity.mjs';
import { launchV2 } from './live-opencode-cancel.mjs';
import { waitForOpenCodeAgents } from './opencode/compatibility.mjs';
import { randomUUID } from 'node:crypto';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'LIVE-DOC-VERIFY';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const assert = (v, message) => { if (!v) throw new Error(message); };

export function lifecycleReport(root) {
  const original = join(root, 'report.json');
  const pointer = join(root, 'report-latest.json');
  const latest = existsSync(pointer) ? read(pointer).file : 'report.json';
  assert(/^(report|replay-[a-zA-Z0-9-]+)\.json$/.test(latest), 'invalid-report-pointer');
  const previous = join(root, latest);
  const prior = existsSync(previous) ? read(previous) : null;
  const path = prior ? join(root, 'replay-' + randomUUID() + '.json') : original;
  const report = prior ? structuredClone(prior) : { scope: 'fixture-bootstrap-real-runtime-finalize-driver-fold', root, result: 'FAIL', calls: [], mechanics: [], cleanup: {} };
  report.cleanup ||= {};
  report.cleanup.receipts ||= [];
  const journal = join(root, 'cleanup-receipts.jsonl');
  if (existsSync(journal)) {
    for (const line of readFileSync(journal, 'utf8').split('\n').filter(Boolean)) {
      const receipt = JSON.parse(line);
      assert(receipt.receiptId && ['session', 'server'].includes(receipt.kind), 'invalid-cleanup-receipt');
      if (report.cleanup.receipts.some(r => r.receiptId === receipt.receiptId)) continue;
      report.cleanup.receipts.push(receipt);
      const { receiptId, at, kind, ...evidence } = receipt;
      const key = kind === 'session' ? 'sessions' : 'servers';
      report.cleanup[key] ||= [];
      report.cleanup[key].push(evidence);
    }
  }
  if (prior) report.priorReport = previous;
  report.reportPath = path;
  return { report, save: () => {
    writeJsonAtomic(path, report);
    writeJsonAtomic(pointer, { file: path.slice(root.length + 1) });
  } };
}

export function appendCleanupReceipt(root, report, kind, evidence) {
  const receipt = { receiptId: randomUUID(), at: new Date().toISOString(), kind, ...evidence };
  appendFileSync(join(root, 'cleanup-receipts.jsonl'), JSON.stringify(receipt) + '\n');
  report.cleanup.receipts ||= [];
  report.cleanup.receipts.push(receipt);
  return receipt;
}

export function lifecycleConfig(model, workspace, mount, version = 'v1') {
  assert(['v1', 'v2'].includes(version), 'unsupported-api-version');
  const config = { $schema: 'https://opencode.ai/config.json', snapshot: false, autoupdate: false, share: 'disabled',
    instructions: [], plugin: [], mcp: {}, formatter: false, lsp: false, permission: { '*': 'deny' },
    agent: { 'factory-live-doc': { description: 'Read-only synthetic doc verification worker', mode: 'all', model, steps: 8,
      permission: { '*': 'deny', read: 'allow', edit: 'deny', external_directory: 'deny',
        bash: { '*': 'deny', 'node check-doc.mjs': 'allow', 'node delay-check.mjs': 'allow' } },
       prompt: 'This is an owner-authorized synthetic verificationOnly doc fixture. Source is read-only. Do not edit any source or write artifacts; controller persists your JSON. Shell is limited to node check-doc.mjs (actual doc assertion) or node delay-check.mjs (only if explicitly requested for cancellation). Never read credentials, config, unrelated files, or invoke git/network/delegation. The worktree has no item changes; unrelated build/git status commands in generic briefs are not applicable. Read only README.md and this item\'s machine evidence/role artifacts. For this doc assertion only, run node check-doc.mjs directly in the WORKTREE; the generic dotnet/build-lease/red command does not apply. Evaluate honestly, do not invent RED/GREEN code tests. Return concise schema-valid JSON.' } } };
  if (version === 'v1') return config;
  const worker = config.agent['factory-live-doc'];
  const permissions = Object.entries(worker.permission).flatMap(([action, values]) =>
    Object.entries(typeof values === 'string' ? { '*': values } : values).map(([resource, effect]) => ({ action: action === 'bash' ? 'shell' : action, resource, effect })));
  return { $schema: config.$schema, snapshots: false, update: 'disable', share: 'disabled',
    plugins: [], mcp: { servers: {} }, formatter: false, permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    agents: { 'factory-live-doc': { description: worker.description, mode: 'all', model, steps: 8, system: worker.prompt, permissions } } };
}

export async function missingModelThenFallback({ api, root, model, sessions, timeoutMs = 60000 }) {
  const [providerID, ...modelParts] = model.split('/');
  const missing = 'factory-live-deliberately-unavailable-' + randomUUID();
  const catalog = api.version === 'v2' ? (await api.request('GET', '/api/model?location[directory]=' + encodeURIComponent(root))).data.map(m => m.providerID + '/' + m.id)
    : availableModels(await api.request('GET', '/provider', undefined, root));
  assert(!catalog.includes(providerID + '/' + missing) && catalog.includes(model), 'missing-or-fallback-catalog-mismatch');
  const prompt = 'Return only JSON {"markerFound":true,"line":"explicit valid fallback"}. No tools.';
  const attemptId = 'model-retry-' + randomUUID();
  const make = name => ({ itemId: 'MODEL-FAILURE-FIXTURE', attemptId, dispatchId: name + '-' + randomUUID(), role: 'review-code',
    route: { model: 'live' }, schema: 'PROBE_SCHEMA', promptHash: digest(prompt), inputHash: digest(prompt), promptRef: join(root, name + '-prompt.json') });
  const bad = make('unavailable');
  writeJsonAtomic(bad.promptRef, { prompt, inputHash: bad.inputHash });
  const statePath = join(root, bad.dispatchId + '-session.json');
  const badConfig = { version: api.version, pollMs: 200, agentTimeoutMs: timeoutMs,
    roles: { 'review-code': { agent: 'factory-live-doc', providerID, modelID: missing } } };
  let failure;
  try { await dispatchAgent({ descriptor: bad, directory: root, statePath, api, config: badConfig, observe: () => {} }); }
  catch (e) { failure = e; }
  const state = existsSync(statePath) ? read(statePath) : null;
  if (state?.sessionId) sessions.push(state);
  assert(failure && !failure.unsettled && state?.status === 'failed' && state.stopped === true && !state.outcome?.value, 'unavailable-model-did-not-fail-closed');
  const failedMessages = state.sessionId ? await api.messages(state, root) : [];
  const assistants = failedMessages.filter(m => (api.version === 'v1' ? m.info?.role : m.type) === 'assistant');
  assert(/model|unavailable|not found/i.test(state.error || '') || (state.error === 'agent timeout' && assistants.length === 0), 'failure-not-model-specific');
  const badBytes = digest(readFileSync(statePath));
  const good = make('fallback');
  writeJsonAtomic(good.promptRef, { prompt, inputHash: good.inputHash });
  const goodPath = join(root, good.dispatchId + '-session.json');
  const config = { ...badConfig, roles: { 'review-code': { agent: 'factory-live-doc', providerID, modelID: modelParts.join('/') } } };
  let outcome;
  try { outcome = await dispatchAgent({ descriptor: good, directory: root, statePath: goodPath, api, config, observe: () => {} }); }
  finally { if (existsSync(goodPath)) { const s = read(goodPath); if (s.sessionId) sessions.push(s); } }
  assert(outcome.actualModel === model && outcome.value.markerFound === true, 'explicit-fallback-route-or-schema');
  assert(digest(readFileSync(statePath)) === badBytes, 'fallback-overwrote-failed-mapping');
  return { result: 'PASS', maxAttempts: 2, failed: { dispatchId: bad.dispatchId, sessionId: state.sessionId ?? null,
    requestedModel: providerID + '/' + missing, admitted: state.invoked === true, status: state.status, stopped: state.stopped,
    error: state.error, absentFromEffectiveCatalog: true, assistantMessages: assistants.length,
    actualModel: state.outcome?.actualModel ?? null, usage: state.outcome?.usage ?? null, cost: state.outcome?.cost ?? null },
    fallback: { dispatchId: good.dispatchId, sessionId: read(goodPath).sessionId, actualModel: outcome.actualModel,
      usage: outcome.usage, cost: outcome.cost, value: outcome.value }, failedMappingUnchanged: true };
}

export function prepareLifecycle(root) {
  const workspace = join(root, 'source'), mount = join(root, 'factory');
  mkdirSync(workspace); mkdirSync(mount);
  const archive = execFileSync('git', ['-C', SOURCE, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 });
  const extracted = spawnSync('tar', ['-xf', '-', '-C', workspace], { input: archive, encoding: 'utf8' });
  assert(extracted.status === 0, 'archive-extraction-failed');
  for (const dir of ['_workflow', 'verify', 'config', 'agents', 'schema', 'opencode-assets']) {
    cpSync(join(SOURCE, dir), join(mount, dir), { recursive: true, filter: p => !p.includes('repo-profiles') && !/\.local\./.test(p) });
  }
  for (const file of ['VERSION', 'PLAN.md', 'README.md']) cpSync(join(SOURCE, file), join(mount, file));
  for (const dir of ['state', 'reports', 'queue', 'telemetry/data']) mkdirSync(join(mount, dir), { recursive: true });
  const dir = join(mount, 'state/items', ID); mkdirSync(dir, { recursive: true });
  const assertion = "import {readFileSync} from 'node:fs';\nconst text=readFileSync(new URL('./README.md',import.meta.url),'utf8');\nif (!text.startsWith('# AI Implementation Factory')) throw new Error('doc heading missing');\nconsole.log('DOC_ASSERT_PASS: README heading');\nconsole.log('FACTORY::RED::0');\n";
  writeFileSync(join(workspace, 'check-doc.mjs'), assertion);
  writeFileSync(join(workspace, 'delay-check.mjs'), "import {writeFileSync} from 'node:fs';\nwriteFileSync(new URL('./delay-started',import.meta.url),'started');\nsetTimeout(()=>{writeFileSync(new URL('./delay-late',import.meta.url),'late');console.log('DELAY_FINISHED');},15000);\n");
  writeFileSync(join(root, 'fixture-excludes'), '/check-doc.mjs\n/delay-check.mjs\n/delay-started\n/delay-late\n');
  const item = { id: ID, target: 'SyntheticDocs', severity: 'LOW', fixType: 'mechanical', autonomyTier: 'auto',
    title: 'Verify the existing factory README heading', theme: 'doc-drift', realInfra: false, files: ['README.md'],
    acceptance: 'README.md begins with the heading # AI Implementation Factory.',
    regressionTest: 'Owner-provided node check-doc.mjs asserts the exact existing heading and emits FACTORY::RED::0 on success. Run it; if true return red:false, verificationOnly:true, testFiles:[], runCmd:"node check-doc.mjs". No source edits or new code tests are needed.',
    fixHint: 'Stale synthetic finding: verify existing text only. Editorial roles are advisory and read-only. This fixture uses git archive HEAD with the original read-only index and GIT_OPTIONAL_LOCKS=0. Git status can report stale stat-cache M entries because refreshing the original index is forbidden. The controller independently requires git diff HEAD --exit-code to succeed before launch; the pack shows that exact empty diff. These status-only entries are fixture cache artifacts, not item edits or owner changes to revert. Judge the README acceptance using current bytes and the executed assertion; no dotnet/build is applicable.', source: 'synthetic-live-fixture', dependsOn: [] };
  writeJsonAtomic(join(root, 'fixture.json'), { item, worktreePath: workspace, branch: 'fixture/read-only-archive', cycle: 1 });
  writeJsonAtomic(join(mount, 'state/findings-graph.json'), { version: 1, items: [item] });
  const gitDir = execFileSync('git', ['-C', SOURCE, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  const env = { ...process.env, FACTORY_REPO_ROOT: root, FACTORY_TELEMETRY: '0', GIT_DIR: gitDir,
    GIT_WORK_TREE: workspace, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: join(root, 'fixture-excludes') };
  const status = execFileSync('git', ['-C', workspace, 'status', '--porcelain', '-z', '--untracked-files=no'], { env, encoding: 'utf8' });
  for (const row of status.split('\0').filter(Boolean)) {
    assert(row.slice(0, 3) === ' M ', 'fixture-index-differs-from-head');
    const path = row.slice(3);
    assert(!path.includes('..') && !path.startsWith('/'), 'unsafe-archive-path');
    const content = execFileSync('git', ['-C', workspace, 'cat-file', '--filters', 'HEAD:' + path], { env, maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(join(workspace, path), content);
  }
  execFileSync('git', ['-C', workspace, 'diff', 'HEAD', '--exit-code'], { env, encoding: 'utf8' });
  const original = digest(readFileSync(join(workspace, 'README.md')));
  return { root, workspace, mount, dir, env, item, original };
}

export async function runLifecycle({ executable, tempParent = tmpdir(), model = 'github-copilot/gpt-5-mini', resumeRoot, prepareOnly = false, version = 'v1', retryProbe = false } = {}) {
  assert(['v1', 'v2'].includes(version), 'unsupported-api-version');
  const root = resumeRoot ? realpathSync.native(resumeRoot) : realpathSync.native(mkdtempSync(join(realpathSync.native(tempParent), 'factory-live-lifecycle-')));
  const { report, save } = lifecycleReport(root);
  report.result = 'FAIL'; delete report.error;
  let fx, server, api, stage = 'prepare';
  const sessions = [];
  try {
    assert(!report.apiVersion || report.apiVersion === version, 'resume-api-version-mismatch');
    report.apiVersion = version;
    fx = resumeRoot ? read(join(root, 'fixture-context.json')) : prepareLifecycle(root);
    if (!resumeRoot) writeJsonAtomic(join(root, 'fixture-context.json'), { ...fx, env: undefined });
    fx.env = { ...process.env, FACTORY_REPO_ROOT: root, FACTORY_TELEMETRY: '0',
      GIT_DIR: execFileSync('git', ['-C', SOURCE, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(),
      GIT_WORK_TREE: fx.workspace, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: join(root, 'fixture-excludes') };
    const runtime = (args) => execFileSync(process.execPath, [join(fx.mount, '_workflow/opencode/runtime.mjs'), ...args], { cwd: root, env: fx.env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
    const driver = args => execFileSync(process.execPath, [join(fx.mount, '_workflow/driver.mjs'), ...args], { cwd: root, env: fx.env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
    const progressPath = join(fx.dir, 'opencode-progress.json');
    if (!existsSync(progressPath)) {
      runtime(['init', ID, '--fixture', join(root, 'fixture.json')]);
      driver(['init']);
      const check = spawnSync(process.execPath, [join(fx.workspace, 'check-doc.mjs')], { cwd: fx.workspace, encoding: 'utf8' });
      assert(check.status === 0, 'doc-oracle-failed');
      writeFileSync(join(fx.dir, 'verify-red-raw.txt'), check.stdout);
      report.red = { exit: check.status, output: check.stdout.trim() };
    }
    if (prepareOnly) { report.result = 'PREPARED'; save(); return report; }
    stage = 'server';
    const config = lifecycleConfig(model, fx.workspace, fx.mount, version);
    if (version === 'v2') {
      const started = await launchV2(executable, root, config); server = started.server;
      api = new OpenCodeServer({ url: server.url, version, headers: started.headers, timeoutMs: 60000 });
    } else {
      server = await launch(executable, root, authenticatedEnvironment(root, config));
      api = new OpenCodeServer({ url: server.url, version, timeoutMs: 10000 });
    }
    report.endpoint = server.url; report.version = (await api.check()).version; report.pid = server.child.pid;
    const defs = await waitForOpenCodeAgents(api, root, ['factory-live-doc'], { timeoutMs: 120000 });
    const models = version === 'v1' ? availableModels(await api.request('GET', '/provider', undefined, root))
      : (await api.request('GET', '/api/model?location[directory]=' + encodeURIComponent(root))).data.map(m => m.providerID + '/' + m.id);
    assert(chooseModel(models, model) === model, 'model-unavailable');
    assert(defs.some(a => (version === 'v1' ? a.name : a.id) === 'factory-live-doc' && a.model?.providerID + '/' + (version === 'v1' ? a.model?.modelID : a.model?.id) === model), 'effective-route');
    for (const call of report.calls.filter(c => version === 'v1' && !c.sessionId && c.error === 'stale/malformed session identity or worktree')) {
      const prior = (await api.request('GET', '/session', undefined, root)).find(s => s.title === 'factory:' + call.dispatchId);
      if (prior) {
        const mapping = { sessionId: prior.id, dispatchId: call.dispatchId };
        await api.stop(mapping, root); await api.request('DELETE', '/session/' + prior.id, undefined, root);
        call.cleanup = { sessionId: prior.id, deleted: true };
      }
      rmSync(join(fx.dir, 'dispatch', call.dispatchId + '-session.json'), { force: true });
    }
    const started = Date.now();
    for (let step = 0; step < 60; step++) {
      assert(Date.now() - started < (version === 'v2' ? 6 : 20) * 60 * 1000, 'lifecycle-time-budget');
      const next = runtime(['next', ID]); const plan = JSON.parse(next.slice(next.indexOf('{')));
      const progress = read(progressPath);
      stage = progress.phase;
      if (plan.done) break;
      if (plan.mechanical) {
        const output = runtime(['mech', ID, plan.mechanical]);
        report.mechanics.push({ phase: progress.phase, command: plan.mechanical, completed: true }); save();
      } else {
        assert(report.calls.length + plan.agents.length <= (version === 'v2' ? 12 : 25), 'physical-call-budget');
        assert(report.calls.reduce((sum, c) => sum + (c.cost || 0), 0) < 1.5, 'reported-cost-budget');
        const settled = await Promise.allSettled(plan.agents.map(async descriptor => {
          const statePath = join(fx.dir, 'dispatch', descriptor.dispatchId + '-session.json');
          const call = { phase: progress.phase, role: descriptor.key, dispatchId: descriptor.dispatchId }; report.calls.push(call); save();
          const dispatchConfig = { version, pollMs: 250, agentTimeoutMs: Math.min(120000, (version === 'v2' ? 6 : 20) * 60 * 1000 - (Date.now() - started)),
            roles: { [descriptor.role]: { agent: 'factory-live-doc' } } };
          let outcome;
          try { outcome = await dispatchAgent({ descriptor: { ...descriptor, itemId: ID, runId: progress.runId }, directory: root,
            statePath, api, config: dispatchConfig, observe: () => {} }); }
          finally {
            if (existsSync(statePath)) {
              const mapping = read(statePath); sessions.push(mapping);
              Object.assign(call, { sessionId: mapping.sessionId, status: mapping.status, admitted: mapping.invoked,
                actualModel: mapping.outcome?.actualModel ?? null, usage: mapping.outcome?.usage ?? null, cost: mapping.outcome?.cost ?? null,
                value: mapping.outcome?.value ?? null, error: mapping.error });
              if (mapping.sessionId) {
                const messages = await api.messages(mapping, root);
                call.tools = messages.flatMap(m => (version === 'v1' ? m.parts : m.content || []).filter(p => p.type === 'tool').map(p => ({ tool: p.tool || p.name || p.toolID || null, status: p.state?.status,
                  command: ['node check-doc.mjs', 'node delay-check.mjs'].includes(p.state?.input?.command) ? p.state.input.command : undefined })));
              }
            }
            save();
          }
          const resultPath = join(fx.dir, 'dispatch', descriptor.dispatchId + '-result.json');
          writeJsonAtomic(resultPath, outcome.value);
          runtime(['submit', ID, '--role', descriptor.key, '--dispatch', descriptor.dispatchId, '--model', outcome.actualModel || 'unknown', '--json', resultPath]);
          save();
        }));
        const rejected = settled.find(s => s.status === 'rejected');
        if (rejected) throw rejected.reason;
      }
    }
    stage = 'finalize'; runtime(['finalize', ID]);
    const envelope = read(join(fx.mount, 'state', 'results-cycle-1-' + ID + '.json'));
    report.finalized = { state: envelope.results[0].toState, transitions: envelope.results[0].transitions,
      verificationOnly: envelope.results[0].verificationOnly, codeChange: envelope.results[0].codeChange,
      admissions: envelope.results[0].attemptObservations?.length };
    stage = 'fold';
    const controller = read(join(fx.mount, 'state/controller.json')).token;
    const foldOutput = driver(['fold', join(fx.mount, 'state/results-cycle-1-' + ID + '.json'), '--controller', controller]);
    report.foldOutput ||= foldOutput;
    const ledger = read(join(fx.mount, 'state/ledger.json'));
    report.folded = { state: ledger.items[ID].state, attempts: ledger.items[ID].attempts, cycle: ledger.cycle, journal: Object.keys(ledger.folded || {}) };
    const ledgerBeforeReplay = digest(readFileSync(join(fx.mount, 'state/ledger.json')));
    report.foldReplayOutput = driver(['fold', join(fx.mount, 'state/results-cycle-1-' + ID + '.json'), '--controller', controller]);
    report.foldReplayUnchanged = ledgerBeforeReplay === digest(readFileSync(join(fx.mount, 'state/ledger.json')));
    assert(report.foldReplayUnchanged, 'fold-replay-changed-ledger');
    assert(report.folded.state === 'CLOSED', 'fold-not-closed');
    assert(digest(readFileSync(join(fx.workspace, 'README.md'))) === fx.original, 'source-changed');
    report.elapsedMs ||= Date.now() - started;
    if (retryProbe && report.modelRetry?.result !== 'PASS') { stage = 'unavailable-model-and-fallback'; report.modelRetry = await missingModelThenFallback({ api, root, model, sessions }); }
    report.result = 'PASS';
  } catch (e) { report.error = { stage, message: e.message.slice(0, 1000) }; }
  finally {
    report.cleanup.sessions ||= [];
    for (const prior of report.cleanup.sessions.filter(s => !s.deleted && report.cleanup.sessions.some(other => other.id === s.id && other.deleted))) {
      try { await api.request('GET', (version === 'v1' ? '/session/' : '/api/session/') + prior.id, undefined, root); }
      catch (e) { if (e.status === 404) {
        const evidence = { id: prior.id, stopped: true, deleted: true, reconciledAbsent: true, server: api.url, directory: root };
        appendCleanupReceipt(root, report, 'session', evidence); report.cleanup.sessions.push(evidence); save();
      } }
    }
    for (const mapping of sessions) {
      let stopped = false, deleted = false;
      try { stopped = (await api.stop(mapping, root)).stopped; if (stopped) { const result = await api.request('DELETE', (version === 'v1' ? '/session/' : '/api/session/') + mapping.sessionId, undefined, root); deleted = version === 'v1' ? result === true : result === null; } } catch (e) { if (e.status === 404 && report.cleanup.sessions.some(s => s.id === mapping.sessionId && s.deleted)) { stopped = true; deleted = true; } }
      const evidence = { id: mapping.sessionId, dispatchId: mapping.dispatchId, messageId: mapping.messageId, server: mapping.server || api?.url, directory: root, stopped, deleted };
      appendCleanupReceipt(root, report, 'session', evidence);
      report.cleanup.sessions.push(evidence); save();
    }
    report.cleanup.serverStopped = server ? await stopServer(server) : null;
    report.cleanup.servers ||= [];
    if (server) {
      const evidence = { pid: server.child.pid, server: server.url, stopped: report.cleanup.serverStopped };
      appendCleanupReceipt(root, report, 'server', evidence); report.cleanup.servers.push(evidence);
    }
    report.cleanup.artifactsRetained = true;
    const latest = [...new Map(report.cleanup.sessions.map(s => [s.id, s])).values()];
    if (latest.some(s => !s.stopped || !s.deleted) || report.cleanup.serverStopped === false) report.result = 'FAIL';
    save();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--prepare-only') { options.prepareOnly = true; continue; }
    if (process.argv[i] === '--retry-probe') { options.retryProbe = true; continue; }
    const key = { '--executable': 'executable', '--temp-parent': 'tempParent', '--model': 'model', '--resume-root': 'resumeRoot', '--version': 'version' }[process.argv[i]];
    assert(key && process.argv[i + 1], 'invalid-option'); options[key] = process.argv[++i];
  }
  const report = await runLifecycle(options); console.log(JSON.stringify(report, null, 2)); process.exitCode = ['PASS', 'PREPARED'].includes(report.result) ? 0 : 1;
}
