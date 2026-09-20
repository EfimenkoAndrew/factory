import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeServer } from './opencode/server-api.mjs';
import { dispatchAgent } from './opencode/dispatcher.mjs';
import { digest, writeJsonAtomic } from './opencode/identity.mjs';
import { SCHEMAS, validateNamed } from './opencode/schemas.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const check = (condition, label) => { if (!condition) throw new Error(label); };

export function workerConfig(model) {
  const permission = { '*': 'deny', read: 'allow', edit: 'deny', bash: { '*': 'deny', 'node check.mjs': 'allow' }, external_directory: 'deny' };
  const agent = (writer) => ({ description: 'Synthetic factory live validation worker', mode: 'all', steps: 6,
    ...(model ? { model } : {}), permission: { ...permission, edit: writer ? { '*': 'deny', '*.mjs': 'allow', '**/*.mjs': 'allow' } : 'deny' },
    prompt: 'Only handle the synthetic fixture in the current directory. Never access credentials, external paths, network, git, or other agents. Use at most four tool calls. Return only the requested JSON.' });
  return { $schema: 'https://opencode.ai/config.json', snapshot: false, autoupdate: false, share: 'disabled',
    instructions: [], plugin: [], mcp: {}, formatter: false, lsp: false, permission: { '*': 'deny' },
    agent: { 'factory-live-writer': agent(true), 'factory-live-reviewer': agent(false) } };
}

export function authenticatedEnvironment(root, config, source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(systemroot|windir|comspec|path|pathext|home|userprofile|appdata|localappdata|xdg_data_home)$/i.test(key)) env[key] = value;
  }
  return Object.assign(env, { XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'), TEMP: root, TMP: root,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PRUNE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config) });
}

export function availableModels(providers) {
  return (providers.all || []).filter(p => providers.connected?.includes(p.id))
    .flatMap(p => Object.keys(p.models || {}).map(id => p.id + '/' + id)).sort();
}

export function chooseModel(models, requested) {
  if (requested) { check(models.includes(requested), 'requested-model-unavailable'); return requested; }
  const candidates = ['github-copilot/gpt-4.1', 'github-copilot/gpt-5-mini', 'github-copilot/gpt-6-astra'];
  const model = candidates.find(m => models.includes(m));
  check(model, 'pass-explicit-connected-model');
  return model;
}

async function until(fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!await fn()) { check(Date.now() < deadline, 'deadline'); await delay(50); }
}

export async function launch(executable, workspace, env) {
  const child = spawn(executable, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'],
    { cwd: workspace, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = { child, closed: false, url: null, failed: false };
  child.on('close', () => { server.closed = true; });
  child.on('error', () => { server.failed = true; });
  let buffer = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => {
    buffer = (buffer + b.toString()).slice(-16000);
    server.url ||= buffer.match(/http:\/\/127\.0\.0\.1:[1-9]\d*\b/)?.[0];
  });
  try { await until(() => server.url || server.closed || server.failed); check(server.url && !server.closed && !server.failed, 'server-start'); }
  catch (e) { await stopServer(server); throw e; }
  return server;
}

export async function stopServer(server) {
  if (!server || server.closed) return true;
  server.child.kill();
  try { await until(() => server.closed, 5000); }
  catch { server.child.kill('SIGKILL'); await until(() => server.closed, 5000); }
  return true;
}

export function toolEvidence(messages) {
  return messages.flatMap(m => (m.parts || []).filter(p => p.type === 'tool').map(p => ({
    tool: p.tool, status: p.state?.status, command: p.state?.input?.command === 'node check.mjs' ? 'node check.mjs' : undefined,
  })));
}

export async function runLiveWorkers({ executable = 'opencode', tempParent = tmpdir(), model, discover = false, timeoutMs = 90000 } = {}) {
  check(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 180000, 'timeout-out-of-bounds');
  const report = { result: 'FAIL', scope: 'real-dispatchAgent-synthetic-fixture', factoryClaimFold: false,
    workerCalls: 0, checks: [], workers: [], cleanup: { sessions: [], servers: [], tempRemoved: false } };
  let root, workspace, api, server, stage = 'setup';
  const sessions = new Set();
  const mappings = [];
  try {
    root = realpathSync.native(mkdtempSync(join(realpathSync.native(tempParent), 'factory-live-workers-')));
    report.tempRoot = root;
    workspace = join(root, 'fixture'); mkdirSync(workspace);
    writeFileSync(join(workspace, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
    writeFileSync(join(workspace, 'check.mjs'), "import { sum } from './sum.mjs';\nif (sum(2, 3) !== 5 || sum(-2, 3) !== 1) throw new Error('fixture failed');\nconsole.log('FIXTURE_PASS');\n");
    const start = async config => {
      server = await launch(executable, workspace, authenticatedEnvironment(root, config));
      api = new OpenCodeServer({ url: server.url, version: 'v1', timeoutMs: 10000,
        fetchImpl: (url, options) => { check(new URL(url).origin === server.url, 'foreign-origin'); return fetch(url, { ...options, redirect: 'error' }); } });
      const health = await api.check(); report.version = health.version;
      report.endpoint = server.url;
    };
    stage = 'discovery'; await start(workerConfig());
    const spec = await api.request('GET', '/doc');
    report.promptFields = Object.keys(spec.paths?.['/session/{sessionID}/prompt_async']?.post?.requestBody?.content?.['application/json']?.schema?.properties || {});
    const providers = await api.request('GET', '/provider', undefined, workspace);
    report.availableModels = availableModels(providers);
    report.availableAgents = (await api.agents(workspace)).map(a => a.name);
    if (discover) { report.result = 'PASS'; return report; }
    model = chooseModel(report.availableModels, model); report.selectedModel = model;
    report.cleanup.servers.push({ pid: server.child.pid, stopped: await stopServer(server) }); server = null;
    stage = 'configured-server'; await start(workerConfig(model));
    const config = await api.request('GET', '/config', undefined, workspace);
    check(config.snapshot === false && config.share === 'disabled' && Object.keys(config.mcp || {}).length === 0 && (config.plugin || []).length === 0, 'effective-config');
    const definitions = await api.agents(workspace);
    for (const name of ['factory-live-writer', 'factory-live-reviewer']) {
      const agent = definitions.find(a => a.name === name);
      check(agent?.steps === 6 && agent.model?.providerID + '/' + agent.model?.modelID === model, 'effective-agent');
    }
    report.checks.push('runtime-validated-config', 'effective-model-mapping');
    const dispatchConfig = { version: 'v1', pollMs: 200, agentTimeoutMs: timeoutMs,
      roles: { fixer: { agent: 'factory-live-writer' }, 'review-code': { agent: 'factory-live-reviewer' } } };
    writeJsonAtomic(join(root, 'dispatch-config.json'), dispatchConfig);
    const call = async (name, role, schema, instructions) => {
      check(report.workerCalls < 6, 'worker-budget');
      const prompt = instructions + '\nReturn JSON only conforming to: ' + JSON.stringify(SCHEMAS[schema]);
      const descriptor = { itemId: 'SYNTHETIC', attemptId: 'live-' + root.split(/[\\/]/).at(-1), dispatchId: name + '-' + randomUUID(),
        role, schema, route: { model: 'live' }, promptHash: digest(prompt), inputHash: digest(instructions), promptRef: join(root, name + '-prompt.json') };
      writeJsonAtomic(descriptor.promptRef, { prompt, inputHash: descriptor.inputHash, outputSchema: SCHEMAS[schema] });
      const statePath = join(root, name + '-session.json'); mappings.push(statePath);
      report.workerCalls++;
      const args = { descriptor, directory: workspace, statePath, api, config: dispatchConfig, observe: () => {} };
      let outcome;
      try { outcome = await dispatchAgent(args); }
      finally {
        if (existsSync(statePath)) {
          const state = read(statePath);
          let messages = [];
          try { if (state.sessionId) messages = await api.messages(state, workspace); } catch { /* no evidence fabricated on unreadable messages */ }
          if (state.sessionId) sessions.add(state.sessionId);
          report.workers.push({ name, sessionId: state.sessionId, messageId: state.messageId, status: state.status,
            admitted: state.invoked === true, stopped: state.stopped === true, actualModel: state.outcome?.actualModel ?? null,
            usage: state.outcome?.usage ?? null, cost: state.outcome?.cost ?? null, result: state.outcome?.value ?? null,
            failure: state.error ? { timeout: state.error === 'agent timeout', name: state.outcome?.error?.name ?? null,
              local: ['durable prompt content mismatch', 'foreign user input in dispatch session', 'message session identity mismatch', 'stale/malformed session identity or worktree', 'agent timeout', 'missing agent response'].includes(state.error) ? state.error : null,
              responseParse: /JSON|Unexpected|structured response/i.test(state.error),
              statusCode: state.outcome?.error?.data?.statusCode ?? null,
              category: /model.*not.*support|unsupported.*model/i.test(state.error) ? 'unsupported-model' : /auth|unauthorized|token/i.test(state.error) ? 'authentication' : /permission|denied/i.test(state.error) ? 'permission' : /not found/i.test(state.error) ? 'not-found' : 'other' } : null,
            messages: messages.map(m => ({ role: m.info?.role, finish: m.info?.finish, errorName: m.info?.error?.name, completed: Boolean(m.info?.time?.completed), textLengths: m.parts.filter(p => p.type === 'text').map(p => p.text.length) })),
            tools: toolEvidence(messages) });
        }
      }
      check(validateNamed(schema, outcome.value).ok && outcome.actualModel === model, 'schema-or-route');
      const state = read(statePath);
      check(await api.admissionKnown(state, workspace), 'durable-prompt');
      const messages = await api.messages(state, workspace);
      check(messages.filter(m => m.info.role === 'user').length === 1, 'fresh-user-history');
      const replay = await dispatchAgent(args);
      check(digest(replay.value) === digest(outcome.value) && (await api.messages(state, workspace)).length === messages.length, 'replay');
      return { outcome, state, tools: toolEvidence(messages) };
    };
    stage = 'writer';
    const writer = await call('writer', 'fixer', 'FIX_SCHEMA', 'Read sum.mjs, fix subtraction to addition using the edit tool. Edit only sum.mjs. Then execute exactly node check.mjs using the bash tool. Report applied true and scopeStop false only if the check succeeds.');
    check(readFileSync(join(workspace, 'sum.mjs'), 'utf8').includes('a + b'), 'fixture-write');
    check(writer.tools.some(t => ['edit', 'apply_patch', 'write'].includes(t.tool) && t.status === 'completed') && writer.tools.some(t => t.command === 'node check.mjs' && t.status === 'completed'), 'writer-tools');
    stage = 'reviewer';
    const reviewer = await call('reviewer', 'review-code', 'GATE_SCHEMA', 'Independently review sum.mjs by reading it with a tool, then execute exactly node check.mjs using the bash tool. The acceptance is sum(2,3)=5 and sum(-2,3)=1. Do not edit. Return verdict APPROVED only if independently verified, with a concise headline and findings array.');
    check(reviewer.state.sessionId !== writer.state.sessionId && reviewer.tools.some(t => t.command === 'node check.mjs' && t.status === 'completed'), 'independent-review');
    check(reviewer.outcome.value.verdict === 'APPROVED', 'review-verdict');
    report.checks.push('actual-file-edit', 'actual-shell-check', 'fresh-independent-review', 'json-schema', 'durable-admission', 'completed-replay-no-resend');
    report.result = 'PASS';
  } catch { report.error = stage; }
  finally {
    for (const path of mappings) if (existsSync(path)) { const state = read(path); if (state.sessionId) sessions.add(state.sessionId); }
    for (const id of sessions) {
      let stopped = false, deleted = false;
      try {
        const state = mappings.map(p => existsSync(p) ? read(p) : {}).find(s => s.sessionId === id);
        stopped = (await api.stop(state, workspace)).stopped === true;
        if (stopped) deleted = await api.request('DELETE', '/session/' + id, undefined, workspace) === true;
      } catch { /* report exact cleanup status below */ }
      report.cleanup.sessions.push({ id, stopped, deleted });
    }
    if (server) {
      let stopped = false; try { stopped = await stopServer(server); } catch { /* retained */ }
      report.cleanup.servers.push({ pid: server.child.pid, stopped });
    }
    if (root && report.cleanup.servers.every(s => s.stopped) && report.cleanup.sessions.every(s => s.stopped && s.deleted)) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.cleanup.tempRemoved = !existsSync(root); } catch { /* retained */ }
    }
    if (!report.cleanup.tempRemoved) { report.result = 'FAIL'; report.error ||= 'cleanup'; }
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log('node _workflow/live-opencode-workers.mjs [--discover] [--model provider/id] [--executable PATH] [--temp-parent PATH]\nReal model calls (max 6), synthetic TEMP fixture, default user auth; no credentials copied or printed.'); return 0; }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--discover') { options.discover = true; continue; }
    const key = { '--model': 'model', '--executable': 'executable', '--temp-parent': 'tempParent' }[args[i]];
    check(key && args[i + 1] && !args[i + 1].startsWith('--'), 'invalid-arguments'); options[key] = args[++i];
  }
  const report = await runLiveWorkers(options); console.log(JSON.stringify(report, null, 2)); return report.result === 'PASS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
