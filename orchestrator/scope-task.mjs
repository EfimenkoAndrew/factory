#!/usr/bin/env node
// scope-task.mjs — KI-E336: turn an ingested owner TASK (a normalized shell with empty files[]) into a
// DISPATCHABLE work-item, so the owner can "task the factory like a remote worker": say what you want,
// the factory scopes it, implements it, integrates it, tests it, and opens a PR.
//
// Two scoping modes:
//   1. TEMPLATE (reliable, default) — the issue body carries `Target:`, `Files:`, `Acceptance:`
//      (optionally `Severity:`, `Test:`) lines. Deterministic parse. NO LLM. This is the tested path.
//   2. FREE-TEXT (best-effort, experimental) — no template present -> dispatch the `scoper` agent
//      (claude -p agents/scoper.md) to DISCOVER the files[] + acceptance. Flagged; the workflow posts
//      the result as an issue comment for the owner to eyeball before any code is written, and the
//      owner still reviews the PR.
//
// Safety invariants (both modes):
//   * autonomyTier is ALWAYS 'escalate' — an owner task is never silently auto-run; the owner's
//     assignment/dispatch is the approval, carried by the existing --include-escalate path (KI-E334).
//   * FAILS LOUDLY (exit 1) if it cannot produce a NON-EMPTY files[] — never emits an unscoped,
//     un-runnable item that merge-graph would silently accept (empty files[] = no lock set = no
//     guidance for the agent).
//   * Writes ONLY to state/normalized/ (like ingest) — no controller lease, no graph mutation here;
//     merge-graph folds it into the findings-graph as a separate, reviewable step.
//
// Usage:
//   node scope-task.mjs --shell state/normalized/github-TASK-7.json            (template or LLM)
//   node scope-task.mjs --shell <f> --no-llm                                   (template only; fail if none)
//   node scope-task.mjs --self-test                                            (deterministic parse/validate tests)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const GATE_FULL = ['architect', 'developer', 'qa', 'security', 'po'];
const SEV_OK = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// ── layer inference from a repo path (mirrors the findings-graph's own layer vocabulary).
// The two regexes below are generic heuristics (a "*Portal/" path segment, a "*.Shared.*"
// namespace or "src/Shared/" path); a host whose admin/portal app doesn't have "Portal" in its
// name, or whose shared-lib namespace prefix isn't "Shared", should extend this for its own
// naming convention. ──
export function inferLayer(path) {
  const p = String(path || '');
  if (/Portal\//i.test(p)) return 'portal';
  if (/\.Shared\.|src\/Shared\//.test(p)) return 'lib';
  return 'service';
}

// ── TEMPLATE mode: parse `Key: value` lines the owner wrote in the issue body ──
// Recognized keys (case-insensitive): Target, Files (comma/newline list), Acceptance, Severity, Test.
export function parseTemplate(body) {
  const text = String(body || '');
  const grab = (key) => {
    const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'im');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  const filesRaw = grab('Files');
  if (!filesRaw) return null; // no template -> caller falls back to free-text/LLM
  const files = filesRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const severity = grab('Severity').toUpperCase();
  return {
    target: grab('Target') || undefined,
    files,
    acceptance: grab('Acceptance') || undefined,
    severity: SEV_OK.includes(severity) ? severity : undefined,
    regressionTest: grab('Test') || undefined,
  };
}

// ── Assemble a schema-valid work-item from the shell + the scoped fields. ──
export function buildItem(shell, scoped) {
  const files = (scoped.files || []).filter(Boolean);
  const target = scoped.target || (files[0] ? files[0].split('/')[0] : '');
  const acceptance = scoped.acceptance
    || `The task described in "${shell.title}" is implemented across the listed files and builds + passes existing tests.`;
  return {
    id: shell.id,
    target,
    layer: scoped.layer || inferLayer(files[0] || ''),
    title: shell.title,
    severity: scoped.severity || 'HIGH',
    theme: 'owner-task',
    fixType: 'non-trivial',
    files,
    dependsOn: [],
    acceptance,
    regressionTest: scoped.regressionTest
      || `A test that fails before the change and passes after, proving: ${acceptance}`,
    gateSet: GATE_FULL,
    autonomyTier: 'escalate', // INVARIANT: an owner task always needs explicit owner approval to run.
    source: shell.source || `owner-task:${shell.id}`,
  };
}

// ── Reject an item we must never dispatch (the empty-files[] un-runnable shell). ──
export function validate(item) {
  const problems = [];
  for (const k of ['id', 'target', 'title', 'severity', 'theme', 'fixType', 'acceptance', 'regressionTest', 'source']) {
    if (!item[k] || !String(item[k]).trim()) problems.push(`missing/empty ${k}`);
  }
  if (!Array.isArray(item.files) || item.files.length === 0) problems.push('files[] is EMPTY — refusing to emit an un-runnable task (give a `Files:` line or a clearer task)');
  if (!SEV_OK.includes(item.severity)) problems.push(`severity "${item.severity}" not one of ${SEV_OK.join('/')}`);
  if (item.autonomyTier !== 'escalate') problems.push('autonomyTier MUST be escalate for an owner task');
  if (!Array.isArray(item.gateSet) || item.gateSet.length === 0) problems.push('gateSet is empty');
  return problems;
}

// ── FREE-TEXT mode: dispatch the scoper agent to DISCOVER files[]/acceptance (best-effort). ──
function scopeFreeText(shell, { bin = 'claude', agentPath, body = '' }) {
  const brief = readFileSync(agentPath, 'utf8');
  const prompt = `${brief}\n\n## TASK TO SCOPE (id: ${shell.id})\nTitle: ${shell.title}\n\nBody:\n${body || shell.acceptance || '(no body)'}\n\n`
    + `Explore the repo and output ONLY a single JSON object with keys: target, files (array of repo-relative paths you will touch, each one you verified exists), acceptance, severity (CRITICAL/HIGH/MEDIUM/LOW), regressionTest, layer. No prose, no markdown fence — just the JSON.`;
  let out = '';
  try {
    out = execFileSync(bin, ['-p', prompt], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`scoper agent (${bin} -p) failed: ${String((e && e.stderr) || e.message || e).split('\n')[0]}`);
  }
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('scoper produced no JSON object — provide a `Files:` template line instead');
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch { throw new Error('scoper JSON did not parse — provide a `Files:` template line instead'); }
  return parsed;
}

export function scopeShell(shell, opts = {}) {
  // ingest clips + flattens the issue body into `acceptance` (there is no raw `.body` field), so prefer
  // an explicit raw body (opts.body, fetched by the workflow via `gh issue view`) for the template parse;
  // fall back to the shell's own text only if no raw body was supplied.
  const body = opts.body || shell.body || shell.acceptance || '';
  const tpl = parseTemplate(body);
  const scoped = tpl || (opts.noLlm ? null : scopeFreeText(shell, { ...opts, body }));
  if (!scoped) throw new Error(`no \`Files:\` template in the task and LLM scoping is disabled — cannot scope ${shell.id}`);
  const item = buildItem(shell, scoped);
  const problems = validate(item);
  if (problems.length) throw new Error(`scope-task refuses to emit ${shell.id}:\n  - ${problems.join('\n  - ')}`);
  return { item, mode: tpl ? 'template' : 'free-text(llm)' };
}

// ── self-test: deterministic parse/validate, no LLM, no filesystem writes ──
function selfTest() {
  let pass = 0; const fail = [];
  const ok = (cond, msg) => { if (cond) pass++; else fail.push(msg); };
  const body = 'Target: WidgetService\nFiles: WidgetService/src/WidgetService.Api/Program.cs, WidgetService/src/WidgetService.Api/Controllers/HealthController.cs\nAcceptance: /health returns an X-RateLimit header\nSeverity: medium';
  const shell = { id: 'TASK-1', title: 'Add a rate-limit header to health checks', source: 'owner-task:1' };
  const { item, mode } = scopeShell(shell, { noLlm: true, body });
  ok(mode === 'template', 'template mode used when Files: present');
  ok(item.files.length === 2, 'two files parsed from the comma list');
  ok(item.target === 'WidgetService', 'target parsed');
  ok(item.severity === 'MEDIUM', 'severity upper-cased + accepted');
  ok(item.autonomyTier === 'escalate', 'autonomyTier forced to escalate');
  ok(JSON.stringify(item.gateSet) === JSON.stringify(GATE_FULL), 'full gateSet default');
  ok(inferLayer('AdminPortal/Views/X.cshtml') === 'portal', 'portal layer inferred');
  ok(inferLayer('src/Shared/Example.Authorization/X.cs') === 'lib', 'lib layer inferred');
  // empty files[] must be refused
  let refused = false;
  try { scopeShell({ id: 'TASK-2', title: 'vague' }, { noLlm: true, body: 'Acceptance: do something' }); }
  catch { refused = true; }
  ok(refused, 'a task with no Files: template + no LLM is REFUSED (never un-runnable)');
  // validate() catches an empty-files item built directly
  ok(validate(buildItem({ id: 'X', title: 't', source: 's' }, { files: [] })).some((p) => /files\[\] is EMPTY/.test(p)), 'validate flags empty files[]');
  if (fail.length) { console.error('scope-task self-test FAILED:\n  - ' + fail.join('\n  - ')); process.exit(1); }
  console.log(`scope-task self-test: ${pass} passed, 0 failed`);
}

function main() {
  const argv = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); flags[k] = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
  if (flags['self-test']) return selfTest();
  if (!flags.shell) { console.error('usage: node scope-task.mjs --shell state/normalized/<file>.json [--no-llm] [--agent agents/scoper.md]'); process.exit(2); }
  if (!existsSync(flags.shell)) { console.error(`scope-task: shell not found: ${flags.shell}`); process.exit(2); }
  const raw = JSON.parse(readFileSync(flags.shell, 'utf8'));
  const shell = Array.isArray(raw) ? (raw[0] || {}) : raw; // ingest writes an ARRAY of items (one per issue)
  const body = (flags['body-file'] && existsSync(flags['body-file'])) ? readFileSync(flags['body-file'], 'utf8') : undefined;
  const { item, mode } = scopeShell(shell, {
    noLlm: !!flags['no-llm'],
    bin: flags.bin || process.env.FACTORY_CLAUDE_BIN || 'claude',
    agentPath: flags.agent || new URL('../agents/scoper.md', import.meta.url).pathname,
    body,
  });
  writeFileSync(flags.shell, JSON.stringify([item], null, 2) + '\n'); // write back an ARRAY (merge-graph folds arrays)
  console.log(`scope-task: ${item.id} scoped via ${mode} — ${item.files.length} file(s), severity ${item.severity}, autonomyTier escalate.`);
  console.log(`  target: ${item.target}`);
  console.log(`  files: ${item.files.join(', ')}`);
  console.log(`  acceptance: ${item.acceptance}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
