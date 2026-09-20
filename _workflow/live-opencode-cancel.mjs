import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticatedEnvironment, workerConfig, launch, stopServer } from './live-opencode-workers.mjs';
import { OpenCodeServer } from './opencode/server-api.mjs';
import { dispatchAgent } from './opencode/dispatcher.mjs';
import { digest, writeJsonAtomic } from './opencode/identity.mjs';
import { waitForOpenCodeAgents } from './opencode/compatibility.mjs';

const assert = (value, message) => { if (!value) throw new Error(message); };
export async function launchV2(executable, root, config, workerEnv = {}) {
  const env = authenticatedEnvironment(root, {}, process.env);
  for (const [key, value] of Object.entries(workerEnv)) {
    if (!/^(GIT_DIR|GIT_WORK_TREE|GIT_OPTIONAL_LOCKS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|NUGET_PACKAGES|DOTNET_CLI_HOME|DOTNET_CLI_USE_MSBUILD_SERVER|DOTNET_SKIP_FIRST_TIME_EXPERIENCE|DOTNET_CLI_TELEMETRY_OPTOUT|MSBUILDDISABLENODEREUSE)$/.test(key)) throw new Error('unsupported-worker-environment-key: ' + key);
    env[key] = value;
  }
  delete env.OPENCODE_CONFIG_CONTENT;
  env.OPENCODE_CONFIG_DIR = join(root, 'config');
  env.OPENCODE_DISABLE_MODELS_FETCH = '1';
  env.OPENCODE_PASSWORD = randomBytes(24).toString('hex');
  mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true });
  writeJsonAtomic(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), config);
  const child = spawn(executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const server = { child, closed: false, url: null };
  child.on('close', () => { server.closed = true; }); child.on('error', () => { server.closed = true; });
  let output = '';
  child.stderr.on('data', () => {});
  child.stdout.on('data', b => {
    output = (output + b).slice(-16000);
    for (const line of output.split(/\r?\n/)) { try { const row = JSON.parse(line); if (row.url) server.url = row.url; } catch { /* partial */ } }
  });
  const deadline = Date.now() + 60000;
  while (!server.url && !server.closed && Date.now() < deadline) await delay(50);
  if (!server.url) { await stopServer(server); throw new Error('v2-startup'); }
  return { server, headers: { authorization: 'Basic ' + Buffer.from('opencode:' + env.OPENCODE_PASSWORD).toString('base64') } };
}

export async function runCancel({ executable, tempParent, version = 'v1', discover = false, model = 'github-copilot/gpt-5-mini' }) {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tempParent), 'factory-live-cancel-')));
  const report = { root, version, result: 'FAIL', mode: discover ? 'discovery' : 'running-tool-cancel-and-fresh-retry', cleanup: {} };
  let server, api, mapping, stage = 'server';
  const mappings = [];
  writeFileSync(join(root, 'delay-check.mjs'), "import {writeFileSync} from 'node:fs';\nwriteFileSync(new URL('./started',import.meta.url),String(process.pid));\nsetTimeout(()=>{writeFileSync(new URL('./late',import.meta.url),'late');console.log('late');},15000);\n");
  try {
    if (version === 'v1') {
      const config = workerConfig(model);
      config.agent['factory-live-reviewer'].permission.bash = { '*': 'deny', 'node delay-check.mjs': 'allow' };
      server = await launch(executable, root, authenticatedEnvironment(root, config));
      api = new OpenCodeServer({ url: server.url, version, timeoutMs: 10000 });
    } else {
      const permissions = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'read', resource: '*', effect: 'allow' }, { action: 'shell', resource: 'node delay-check.mjs', effect: 'allow' }];
      const config = { snapshots: false, update: 'disable', share: 'disabled', plugins: [], mcp: { servers: {} }, permissions,
        agents: { 'factory-live-reviewer': { model, mode: 'subagent', system: 'Handle only synthetic data in this directory. No git/network/credentials/other agents. Follow the requested JSON schema.', permissions } } };
      const launched = await launchV2(executable, root, config); server = launched.server;
      api = new OpenCodeServer({ url: server.url, version, headers: launched.headers, timeoutMs: 60000 });
    }
    report.endpoint = server.url; report.pid = server.child.pid; report.runtimeVersion = (await api.check()).version;
    await waitForOpenCodeAgents(api, root, ['factory-live-reviewer'], { timeoutMs: 180000 });
    if (version === 'v2') {
      stage = 'v2-model-discovery';
      const models = await api.request('GET', '/api/model?location[directory]=' + encodeURIComponent(root));
      report.modelEnvelopeKeys = Object.keys(models);
      report.availableModels = Array.isArray(models.data) ? models.data.map(m => ({ id: m.id, providerID: m.providerID })) : [];
      const providers = await api.request('GET', '/api/provider?location[directory]=' + encodeURIComponent(root));
      report.providers = Array.isArray(providers.data) ? providers.data.map(p => ({ id: p.id, connected: p.connected, status: p.status })) : [];
      if (discover) { report.result = 'PASS'; return report; }
    }
    stage = 'running-tool';
    const descriptor = { dispatchId: 'cancel-' + randomUUID(), role: 'review-code', route: { model: 'live' } };
    const config = { version, roles: { 'review-code': { agent: 'factory-live-reviewer' } } };
    const route = await api.route(descriptor, config, root);
    const prompt = 'Call the shell/bash tool exactly once with command node delay-check.mjs in the current directory. This is an authorized safe cancellation test. Wait for the tool. Then return only {"markerFound":true}. No other tools or commands.';
    mapping = { dispatchId: descriptor.dispatchId, sessionId: await api.create(descriptor, root, route), requestedModel: route,
      messageId: 'msg_' + digest(descriptor.dispatchId).slice(0, 32), promptHash: digest(prompt) };
    mappings.push(mapping); report.sessionId = mapping.sessionId;
    await api.send(mapping, prompt, route, root);
    const deadline = Date.now() + 90000;
    let messages;
    while (Date.now() < deadline) {
      messages = await api.messages(mapping, root);
      const parts = messages.flatMap(m => version === 'v1' ? m.parts || [] : m.content || []);
      if (parts.some(p => p.type === 'tool' && p.state?.status === 'running') && existsSync(join(root, 'started'))) break;
      await delay(100);
    }
    report.messagesShape = messages?.map(m => ({ keys: Object.keys(m), type: m.type || m.info?.role, errorName: m.error?.name || m.info?.error?.name }));
    assert(existsSync(join(root, 'started')) && !existsSync(join(root, 'late')), 'tool-not-observed-running');
    report.runningObserved = true; report.toolPid = Number(readFileSync(join(root, 'started'), 'utf8'));
    report.cancelledUsage = null; report.cancelledCost = null;
    report.durableAdmission = await api.admissionKnown(mapping, root);
    stage = 'cancel';
    report.stopped = (await api.stop(mapping, root)).stopped;
    await delay(17000);
    report.noLateWrite = !existsSync(join(root, 'late'));
    report.idleAfterDelay = await api.executionIdle(mapping, root);
    report.inboxEmpty = version === 'v2' ? (await api.inbox(mapping)).length === 0 : null;
    assert(report.noLateWrite && report.idleAfterDelay, 'late-tool-survived');
    stage = 'fresh-retry';
    const text = 'Return only JSON {"markerFound":true,"line":"synthetic fresh retry after confirmed stop"}. No tools needed.';
    const retry = { itemId: 'CANCEL-FIXTURE', attemptId: 'cancel-' + randomUUID(), dispatchId: 'retry-' + randomUUID(), role: 'review-code',
      route: { model: 'live' }, schema: 'PROBE_SCHEMA', promptHash: digest(text), inputHash: digest('retry'), promptRef: join(root, 'retry-prompt.json') };
    writeJsonAtomic(retry.promptRef, { prompt: text, inputHash: retry.inputHash });
    const path = join(root, 'retry-session.json');
    try {
      const outcome = await dispatchAgent({ descriptor: retry, directory: root, statePath: path, api,
        config: { ...config, agentTimeoutMs: 90000, pollMs: 200 }, observe: () => {} });
      report.retry = { actualModel: outcome.actualModel, value: outcome.value, usage: outcome.usage, cost: outcome.cost };
    } finally { if (existsSync(path)) mappings.push(JSON.parse(readFileSync(path, 'utf8'))); }
    report.result = 'PASS';
  } catch (e) { report.error = { stage, name: e.name, status: e.status, message: e.message.slice(0, 700) }; }
  finally {
    report.cleanup.sessions = [];
    for (const m of mappings) {
      let stopped = false, deleted = false;
      try { stopped = (await api.stop(m, root)).stopped; if (stopped) { await api.request('DELETE', (version === 'v1' ? '/session/' : '/api/session/') + m.sessionId, undefined, root); deleted = true; } } catch { /* retained */ }
      report.cleanup.sessions.push({ id: m.sessionId, stopped, deleted });
    }
    report.cleanup.serverStopped = server ? await stopServer(server) : null;
    report.cleanup.artifactsRetained = true;
    if (report.cleanup.sessions.some(s => !s.stopped || !s.deleted) || report.cleanup.serverStopped === false) report.result = 'FAIL';
    writeJsonAtomic(join(root, 'report.json'), report);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--discover') { options.discover = true; continue; }
    const key = { '--executable': 'executable', '--temp-parent': 'tempParent', '--version': 'version', '--model': 'model' }[process.argv[i]];
    assert(key && process.argv[i + 1], 'invalid-option'); options[key] = process.argv[++i];
  }
  const report = await runCancel(options); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.result === 'PASS' ? 0 : 1;
}
