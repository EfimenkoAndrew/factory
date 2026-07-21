#!/usr/bin/env node
// Agent-side telemetry CLI (spine AD-10) — the stable Bash seam for stage subagents.
// Best-effort by contract: ALWAYS exits 0 (a telemetry failure must never fail a factory
// stage), never prints to stdout (agents pipe/parse freely), one JSONL line per call via
// lib/telemetry.mjs emit(). Events land with source:agent and are NEVER fold evidence.
//
// Usage (absolute path — KI-L33):
//   node <factory>/_workflow/telemetry-emit.mjs --event stage_start --item ITEM-H13 --role fixer
//   node <factory>/_workflow/telemetry-emit.mjs --event stage_end --item ITEM-H13 --role fixer --outcome ok --durMs 84210
try {
  const { emit, roleToStage, normalizeStage } = await import('./lib/telemetry.mjs');
  const argv = process.argv.slice(2);
  // 'source' is deliberately NOT accepted from argv (review finding #2): this CLI is the AGENT
  // seam, and AD-2's authority ranking collapses if an agent can stamp source:derived/driver.
  // source:'agent' is hard-pinned below; a forged --source flag rides harmlessly into attrs.
  const KNOWN = new Set(['event', 'item', 'stage', 'role', 'model', 'effort', 'outcome', 'runId', 'lane', 'session']);
  const NUMERIC = new Set(['durMs', 'cycle', 'attempts']);
  const e = { source: 'agent', attrs: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
    if (NUMERIC.has(k)) { const n = Number(v); if (Number.isFinite(n)) e[k] = n; }
    else if (KNOWN.has(k)) e[k] = String(v).slice(0, 200);
    else e.attrs[k] = String(v).slice(0, 500); // unknown flags ride in attrs (forward-compat)
  }
  // AD-12: ONE stage vocabulary. A free-typed --stage is normalized onto the canonical enum;
  // absent --stage derives from --role. Unmappable values are dropped (role remains on the event).
  const stage = e.stage ? normalizeStage(e.stage) : roleToStage(e.role);
  if (stage) e.stage = stage; else delete e.stage;
  if (!Object.keys(e.attrs).length) delete e.attrs;
  if (!e.event) process.stderr.write('[telemetry-emit] --event required; skipped\n');
  else emit(e);
} catch (err) {
  try { process.stderr.write('[telemetry-emit] skipped: ' + (err && err.message) + '\n'); } catch { /* never throw */ }
}
process.exit(0);
