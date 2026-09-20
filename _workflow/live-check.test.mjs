import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, runLiveCheck, safeConfigSummary } from './live-check.mjs';
import { OpenCodeServer } from './opencode/server-api.mjs';

function fixture(t, changes = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'factory-live-test-'));
  writeFileSync(join(parent, 'owner-file'), 'keep');
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const calls = [], children = [], requests = [];
  let root, workspace, session, server;
  const spawnProcess = (exe, args, options) => {
    calls.push({ exe, args, options });
    assert.equal(options.shell, false);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
    children.push(child);
    const close = () => { child.exitCode = 0; child.emit('close', 0); };
    child.kill = () => { if (server) server.close(close); else close(); return true; };
    queueMicrotask(() => {
      if (changes.spawnError) { child.emit('error', new Error('credential-secret')); close(); return; }
      if (args[0] === '--version') { child.stdout.write(changes.version || '1.18.31\n'); close(); return; }
      if (changes.startupTimeout) return;
      root = options.env.HOME; workspace = options.cwd;
      for (const path of ['config', 'data/opencode']) mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, 'data/opencode/opencode.db'), 'fixture');
      server = createServer((req, res) => {
        const u = new URL(req.url, 'http://localhost');
        requests.push([req.method, u.pathname]);
        let body;
        if (u.pathname === '/global/health') body = { healthy: true, version: changes.healthVersion || '1.18.31' };
        else if (u.pathname === '/doc') {
          const paths = {};
          for (const [method, path] of [
            ['get', '/global/health'], ['get', '/agent'], ['get', '/session'], ['post', '/session'],
            ['get', '/session/status'], ['get', '/session/{sessionID}'], ['get', '/session/{sessionID}/message'],
            ['post', '/session/{sessionID}/prompt_async'], ['post', '/session/{sessionID}/abort'], ['delete', '/session/{sessionID}'],
          ]) (paths[path] ||= {})[method] = {};
          if (changes.missingEndpoint) delete paths['/session/{sessionID}/prompt_async'];
          body = { paths };
        } else if (u.pathname === '/path') body = {
          home: changes.escape ? dirname(root) : root, config: join(root, 'config'), directory: workspace, worktree: '/',
        };
        else if (u.pathname === '/config') body = { ...JSON.parse(options.env.OPENCODE_CONFIG_CONTENT),
          permission: { '*': 'deny' }, provider: { secret: 'credential-secret' }, ...(changes.config || {}) };
        else if (u.pathname === '/provider') body = { connected: changes.connected || [], all: [] };
        else if (u.pathname === '/agent') body = [{ name: 'build', prompt: 'credential-secret' }];
        else if (u.pathname === '/session/status') body = {};
        else if (u.pathname === '/session') {
          if (req.method === 'POST') {
            session = { id: 'ses_fixture', title: 'factory:no-model-local-fixture', directory: workspace };
            body = session;
          } else body = session ? [session] : [];
        } else if (u.pathname === '/session/ses_fixture') {
          if (req.method === 'DELETE') { body = !changes.deleteFailure; session = null; }
          else body = changes.identityFailure ? { ...session, directory: parent } : session;
        } else if (u.pathname === '/session/ses_fixture/message') body = [];
        else if (u.pathname === '/session/ses_fixture/abort') body = true;
        else { res.statusCode = 500; body = { error: 'credential-secret' }; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      });
      server.listen(0, '127.0.0.1', () => child.stdout.write('http://127.0.0.1:' + server.address().port + '\n'));
    });
    return child;
  };
  t.after(() => server?.close());
  return { parent, calls, children, requests, spawnProcess, root: () => root };
}

test('environment excludes credentials, inherited config and provider access', () => {
  const env = isolatedEnvironment('/isolated', { Path: 'native-bin', SystemRoot: 'windows',
    OPENAI_API_KEY: 'credential-secret', OPENCODE_CONFIG_CONTENT: 'credential-secret', NODE_OPTIONS: 'credential-secret',
    HTTP_PROXY: 'credential-secret', OPENCODE_SERVER_PASSWORD: 'credential-secret' });
  assert.equal(env.Path, 'native-bin');
  assert.equal(JSON.stringify(env).includes('credential-secret'), false);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.permission, 'deny');
  assert.deepEqual(config.enabled_providers, []);
  assert.deepEqual(config.plugin, []);
  assert.deepEqual(config.mcp, {});
  assert.deepEqual(safeConfigSummary({}).modelStatus, 'unknown');
  assert.equal(safeConfigSummary({ model: 'credential-secret' }).modelStatus, 'configured-unverified');
  assert.equal(safeConfigSummary({ model: 'credential-secret' }).configuredModel, null);
});

test('local HTTP lifecycle uses actual adapter; no prompts; owns cleanup and redacts responses', async t => {
  const f = fixture(t, { config: { model: 'credential-secret' } });
  const report = await runLiveCheck({ tempParent: f.parent }, { spawnProcess: f.spawnProcess });
  assert.equal(report.result, 'PASS', JSON.stringify(report));
  assert.equal(report.installedVersion, '1.18.31');
  assert.deepEqual(report.cleanup, { ownSessionDeleted: true, ownServerStopped: true, ownTempRemoved: true });
  assert.deepEqual(readdirSync(f.parent), ['owner-file']);
  assert.equal(existsSync(f.root()), false);
  assert.equal(report.config.modelStatus, 'configured-unverified');
  assert.equal(report.actualModel, null);
  assert.equal(JSON.stringify(report).includes('credential-secret'), false);
  assert.equal(f.requests.filter(([m, p]) => m === 'POST' && p === '/session').length, 1);
  assert.deepEqual(f.requests.filter(([m]) => m !== 'GET'), [
    ['POST', '/session'], ['POST', '/session/ses_fixture/abort'], ['DELETE', '/session/ses_fixture'],
  ]);
  assert.equal(report.providerCalls + report.promptsSent + report.toolExecutions, 0);
  assert.equal(report.v2.status, 'pending');
  assert.equal(f.children.every(c => c.exitCode === 0), true);
});

test('failures still stop owned processes and remove only generated temp root', async t => {
  for (const [changes, error] of [
    [{ spawnError: true }, 'installed-version'],
    [{ version: '2.0.0' }, 'installed-version'],
    [{ version: 'credential-secret' }, 'installed-version'],
    [{ healthVersion: '1.18.30' }, 'runtime-health'],
    [{ missingEndpoint: true }, 'endpoint-schema'],
    [{ escape: true }, 'path-isolation-home'],
    [{ connected: ['credential-secret'] }, 'isolated-config'],
    [{ identityFailure: true }, 'session-identity'],
    [{ deleteFailure: true }, 'cleanup'],
  ]) {
    await t.test(error + JSON.stringify(changes), async t => {
      const f = fixture(t, changes);
      const report = await runLiveCheck({ tempParent: f.parent }, { spawnProcess: f.spawnProcess });
      assert.equal(report.result, 'FAIL');
      assert.equal(report.error, error);
      assert.equal(report.cleanup.ownTempRemoved, true);
      assert.equal(JSON.stringify(report).includes('credential-secret'), false);
      assert.deepEqual(readdirSync(f.parent), ['owner-file']);
      assert.equal(f.children.every(c => c.exitCode === 0), true);
      if (changes.version || changes.spawnError) assert.equal(f.calls.length, 1);
    });
  }
});

test('interruption during startup cleans the owned temporary directory', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  const report = await runLiveCheck({ tempParent: f.parent, signal: controller.signal }, { spawnProcess: f.spawnProcess });
  assert.equal(report.result, 'FAIL');
  assert.equal(report.error, 'interrupted');
  assert.equal(report.cleanup.ownTempRemoved, true);
  assert.deepEqual(readdirSync(f.parent), ['owner-file']);
});

test('startup deadline stops its unready child and removes the generated root', async t => {
  const f = fixture(t, { startupTimeout: true });
  const report = await runLiveCheck({ tempParent: f.parent, timeoutMs: 100 }, { spawnProcess: f.spawnProcess });
  assert.equal(report.result, 'FAIL');
  assert.equal(report.error, 'server-start');
  assert.equal(report.cleanup.ownServerStopped, true);
  assert.equal(report.cleanup.ownTempRemoved, true);
  assert.deepEqual(readdirSync(f.parent), ['owner-file']);
});

test('v2 live mode rejected before spawn; actual adapter refuses v1 health as v2', async () => {
  const report = await runLiveCheck({ apiVersion: 'v2' }, { spawnProcess: () => assert.fail('must not launch') });
  assert.equal(report.result, 'FAIL');
  assert.equal(report.error, 'unsupported-api-version');
  assert.equal(report.v2.status, 'pending');
  const v2 = new OpenCodeServer({ url: 'http://127.0.0.1:1', version: 'v2',
    fetchImpl: async () => new Response(JSON.stringify({ version: '1.18.31' })) });
  await assert.rejects(v2.check(), /not a v2 runtime/);
});

test('CLI help and invalid args never require an installed executable', () => {
  const script = new URL('./live-check.mjs', import.meta.url);
  for (const [args, status] of [[['--help'], 0], [['--api-version', 'v2'], 1], [['--paid'], 1], [['--executable'], 1]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8' });
    assert.equal(result.status, status, result.stderr);
    if (status === 0) assert.match(result.stdout, /No prompts, paid model requests or agent tool executions/);
  }
});
