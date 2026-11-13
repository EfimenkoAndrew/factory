#!/usr/bin/env node
// KI-E302 — Factory run digest. Reads state/items/<id>/result.json and prints a compact markdown
// summary of what actually happened in a run: outcome + the decisive gate, the stage path, a
// gate tally, the code change (files + root cause + fix steps), cost/tokens, and links to the
// committed artifacts (worktree.diff, _runs/ archive, feedback.md, review-pack, result.json).
// Consumed by the factory workflows (issue comment + PR body). Zero deps (Node builtins only).
//
// Usage: node run-report.mjs <item-id> [--root <factory-root>] [--repo owner/name] [--ref master] [--server https://github.com]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerOutcome, gatePassed } from './run-history.mjs'; // KI-E313/E315: authoritative outcome + rejection-aware gate count

const args = process.argv.slice(2);
const id = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const root = opt('--root', '_bmad-output/ai-factory');
const repo = opt('--repo', '');
const ref = opt('--ref', 'master');
const server = opt('--server', 'https://github.com');

if (!id) { process.stderr.write('run-report: missing <item-id>\n'); process.exit(2); }

const itemDir = join(root, 'state', 'items', id);
const resultPath = join(itemDir, 'result.json');
if (!existsSync(resultPath)) {
  process.stdout.write(`_No \`result.json\` for \`${id}\` — the run produced no foldable result (incomplete lane)._\n`);
  process.exit(0);
}

let r;
try { r = JSON.parse(readFileSync(resultPath, 'utf8')); }
catch (e) { process.stdout.write(`_Could not parse result.json for \`${id}\`: ${e.message}_\n`); process.exit(0); }

const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '?');
const relPath = (p) => String(p || '').replace(/^.*\/state\/worktrees\/[^/]+\//, '');
// KI-E313: use the ledger's authoritative outcome; result.json.toState is only the agent's claim,
// which the fold may override (e.g. an over-claimed CLOSED → FAILED on an absent test baseline).
const lo = ledgerOutcome(root, id);
const state = lo || r.toState || '?';
const overrode = lo && r.toState && lo !== r.toState;
const emoji = state === 'CLOSED' ? '✅' : (['FAILED', 'ESCALATED', 'BLOCKED'].includes(state) ? '❌' : '⚠️');

// Gate tally + the gate(s) that did not approve.
const gates = r.gates || {};
const gateNames = Object.keys(gates);
const notApproved = gateNames.filter((g) => !gatePassed(gates[g])); // KI-E315: only true rejections count
const approved = gateNames.length - notApproved.length;
const decidedBy = state === 'CLOSED'
  ? (gateNames.length ? `all ${gateNames.length} gates APPROVED` : 'no gates recorded')
  : (notApproved.length ? notApproved.map((g) => `\`${g}\` → ${gates[g]}`).join(', ') : 'see note');

// Cost: tokensUsed + per-model call counts.
const costParts = Object.entries(r.cost || {}).map(([m, c]) => `${m.replace(/^claude-/, '')} ×${c}`);
const costLine = `${num(r.tokensUsed)} tokens` + (costParts.length ? ` · calls: ${costParts.join(', ')}` : '');

const files = (r.filesChanged || []).map(relPath).filter(Boolean);
const rootCause = (r.rootCauseFiles || []).map(relPath).filter(Boolean);

// Decisive reason: prefer gateDetails headline for the failing gate, else the note.
let why = r.note || '';
if (notApproved.length && r.gateDetails && r.gateDetails[notApproved[0]]) {
  const gd = r.gateDetails[notApproved[0]];
  if (gd.headline) why = gd.headline + (gd.findings && gd.findings.length ? ` (${gd.findings.length} finding(s))` : '');
}
why = String(why).replace(/\s+/g, ' ').trim();
if (why.length > 600) why = why.slice(0, 600) + '…';

// Artifact links (only when --repo is known; links point at the committed copies).
const blob = (f) => `${server}/${repo}/blob/${ref}/${root}/state/items/${id}/${f}`;
const tree = (f) => `${server}/${repo}/tree/${ref}/${root}/state/items/${id}/${f}`;
const links = [];
if (repo) {
  if (existsSync(join(itemDir, 'worktree.diff'))) links.push(`[worktree.diff](${blob('worktree.diff')})`);
  if (existsSync(join(itemDir, '_runs'))) links.push(`[\`_runs/\` archive](${tree('_runs')})`);
  if (existsSync(join(itemDir, 'feedback.md'))) links.push(`[feedback.md](${blob('feedback.md')})`);
  if (existsSync(join(itemDir, 'review-pack.md'))) links.push(`[review-pack](${blob('review-pack.md')})`);
  links.push(`[result.json](${blob('result.json')})`);
}

const out = [];
out.push(`### ${emoji} Factory run digest — \`${id}\``);
out.push('');
out.push('| | |');
out.push('|---|---|');
out.push(`| **Outcome** | ${state} · band ${r.band || '?'} · attempt +${r.attemptsDelta ?? '?'} |`);
out.push(`| **Decided by** | ${decidedBy} |`);
if (Array.isArray(r.transitions) && r.transitions.length) out.push(`| **Path** | ${r.transitions.join(' → ')} |`);
out.push(`| **Gates** | ${approved}/${gateNames.length} APPROVED${notApproved.length ? ` · ${notApproved.length} not approved` : ''} |`);
out.push(`| **Code change** | ${files.length} file(s)${r.fixSteps ? `, ${r.fixSteps} fix step(s)` : ''}${rootCause.length ? ` · root cause: \`${rootCause.join('`, `')}\`` : ''}${r.needsRealInfra ? ' · needs-real-infra' : ''} |`);
out.push(`| **Cost** | ${costLine} |`);
out.push('');
if (overrode) { out.push(`> ⚠️ **Fold override:** the agent claimed \`${r.toState}\`, but the deterministic fold check overrode it to **${state}** — the outcome above is the fold's (authoritative).`, ''); }
if (why) { out.push(`**Why:** ${why}`); out.push(''); }
if (files.length) {
  out.push('<details><summary>Files changed</summary>', '');
  for (const f of files) out.push(`- \`${f}\``);
  out.push('</details>', '');
}
if (links.length) { out.push(`**Artifacts:** ${links.join(' · ')}`); out.push(''); }

process.stdout.write(out.join('\n'));
