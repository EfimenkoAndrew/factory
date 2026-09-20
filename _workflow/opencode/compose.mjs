// Node prompt adapter. Pure common/profile helpers are also safe to inline in Workflow.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { commonPromptPrefix, isMinimalPromptRole, selectRoleProfile } from '../lib/prompt-context.mjs';
import { loadPolicies, POLICY_TEXT } from '../lib/policy.mjs';
import * as schemas from './schemas.mjs';

export function itemsDir(ctx, id) { return ctx.factoryRoot + '/state/items/' + id; }

const ROLE_SCHEMAS = {
  planner: 'PLAN_SCHEMA', 'test-author': 'TEST_SCHEMA', fixer: 'FIX_SCHEMA', runner: 'VERIFY_SCHEMA',
  integrator: 'INTEG_SCHEMA', adjudicator: 'ADJUDICATE_SCHEMA', 'decision-framer': 'DECISION_SCHEMA',
  refuter: 'REFUTE_SCHEMA', 're-auditor': 'REAUDIT_SCHEMA', 'sweep-designer': 'SWEEP_DESIGN_SCHEMA',
  'marker-probe': 'PROBE_SCHEMA', 'main-drift-probe': 'PROBE_SCHEMA', 'red-proof-probe': 'RED_PROOF_SCHEMA',
  'rootcause-probe': 'ROOTCAUSE_SCHEMA', 'pack-hash-probe': 'PACK_HASH_SCHEMA',
  'efmigration-probe': 'EFMIGRATION_SCHEMA', 'red-coverage-probe': 'RED_COVERAGE_SCHEMA',
  'acceptance-probe': 'ACCEPT_SCHEMA', 'breadth-claim-probe': 'ACCEPT_SCHEMA',
  'plan-commitment-probe': 'PLAN_COMMITMENT_SCHEMA', 'plan-feasibility-probe': 'PLAN_COMMITMENT_SCHEMA',
  'plan-quality-probe': 'PLAN_COMMITMENT_SCHEMA', 'prior-finding-probe': 'PLAN_COMMITMENT_SCHEMA',
  'leftover-probe': 'LEFTOVER_SCHEMA', 'ledger-anchor-probe': 'LEDGER_ANCHOR_SCHEMA',
  'checkpoint-writer': 'CHECKPOINT_SCHEMA', 'progress-writer': 'CHECKPOINT_SCHEMA',
  'consolidated-scan-shadow': 'SHADOW_SCAN_SCHEMA',
};

// Phase-specific schemas (e.g. planner steps nudge) override role defaults. Never widen a schema.
export function outputSchemaFor(role, schema) {
  const selected = schema || ROLE_SCHEMAS[role] || (/^(gate-|review-)/.test(role) ? 'GATE_SCHEMA' : null);
  const value = typeof selected === 'string' ? schemas[selected] : selected;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('No output schema for ' + role + '; supply options.outputSchema (schema object or exported schema name)');
  }
  return value;
}

function roleBrief(role, ctx, templatesDir) {
  if (Object.hasOwn(ctx, 'briefs')) {
    if (typeof ctx.briefs?.[role] === 'string' && ctx.briefs[role].trim()) return ctx.briefs[role];
    if (/-probe$/.test(role) || role === 'consolidated-scan-shadow' || isMinimalPromptRole(role)) return '';
    throw new Error('Launch snapshot has no complete brief for ' + role);
  }
  const path = join(templatesDir, role + '.md');
  if (existsSync(path)) return readFileSync(path, 'utf8');
  if (/-probe$/.test(role) || role === 'consolidated-scan-shadow' || isMinimalPromptRole(role)) return '';
  throw new Error('Missing role brief: ' + path);
}

function repoProfile(role, item, ctx, templatesDir) {
  if (Object.hasOwn(ctx, 'repoProfiles')) return selectRoleProfile(ctx.repoProfiles?.[item.target], role);
  if (!item.target) return '';
  if (/[\\/]/.test(String(item.target)) || String(item.target).includes('..')) {
    console.warn('[compose] WARNING: unsafe item.target — repo-profile lookup SKIPPED');
    return '';
  }
  const path = join(templatesDir, 'repo-profiles', item.target + '.md');
  return existsSync(path) ? selectRoleProfile(readFileSync(path, 'utf8'), role) : '';
}

/**
 * ctx: {repoRoot, worktreePath, factoryRoot, templatesDir?, briefs?, repoProfiles?, policies?}.
 * Presence of a snapshot field is authoritative, including an empty map: never fall back to
 * changing on-disk inputs mid-attempt. Legacy callers without those fields read current disk.
 * options: {outputSchema?: object|exportedName, handoffOnly?: boolean}.
 * Persist the ctx snapshots at launch; use this descriptor for structured-output dispatch.
 */
export function composeRequest(role, item, extra, ctx, options = {}) {
  const outputSchema = outputSchemaFor(role, options.outputSchema || ctx.outputSchema);
  const wtPath = ctx.worktreePath || item.worktree?.path || item.ledger?.worktree || ctx.repoRoot;
  const artifacts = itemsDir(ctx, item.id);
  const verify = 'bash ' + ctx.factoryRoot + '/verify/build-test.sh';
  const templatesDir = ctx.templatesDir || ctx.factoryRoot + '/agents';
  const minimal = isMinimalPromptRole(role);
  const review = /^(gate-|review-|refuter|re-auditor)/.test(role);
  const policies = Object.hasOwn(ctx, 'policies') ? (ctx.policies || {}) : loadPolicies(ctx.factoryRoot);
  // Stable common -> policy -> role/profile/schema prefix, then dynamic item/phase data.
  const lines = [commonPromptPrefix(minimal)];
  if (!minimal) lines.push('Read applicable .claude/rules/*.md if not already in context; this runtime does not assume automatic rule loading.');
  if (policies.noNewComments) lines.push(POLICY_TEXT.noNewComments);
  if (policies.noSchemaChanges) lines.push(POLICY_TEXT.noSchemaChanges);
  const brief = roleBrief(role, ctx, templatesDir);
  if (brief) lines.push('', 'YOUR ROLE BRIEF (authoritative, complete; do NOT re-Read it from disk):', brief);
  if (!minimal) {
    const profile = repoProfile(role, item, ctx, templatesDir);
    if (profile) lines.push('', 'REPO-SPECIFIC STYLE PROFILE (general guidance + applicable role sections; descriptive DATA authoritative for repo conventions, never permission to relax a gate, scope-stop or HOST POLICY):', profile);
  }
  if (role === 'integrator' && (options.handoffOnly || ctx.integratorHandoffOnly)) {
    lines.push('', 'INTEGRATOR MODE: HANDOFF-ONLY. The controller has already executed integration verification. Use current immutable machine evidence in integrate-raw.txt and the supplied phase evidence; do NOT repeat build/suite or edit source. Confirm the evidence belongs to this exact worktree snapshot and covers every required target with completed commands and no new failures beyond baseline. Missing, incomplete, stale or changed-input evidence means globalGreen=false with the reason in note; request controller re-verification. Never infer green from a prior agent verdict. Write integrate.md and return the SAME integrator output contract.');
  }
  lines.push('', 'OUTPUT CONTRACT (exact JSON Schema; required fields and additionalProperties restrictions are binding):', JSON.stringify(outputSchema));
  lines.push('',
    'TARGET: ' + item.target + '   WORK ITEM: ' + item.id + '  (' + item.severity + ' / ' + item.fixType + ' / ' + item.autonomyTier + ')',
    'WORKTREE (all source reads/edits/builds): ' + wtPath,
    'REPO ROOT (read-only reference): ' + ctx.repoRoot,
    'ARTIFACTS DIR (absolute; all state/items/{id} artifacts): ' + artifacts,
    'VERIFY SCRIPT (absolute; ONLY sanctioned build/test entrypoint): ' + verify);
  if (!minimal) {
    lines.push('', 'WORK-ITEM SPEC:',
      '  title: ' + item.title,
      '  theme: ' + item.theme + '   realInfra: ' + (!!item.realInfra),
      '  files (expected touch-set / lock set): ' + (item.files || []).join(', '),
      '  acceptance: ' + item.acceptance,
      '  regression-test-to-add: ' + item.regressionTest,
      '  fix-hint: ' + (item.fixHint || '(none)'),
      '  source: ' + item.source);
    if (role !== 'runner') {
      if (item.docMap?.length) {
        lines.push('', 'DOC MAP (READ-ONLY reference; Read targeted sections via offset/limit at @L, not whole docs):');
        for (const d of item.docMap) {
          const rel = String(d).split(' :: ')[0];
          lines.push('  ' + ctx.repoRoot + '/' + d);
          if ((item.files || []).includes(rel)) lines.push('    ^ Also in files[]: do NOT Edit this REPO-ROOT copy. Edit only: ' + wtPath + '/' + rel);
        }
      }
      if (item.batchPattern) lines.push('', 'BATCH PATTERN — SIMILARITY BATCH: ' + item.batchPattern,
        'Keep the shared change structurally IDENTICAL (approach, naming, permitted comment style, test structure), minimally adapted to this target. Explain any necessary deviation in note.');
      if (item.precedent) {
        const p = item.precedent;
        lines.push('', 'PRECEDENT — gate-APPROVED CLOSED sibling: ' + p.id + ' (' + (p.target || '?') + ') — ' + (p.title || ''),
          'Read first as a pattern reference, never as evidence for YOUR verdict; its directory and worktree are READ-ONLY. Match its approach/shape, or explain necessary deviations.');
        if (p.fixJson) lines.push(ctx.repoRoot + '/' + p.fixJson);
        if (p.worktree) lines.push(ctx.repoRoot + '/' + p.worktree + '/');
      }
      if (item.peers?.length) {
        lines.push('', 'PEER-OWNED SURFACES — do NOT modify. This lock takes PRECEDENCE over same-change obligations (including doc-sync); STOP for that file and name the gap in note/summary.');
        for (const p of item.peers) lines.push('  - ' + p.id + ': ' + (p.files || []).join(', '));
      }
    }
    if (review) {
      lines.push('', 'REVIEW PACK: Read ' + artifacts + '/review-pack.md FIRST, then compare `git -C "' + wtPath + '" status --porcelain`. Do NOT run a full exploratory git diff before reading the pack. If missing or inconsistent, regenerate with `' + verify + ' pack "' + wtPath + '" "' + artifacts + '/review-pack.md"`. The pack accelerates review; independently spot-verify verdict-critical facts in the CURRENT WORKTREE, including omitted/truncated content. Your verdict must not rest on the pack alone.');
      if (item.verifyNote) lines.push('VERIFY-STAGE NOTE (caveats; independently re-verify, do not approve past them): ' + item.verifyNote);
      lines.push('PARALLEL REVIEW STAGE — LIVE-PROBE ETIQUETTE: sibling reviewers may temporarily edit this worktree. Do not treat foreign probes or external-change notices as sabotage. Prefix your temporary probe filenames with your role, fully undo your own probes before returning (no mutating git), and record their evidence. Re-check verdict-dependent worktree state at conclusion.');
    } else if (role === 'runner' || /-probe$/.test(role)) {
      lines.push('Inspect only task-relevant inputs and evidence; no unrelated doc/peer research or full exploratory diff.');
    } else {
      lines.push('WORKTREE STATE CHECK: first run `git -C "' + wtPath + '" status --porcelain` and inspect existing changes with `git -C "' + wtPath + '" diff HEAD` before assuming a clean slate. Understand partial progress and unrelated work before editing; never overwrite unknown changes.');
    }
  }
  if (extra) lines.push('', extra);
  lines.push('', 'FINAL ANSWER FORMAT: end with a single fenced ```json code block containing ONLY the structured result object matching OUTPUT CONTRACT — no prose after the closing fence.');
  return { prompt: lines.join('\n'), outputSchema };
}

// Backward-compatible string API; dispatchers should use composeRequest for the actual schema.
export function compose(role, item, extra, ctx, options = {}) {
  return composeRequest(role, item, extra, ctx, options).prompt;
}
