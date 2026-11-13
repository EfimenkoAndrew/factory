#!/usr/bin/env node
/**
 * select-next-item.mjs — pick the best dispatchable factory item.
 *
 * DECISION LOGIC: "what item unblocks the most work?"
 *   1. Candidates: READY items whose dependsOn are all CLOSED,
 *      PLUS any FAILED items (they've been attempted — finish them first).
 *   2. Score each candidate:
 *        +10 per item it directly unblocks (items that dependsOn it)
 *        + 4 per item it transitively unblocks (2-hop)
 *        severity: CRITICAL=8, HIGH=4, MEDIUM=2, LOW=1
 *        FAILED bonus: +12 (invested effort, almost done — finish it)
 *        attempts bonus: +3 per prior attempt (more invested = higher priority)
 *   3. Items with unresolved deps (dep not CLOSED) are excluded.
 *   4. If a STOP_REQUESTED.md file exists, emit nothing (drain is paused).
 *
 * Output (stdout, JSON):
 *   { id, score, severity, attempts, almostDone, lanes, reason }
 *   almostDone=true  → FAILED item with ≥1 attempts → use lanes=2 (or 3 if ≥3 attempts)
 *   lanes             → recommended max_lanes for factory-run dispatch
 *   Empty output → nothing to dispatch (all done, quota exceeded, or drain stopped).
 *
 * Usage: node select-next-item.mjs [factory-root]
 */
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(process.argv[2] || '_bmad-output/ai-factory');
// --count N: output top N items as a JSON array (default 1 = legacy single-item mode)
const COUNT_ARG = process.argv.indexOf('--count');
const COUNT = COUNT_ARG >= 0 ? Math.max(1, parseInt(process.argv[COUNT_ARG + 1], 10) || 1) : 1;
const LEDGER_PATH = join(ROOT, 'state/ledger.json');
const GRAPH_PATH = join(ROOT, 'state/findings-graph.json');
const STOP_PATH = join(ROOT, 'state/STOP_REQUESTED.md');

if (existsSync(STOP_PATH)) {
  process.stderr.write('select-next-item: STOP_REQUESTED — drain paused\n');
  process.exit(0);
}

const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'));

const lItems = ledger.items || {};
const gItems = Array.isArray(graph.items) ? graph.items : Object.values(graph.items || {});

// Build lookup: graph metadata by id.
const meta = {};
for (const g of gItems) meta[g.id] = g;

// Closed set (deps resolved if in here).
const closedIds = new Set(
  Object.entries(lItems).filter(([, v]) => v.state === 'CLOSED').map(([k]) => k)
);

// FAILED items: attempted at least once, needs finishing.
const failedItems = Object.entries(lItems)
  .filter(([, v]) => v.state === 'FAILED')
  .map(([k, v]) => ({ id: k, ledger: v }));

// READY items: dispatchable, deps satisfied.
const readyItems = Object.entries(lItems)
  .filter(([, v]) => v.state === 'READY')
  .map(([k, v]) => ({ id: k, ledger: v }))
  .filter(({ id }) => {
    const deps = (meta[id] || {}).dependsOn || [];
    return deps.every(d => closedIds.has(d));
  });

// All candidates (FAILED first — finish before starting new).
const candidates = [...failedItems, ...readyItems];

if (candidates.length === 0) {
  process.stderr.write('select-next-item: no dispatchable items\n');
  process.exit(0);
}

// Build the "unblocks" map: for each item, count how many other items depend on it.
// Direct unblocks.
const directUnblocks = {};
for (const g of gItems) {
  for (const dep of (g.dependsOn || [])) {
    directUnblocks[dep] = (directUnblocks[dep] || 0) + 1;
  }
}

// Transitive (2-hop): item A → B → C: A transitively unblocks C.
const transitiveUnblocks = {};
for (const g of gItems) {
  for (const dep of (g.dependsOn || [])) {
    // Items that dep depends on also gain transitive credit.
    for (const dep2 of (meta[dep] || {}).dependsOn || []) {
      transitiveUnblocks[dep2] = (transitiveUnblocks[dep2] || 0) + 1;
    }
  }
}

const SEVERITY_SCORE = { CRITICAL: 8, HIGH: 4, MEDIUM: 2, LOW: 1 };

function score(c) {
  const m = meta[c.id] || {};
  const l = c.ledger;
  const attempts = l.attempts || 0;
  const isFailed = l.state === 'FAILED';

  let s = 0;
  s += (directUnblocks[c.id] || 0) * 10;
  s += (transitiveUnblocks[c.id] || 0) * 4;
  s += SEVERITY_SCORE[m.severity] || 1;
  if (isFailed) s += 12; // Almost done — finish it.
  s += attempts * 3;    // Each prior attempt = more invested effort.

  return s;
}

// Sort by score descending.
candidates.sort((a, b) => score(b) - score(a));

function makeResult(c) {
  const m = meta[c.id] || {};
  const l = c.ledger;
  const attempts = l.attempts || 0;
  const isFailed = l.state === 'FAILED';
  const almostDone = isFailed && attempts >= 1;
  let lanes = 1;
  if (almostDone && attempts >= 3) lanes = 3;
  else if (almostDone) lanes = 2;
  const direct = directUnblocks[c.id] || 0;
  const trans = transitiveUnblocks[c.id] || 0;
  const sev = m.severity || 'MEDIUM';
  const reason = [
    isFailed ? `FAILED(attempts=${attempts}) — finish it` : 'READY',
    direct > 0 ? `unblocks ${direct} direct dep(s)` : null,
    trans > 0 ? `+${trans} transitive` : null,
    `severity=${sev}`,
    `score=${score(c)}`,
  ].filter(Boolean).join('; ');
  return { id: c.id, score: score(c), severity: sev, attempts, almostDone, lanes, reason };
}

if (COUNT === 1) {
  // Legacy: single-item JSON object on stdout.
  process.stdout.write(JSON.stringify(makeResult(candidates[0])) + '\n');
} else {
  // Multi-item: emit top N as a JSON array (IDs de-duplicated, no file-lock check here).
  const top = candidates.slice(0, COUNT).map(makeResult);
  process.stdout.write(JSON.stringify(top) + '\n');
}
