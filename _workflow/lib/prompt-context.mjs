// Pure prompt contracts: safe to inline in the filesystem-free Workflow runtime.
// Profile opt-in syntax: `## Role: fixer` or `## Roles: test-author, gate-qa`.
// A scoped section ends at the next heading of the same or higher level. Ordinary
// sections/preambles are ALWAYS general guidance; fenced examples are never selectors.
// Selectors support exact role names, gate-*, review-*, and common/all/*.
export function selectRoleProfile(text, role) {
  const source = String(text || '');
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
  const out = [];
  let scope = null;
  let fence = null;
  for (const line of lines) {
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (!scope || scope.include) out.push(line);
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = null;
      continue;
    }
    if (fm) {
      fence = fm[1];
      if (!scope || scope.include) out.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (scope && level <= scope.level) scope = null;
      const marker = /^Roles?:\s*(.+)$/i.exec(heading[2]);
      if (marker && !scope) {
        const selectors = marker[1].split(',').map((s) => s.trim());
        // Malformed selectors remain general rather than silently losing guidance.
        if (selectors.every((s) => /^(?:[a-z][a-z0-9-]*|gate-\*|review-\*|\*)$/.test(s))) {
          const include = selectors.some((s) => s === role || s === '*' || s === 'common' || s === 'all'
            || (s.endsWith('-*') && role.startsWith(s.slice(0, -1))));
          scope = { level, include };
        }
      }
    }
    if (!scope || scope.include) out.push(line);
  }
  return out.join('');
}

// Deliberately NOT /-probe$/: acceptance/plan/leftover classifiers need semantic context.
export function isMinimalPromptRole(role) {
  return ['marker-probe', 'red-proof-probe', 'rootcause-probe', 'comment-probe',
    'pack-hash-probe', 'main-drift-probe', 'efmigration-probe',
    'checkpoint-writer', 'progress-writer'].includes(role);
}

export function commonPromptPrefix(minimal) {
  const lines = [
    'FACTORY CONTRACT: act only in your assigned role; implementation, verification and review remain independent.',
    'ISOLATION: source edits/builds belong only in the assigned WORKTREE; REPO ROOT and peer worktrees are read-only. Write stage artifacts only to ARTIFACTS DIR. Never edit the ledger or delete STOP_REQUESTED.md.',
    'NEVER run mutating git (commit/add/checkout/restore/stash/reset/clean); the human authors every commit.',
    'EVIDENCE: report actual command results. Never fabricate, hand-edit, summarize over, or replace raw evidence. Missing/failed execution is not green; telemetry and agent claims are never machine evidence.',
  ];
  if (minimal) {
    lines.push('TOOL RELAY: execute only the supplied task/commands and return the specified structured result. No source edits, exploratory reads, profile/doc/peer research, or unrelated commands. Only explicitly requested artifact writes are permitted; preserve raw transcripts.');
  } else {
    lines.push(
      'GUARDRAILS (.claude/rules/*.md are the acceptance criteria): honour code-style / service-design / dataflow / security / trust-and-monetisation / deploy-verification.',
      'product-scope.md red-lines are HARD STOPS: never add a tax/purchase-fee/SAR/gov-report/shipping surface to fix an item. If the only fix crosses one, STOP and report scope-stop.',
      '`scopeViolation:true` means ONLY a product-scope.md red-line. A files[] touch-set deviation is a normal finding judged on its merits, not a scopeViolation.',
      'A real pattern divergence requires a standards-evolution.md ledger entry + call-site tag in the SAME change; the tag is waived when HOST POLICY — NO NEW COMMENTS is active.',
      'Leave no TODO/FIXME/HACK/XXX/stub or false production-ready claim.',
    );
  }
  return lines.join('\n');
}
