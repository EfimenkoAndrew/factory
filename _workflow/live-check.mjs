import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeServer } from './opencode/server-api.mjs';

const help = `Usage: node _workflow/live-check.mjs [--executable PATH] [--api-version v1] [--temp-parent PATH]

Zero-dependency local capability verifier. Starts its own isolated loopback server,
checks installed v1 version, schema and empty-session lifecycle, then deletes its
session, stops its server and removes only its own generated temporary directory.
No prompts, paid model requests or agent tool executions are supported.
Default executable: opencode (use the native opencode.exe path on Windows).
Default temp parent: OS temporary directory; an explicit parent must already exist.
v2 live verification is pending; --api-version v2 is rejected before launch.
JSON stdout contains allowlisted results only, never credentials or server logs.
Exit 0: PASS; exit 1: failed/pending capability or cleanup; --help: no launch.
`;

export function isolatedEnvironment(root, source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(systemroot|windir|comspec|path|pathext)$/i.test(key)) env[key] = value;
  }
  return Object.assign(env, {
    HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), TEMP: root, TMP: root,
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PRUNE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: 'https://opencode.ai/config.json',
      snapshot: false, autoupdate: false, share: 'disabled', permission: 'deny',
      enabled_providers: [], plugin: [], mcp: {}, formatter: false, lsp: false }),
  });
}

function requireCheck(value) { if (!value) throw new Error('capability check failed'); }

function contained(root, path) {
  if (typeof path !== 'string') return false;
  const rel = relative(realpathSync.native(root), realpathSync.native(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'));
}

function start(executable, args, options, spawnProcess) {
  const child = spawnProcess(executable, args, { ...options, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, output: '', url: null, closed: false, failed: false };
  child.on('error', () => { state.failed = true; });
  child.on('close', () => { state.closed = true; });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', b => {
    state.output = (state.output + b.toString()).slice(-16000);
    state.url ||= state.output.match(/http:\/\/127\.0\.0\.1:[1-9]\d*\b/)?.[0];
  });
  return state;
}

async function waitFor(predicate, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('deadline exceeded');
    await delay(25, undefined, { signal });
  }
  signal?.throwIfAborted();
}

async function stopProcess(state) {
  if (!state || state.closed) return true;
  try {
    state.child.kill();
    try { await waitFor(() => state.closed, 3000); }
    catch { state.child.kill('SIGKILL'); await waitFor(() => state.closed, 3000); }
    return true;
  } catch { return false; }
}

export function safeConfigSummary(config) {
  return {
    snapshotDisabled: config.snapshot === false, sharingDisabled: config.share === 'disabled',
    configuredModel: null, modelStatus: Object.hasOwn(config, 'model') ? 'configured-unverified' : 'unknown',
  };
}

function guardedFetch(origin, signal, fetchImpl) {
  return (url, options) => {
    const u = new URL(url);
    const method = options.method;
    const sessionPath = /^\/session\/ses[a-zA-Z0-9_-]+(?:\/(?:message|abort))?$/.test(u.pathname);
    const allowed = method === 'GET' && (['/global/health', '/doc', '/path', '/config', '/provider', '/agent', '/session', '/session/status'].includes(u.pathname) || sessionPath)
      || method === 'POST' && (u.pathname === '/session' || (sessionPath && u.pathname.endsWith('/abort')))
      || method === 'DELETE' && /^\/session\/ses[a-zA-Z0-9_-]+$/.test(u.pathname);
    requireCheck(u.origin === origin && allowed);
    return fetchImpl(u, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, options.signal]) : options.signal });
  };
}

export async function runLiveCheck({ executable = 'opencode', apiVersion = 'v1', tempParent = tmpdir(), timeoutMs = 30000, signal } = {},
  { spawnProcess = spawn, fetchImpl = fetch } = {}) {
  const report = { result: 'FAIL', apiVersion: ['v1', 'v2'].includes(apiVersion) ? apiVersion : 'unsupported',
    installedVersion: null, providerCalls: 0, promptsSent: 0, toolExecutions: 0, actualModel: null,
    v2: { status: 'pending', reason: 'Not live-verified; this verifier supports v1 only.' }, checks: [],
    cleanup: { ownSessionDeleted: null, ownServerStopped: null, ownTempRemoved: null } };
  if (apiVersion !== 'v1') { report.error = 'unsupported-api-version'; return report; }
  let root, versionProcess, server, api, session, workspace, stage = 'temporary-isolation';
  try {
    root = realpathSync.native(mkdtempSync(join(realpathSync.native(tempParent), 'factory-live-check-')));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const options = { cwd: workspace, env: isolatedEnvironment(root) };
    stage = 'installed-version';
    versionProcess = start(executable, ['--version'], options, spawnProcess);
    await waitFor(() => versionProcess.closed || versionProcess.failed, timeoutMs, signal);
    requireCheck(!versionProcess.failed && versionProcess.child.exitCode === 0);
    const version = versionProcess.output.trim();
    requireCheck(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version));
    report.installedVersion = version;
    requireCheck(/^1\./.test(version));
    report.checks.push(stage);
    stage = 'server-start';
    server = start(executable, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '0'], options, spawnProcess);
    await waitFor(() => server.url || server.failed || server.closed, timeoutMs, signal);
    requireCheck(server.url && !server.failed && !server.closed);
    api = new OpenCodeServer({ url: server.url, version: 'v1', timeoutMs,
      fetchImpl: guardedFetch(server.url, signal, fetchImpl) });
    stage = 'runtime-health';
    const health = await api.check();
    requireCheck(health.version === version);
    report.checks.push(stage);
    stage = 'endpoint-schema';
    const spec = await api.request('GET', '/doc');
    const needed = [
      ['get', '/global/health'], ['get', '/agent'], ['get', '/session'], ['post', '/session'],
      ['get', '/session/status'], ['get', '/session/{sessionID}'], ['get', '/session/{sessionID}/message'],
      ['post', '/session/{sessionID}/prompt_async'], ['post', '/session/{sessionID}/abort'], ['delete', '/session/{sessionID}'],
    ];
    report.endpoints = needed.map(([method, path]) => ({ method, path, present: Boolean(spec.paths?.[path]?.[method]) }));
    requireCheck(report.endpoints.every(e => e.present));
    report.checks.push(stage);
    stage = 'path-isolation';
    const paths = await api.request('GET', '/path', undefined, workspace);
    for (const key of ['home', 'config', 'directory']) {
      stage = 'path-isolation-' + key;
      requireCheck(contained(root, paths[key]));
    }
    stage = 'path-isolation-directory-binding';
    requireCheck(realpathSync.native(paths.directory) === realpathSync.native(workspace));
    stage = 'isolated-database';
    requireCheck(existsSync(join(root, 'data', 'opencode', 'opencode.db')));
    report.checks.push('path-isolation', stage);
    stage = 'isolated-config';
    const config = await api.request('GET', '/config', undefined, workspace);
    report.config = safeConfigSummary(config);
    requireCheck(report.config.snapshotDisabled && report.config.sharingDisabled);
    requireCheck(config.permission === 'deny' || config.permission?.['*'] === 'deny');
    requireCheck(Array.isArray(config.enabled_providers) && config.enabled_providers.length === 0);
    requireCheck(Array.isArray(config.plugin) && config.plugin.length === 0 && Object.keys(config.mcp || {}).length === 0);
    const providers = await api.request('GET', '/provider', undefined, workspace);
    requireCheck(Array.isArray(providers.connected) && providers.connected.length === 0);
    report.checks.push(stage);
    stage = 'agent-envelope';
    report.agentCount = (await api.agents(workspace)).length;
    report.checks.push(stage);
    stage = 'session-create-idempotency';
    const dispatch = { dispatchId: 'no-model-local-fixture' };
    session = await api.create(dispatch, workspace, {});
    requireCheck(await api.create(dispatch, workspace, {}) === session);
    report.checks.push(stage);
    const mapping = { sessionId: session, dispatchId: dispatch.dispatchId, messageId: 'msg_never_sent' };
    stage = 'session-identity';
    await api.verifySession(mapping, workspace);
    report.checks.push(stage);
    stage = 'empty-idle-pending';
    requireCheck((await api.messages(mapping, workspace)).length === 0);
    requireCheck(await api.executionIdle(mapping, workspace) === true);
    const outcome = await api.outcome(mapping, workspace);
    requireCheck(outcome.pending === true && Object.keys(outcome).length === 1);
    report.checks.push(stage);
    stage = 'abort-reconciliation';
    requireCheck((await api.stop(mapping, workspace)).stopped === true);
    report.checks.push(stage);
    report.result = 'PASS';
  } catch {
    report.error = signal?.aborted ? 'interrupted' : stage;
  } finally {
    if (session && api) {
      try {
        const cleanupApi = new OpenCodeServer({ url: server.url, version: 'v1', timeoutMs: 3000,
          fetchImpl: guardedFetch(server.url, undefined, fetchImpl) });
        report.cleanup.ownSessionDeleted = await cleanupApi.request('DELETE', '/session/' + encodeURIComponent(session), undefined, workspace) === true;
      } catch { report.cleanup.ownSessionDeleted = false; }
    }
    const versionStopped = await stopProcess(versionProcess);
    report.cleanup.ownServerStopped = server ? await stopProcess(server) : null;
    if (root && versionStopped && report.cleanup.ownServerStopped !== false) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); report.cleanup.ownTempRemoved = !existsSync(root); }
      catch { report.cleanup.ownTempRemoved = false; }
    } else if (root) report.cleanup.ownTempRemoved = false;
    if (!versionStopped || Object.values(report.cleanup).includes(false)) { report.result = 'FAIL'; report.error ||= 'cleanup'; }
  }
  return report;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return 0; }
  const options = {};
  const names = { '--executable': 'executable', '--api-version': 'apiVersion', '--temp-parent': 'tempParent' };
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, key)) {
      console.error('Invalid arguments; use --help.'); return 1;
    }
    options[key] = args[i + 1];
  }
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const report = await runLiveCheck({ ...options, signal: abort.signal });
    console.log(JSON.stringify(report, null, 2));
    return report.result === 'PASS' ? 0 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
