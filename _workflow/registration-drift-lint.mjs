#!/usr/bin/env node
// KI-E77 (2026-08-09) — the RegistrationDrift CLI: `verify/build-test.sh registration-drift <worktree>`.
// Cheap, EARLY prevention companion to KI-E76's fold-time backstop — run this right after writing a
// remedy, before spending a single gate-agent token reviewing it. Single source of truth:
// lib/registration-drift.mjs (pure, selftest-covered).
// Output contract (machine-greppable, mirrors leftover-lint.mjs/comment-lint.mjs):
//   FACTORY::REGISTRATION-DRIFT-HIT::<file>::<method>::<args, truncated>::vs <sibling>: <shape>
//   FACTORY::REGISTRATION-DRIFT::<count>                                    always last
// ADVISORY, never blocking: a shape mismatch is a real signal but not a certain one (a legitimately
// overloaded shared method has more than one valid call shape) — exit 1 on a hit makes it loud in
// the same style as leftovers/comments, but nothing in this engine treats that exit code as fatal;
// judgment stays with whoever reads the hit. Best-effort: any internal error reports count 0 — a
// lint aid must never block a fix.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRegistrationDrift } from './lib/registration-drift.mjs';

const wt = process.argv[2] || '.';
const SITE_RE = /(^|\/)(Program\.cs|[A-Za-z0-9]+InfrastructureRegistration\.cs)$/;
// KI-E54-style buffer sizing: `git ls-files` on this monorepo returns 1MB+ of output (hundreds of
// thousands of tracked paths across every service + the .claude/skills tree) — Node's execFileSync
// default maxBuffer (1MB) is exceeded, throwing ENOBUFS. Caught below like any other error, but a
// silently-swallowed ENOBUFS previously made this lint report a false "0 findings" on every run
// (confirmed live against the CUSTPORTAL-M1/SHOPPORTAL-H12 worktrees before this fix — the exact
// two items this lint exists to catch). Mirrors leftover-scan.mjs's own 64MB sizing.
const GIT_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
let findings = [];
try {
  const changed = execFileSync('git', ['-C', wt, 'diff', 'HEAD', '--name-only'], GIT_OPTS).split('\n').filter(Boolean);
  const untracked = execFileSync('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard'], GIT_OPTS).split('\n').filter(Boolean);
  const modifiedSites = [...new Set([...changed, ...untracked])].filter((f) => SITE_RE.test(f));
  if (modifiedSites.length) {
    const allSites = execFileSync('git', ['-C', wt, 'ls-files'], GIT_OPTS).split('\n').filter((f) => SITE_RE.test(f));
    const siblingTexts = {};
    for (const f of new Set([...allSites, ...modifiedSites])) {
      try { siblingTexts[f] = readFileSync(join(wt, f), 'utf8'); } catch { /* deleted/renamed — skip */ }
    }
    for (const f of modifiedSites) {
      const text = siblingTexts[f] ?? (existsSync(join(wt, f)) ? readFileSync(join(wt, f), 'utf8') : null);
      if (text == null) continue;
      findings.push(...findRegistrationDrift(f, text, siblingTexts));
    }
  }
} catch (e) {
  // Distinguish "genuinely clean" from "the lint itself broke" — an internal error must never
  // silently masquerade as a clean scan (the exact failure mode this fix replaces: an unhandled
  // ENOBUFS previously reported FACTORY::REGISTRATION-DRIFT::0 on every real run, including
  // against the two worktrees that motivated this lint). Still non-fatal (findings stays [],
  // exit code is still 0 — "best-effort, never blocks a fix" holds) but the marker makes the
  // difference greppable instead of indistinguishable.
  console.log('FACTORY::REGISTRATION-DRIFT-ERROR::' + String((e && e.message) || e).slice(0, 200).replace(/\n/g, ' '));
  findings = [];
}
for (const f of findings) console.log(`FACTORY::REGISTRATION-DRIFT-HIT::${f.file}::${f.method}::${f.args}::vs ${f.siblingExample}`);
console.log('FACTORY::REGISTRATION-DRIFT::' + findings.length);
process.exit(findings.length ? 1 : 0);
