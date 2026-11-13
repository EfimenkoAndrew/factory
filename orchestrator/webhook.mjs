#!/usr/bin/env node
// KI-E273 (2026-10-03) — HTTP webhook receiver for remote factory triggering.
// Enables server-mode operation: trigger a factory run from a phone, GitHub Actions,
// or any HTTP client without needing an interactive Claude Code session.
// Zero npm dependencies; Node built-ins only (AD-4).
//
// Endpoints:
//   GET  /health          — no auth; liveness probe for load-balancer / k8s readiness
//   GET  /status          — auth required; ledger counts + isRunning + stopRequested
//   POST /trigger         — auth required; spawns orchestrate.mjs run detached, returns 202/409/503
//   POST /trigger/stop    — auth required; writes STOP_REQUESTED.md (drain the factory)
//
// Auth: X-Factory-Token header compared via constant-time SHA-256 hash equality
//       against FACTORY_WEBHOOK_TOKEN env var. Fails closed when the var is absent.
//
// Run with: FACTORY_WEBHOOK_TOKEN=<secret> node orchestrator/webhook.mjs [--port 3456] [--bind 127.0.0.1]
//
// On the dedicated server, run behind a TLS-terminating reverse proxy (nginx/caddy).
// The factory's KI-E1 "no mutating git" invariant continues to apply to everything
// this receiver spawns — the spawned orchestrate.mjs run obeys the same invariant
// unless autoCommit.enabled:true is set in orchestrator.config.json (KI-E272).
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = resolve(HERE, '..');
const STATE_DIR = join(FACTORY_ROOT, 'state', 'orchestrator');
const PID_FILE = join(STATE_DIR, 'webhook-run.pid');
const STOP_MARKER = join(FACTORY_ROOT, 'state', 'STOP_REQUESTED.md');
const LEDGER = join(FACTORY_ROOT, 'state', 'ledger.json');
const ORCHESTRATE = join(HERE, 'orchestrate.mjs');

const rawToken = process.env.FACTORY_WEBHOOK_TOKEN;
if (!rawToken) { console.error('FATAL: FACTORY_WEBHOOK_TOKEN env var is required — refusing to start (fail-closed)'); process.exit(1); }
// Pre-hash the token once for constant-time comparison (hashes are always the same length,
// avoiding the Buffer.length side-channel that raw timingSafeEqual requires equal-length inputs to avoid).
const expectedHash = createHash('sha256').update(rawToken).digest();

// ---- CLI flags -------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
}
const PORT = parseInt(flags.port || process.env.FACTORY_WEBHOOK_PORT || '3456', 10);
const BIND = flags.bind || process.env.FACTORY_WEBHOOK_BIND || '127.0.0.1';

// ---- helpers ---------------------------------------------------------------------------------
function authOk(req) {
  const h = req.headers['x-factory-token'];
  if (!h) return false;
  try {
    const actual = createHash('sha256').update(Buffer.from(h)).digest();
    return timingSafeEqual(actual, expectedHash);
  } catch { return false; }
}

function ledgerCounts() {
  try {
    const l = JSON.parse(readFileSync(LEDGER, 'utf8'));
    const c = {};
    for (const r of Object.values(l.items)) c[r.state] = (c[r.state] || 0) + 1;
    return { cycle: l.cycle, counts: c };
  } catch { return { cycle: 0, counts: {} }; }
}

function isRunning() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!pid || !Number.isFinite(pid)) return false;
    process.kill(pid, 0); // throws ESRCH if process doesn't exist, EPERM if exists but unowned
    return true;
  } catch (e) { return e.code === 'EPERM'; } // EPERM means the process exists but we can't signal it
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { ok(Buffer.concat(chunks).toString('utf8')); } catch (e) { fail(e); } });
    req.on('error', fail);
  });
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const wlog = (m) => console.log(`[webhook ${new Date().toISOString()}] ${m}`);

// ---- request handler -------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const { method, url } = req;

  // GET /health — no auth, liveness probe
  if (method === 'GET' && url === '/health') {
    return json(res, 200, { ok: true, ts: new Date().toISOString() });
  }

  // All other endpoints require auth
  if (!authOk(req)) {
    wlog(`401 ${method} ${url} — invalid or missing X-Factory-Token`);
    return json(res, 401, { error: 'unauthorized' });
  }

  // GET /status
  if (method === 'GET' && url === '/status') {
    const { cycle, counts } = ledgerCounts();
    return json(res, 200, {
      cycle, counts,
      isRunning: isRunning(),
      stopRequested: existsSync(STOP_MARKER),
      ts: new Date().toISOString(),
    });
  }

  // POST /trigger — spawn a factory run detached
  if (method === 'POST' && url === '/trigger') {
    if (existsSync(STOP_MARKER)) {
      return json(res, 503, { error: 'stop-marker-present', hint: 'delete state/STOP_REQUESTED.md first' });
    }
    if (isRunning()) {
      return json(res, 409, { error: 'already-running', hint: 'GET /status to check progress' });
    }

    let body = {};
    try {
      const raw = await readBody(req);
      if (raw.trim()) body = JSON.parse(raw);
    } catch { return json(res, 400, { error: 'invalid-json-body' }); }

    const backend = (typeof body.backend === 'string' && /^(claude-headless|opencode|interactive|dry)$/.test(body.backend)) ? body.backend : 'claude-headless';
    const ids = (typeof body.ids === 'string' && body.ids.trim()) ? body.ids.trim() : null;
    const maxLanes = (Number.isFinite(Number(body.maxLanes)) && Number(body.maxLanes) > 0) ? String(Math.floor(Number(body.maxLanes))) : null;

    const args = [ORCHESTRATE, 'run', '--backend', backend];
    if (ids) { args.push('--ids', ids); }
    if (maxLanes) { args.push('--max-lanes', maxLanes); }

    mkdirSync(STATE_DIR, { recursive: true });
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      cwd: FACTORY_ROOT,
    });
    writeFileSync(PID_FILE, String(child.pid));
    child.unref();

    wlog(`triggered run pid=${child.pid} backend=${backend}${ids ? ' ids=' + ids : ''}${maxLanes ? ' max-lanes=' + maxLanes : ''}`);
    return json(res, 202, { accepted: true, pid: child.pid, backend, ...(ids ? { ids } : {}), ...(maxLanes ? { maxLanes } : {}) });
  }

  // POST /trigger/stop — write the drain marker (factory finishes current lane then halts)
  if (method === 'POST' && url === '/trigger/stop') {
    mkdirSync(dirname(STOP_MARKER), { recursive: true });
    writeFileSync(STOP_MARKER, `# Stop requested via webhook at ${new Date().toISOString()}\n\nDelete this file to resume the factory.\n`);
    wlog('stop marker written — factory will drain after current lane');
    return json(res, 200, { ok: true, message: 'STOP_REQUESTED.md written — factory drains after current lane' });
  }

  return json(res, 404, { error: 'not-found', endpoints: ['GET /health', 'GET /status', 'POST /trigger', 'POST /trigger/stop'] });
});

server.on('error', (e) => { console.error(`[webhook] server error: ${e.message}`); process.exit(1); });

server.listen(PORT, BIND, () => {
  wlog(`listening on ${BIND}:${PORT}`);
  wlog('endpoints: GET /health (no auth) · GET /status · POST /trigger · POST /trigger/stop');
  wlog('auth: X-Factory-Token header (FACTORY_WEBHOOK_TOKEN env var)');
});

process.on('SIGTERM', () => { wlog('SIGTERM — shutting down gracefully'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { wlog('SIGINT — shutting down gracefully');  server.close(() => process.exit(0)); });
