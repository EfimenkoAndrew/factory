#!/usr/bin/env node
// factory-exporter — the derived-view sidecar (ai-factory-observability spine AD-5).
// Tails the append-only events.jsonl (AD-1), aggregates via the PURE core in
// lib/aggregate.mjs (selftest-covered), serves Prometheus /metrics on :9464, and pushes
// completed item/stage spans OTLP/HTTP to the collector. Zero npm dependencies (AD-4).
//
// Stream lifecycle (AD-13): full-replay on start rebuilds METRICS by design; OTLP pushes
// are SUPPRESSED during the initial catch-up (review finding #8 — a restart must not
// re-flood the collector with thousands of historical traces) and serialized afterwards.
// Truncation / inode change => reset state, re-read from 0.
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { createServer } from 'node:http';
import { createState, ingestLine, assembleTrace, renderMetrics } from './lib/aggregate.mjs';

const EVENTS_FILE = process.env.EVENTS_FILE || '/data/events.jsonl';
const PORT = parseInt(process.env.PORT || '9464', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '2000', 10);
const OTLP_URL = process.env.OTLP_URL || 'http://otel-collector:4318/v1/traces';
const OTLP_ENABLED = process.env.OTLP_ENABLED !== '0';

let state = createState();
let offset = 0, inode = null, carry = '', replayDone = false;
let pushChain = Promise.resolve(); // serialized OTLP pushes (finding #8)

function handleFold(folded, foldTsMs) {
  // assembleTrace ALWAYS consumes the item's stage buffer (finding #6 — no leak when
  // OTLP is off or during replay); pushing is conditional.
  const payload = assembleTrace(state, folded, foldTsMs);
  if (!OTLP_ENABLED || !replayDone) return;
  pushChain = pushChain.then(() =>
    fetch(OTLP_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) })
  ).catch(() => { /* collector down is fine — the stream is the source of truth (AD-1) */ });
}

function poll() {
  try {
    const st = statSync(EVENTS_FILE);
    if (inode !== null && (st.ino !== inode || st.size < offset)) { state = createState(); offset = 0; carry = ''; }
    inode = st.ino;
    while (st.size > offset) {
      const fd = openSync(EVENTS_FILE, 'r');
      try {
        const len = Math.min(st.size - offset, 8 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        const read = readSync(fd, buf, 0, buf.length, offset);
        if (read <= 0) break;
        offset += read;
        const chunk = carry + buf.toString('utf8', 0, read);
        const lines = chunk.split('\n');
        carry = lines.pop() || '';
        for (const line of lines) {
          const r = ingestLine(state, line);
          if (r.folded) handleFold(r.folded, r.foldTsMs);
        }
      } finally { closeSync(fd); }
    }
    // Initial catch-up complete once we've consumed everything present at (or since) start.
    if (!replayDone && offset >= st.size) { replayDone = true; console.log(`replay complete: ${state.linesIngested} line(s) — OTLP push now live`); }
  } catch { /* ENOENT until the first factory event — keep waiting */ }
}
setInterval(poll, POLL_MS);
poll();

createServer((req, res) => {
  if (req.url === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }); res.end(renderMetrics(state)); return; }
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok\n'); return; }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`factory-exporter on :${PORT} — tailing ${EVENTS_FILE} every ${POLL_MS}ms, OTLP ${OTLP_ENABLED ? OTLP_URL : 'disabled'}`));
