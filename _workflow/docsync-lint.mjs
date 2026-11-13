#!/usr/bin/env node
// KI-E126 (2026-09-02) — the DocSync CLI: `verify/build-test.sh docsync <worktree>`.
// Cheap, EARLY prevention for the rule `dataflow.md § Documentation Synchronization` already makes
// blocking at the review gates: a diff that changes a controller / handler / consumer / EventMapper /
// integration event / job / service-client MUST update that service's doc/data-flows/{Service}.md.
// Single source of truth: lib/docsync.mjs (pure, selftest-covered).
// Output contract (machine-greppable, mirrors registration-drift-lint.mjs/leftover-lint.mjs):
//   FACTORY::DOCSYNC-HIT::<service>::<doc path>::<trigger file> (<what it is>)[; ...]
//   FACTORY::DOCSYNC::<count>                                             always last
// ADVISORY at the CLI level (exit 1 on hits makes it loud, nothing treats that as fatal); the caller
// decides. Best-effort: any internal error reports an ERROR marker and count 0 — a lint aid must
// never block a fix, and an internal failure must never masquerade as a clean scan (the KI-E77
// ENOBUFS lesson: a swallowed error silently reported "0 findings" on every real run).
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { docSyncGaps } from './lib/docsync.mjs';

const wt = process.argv[2] || '.';
const GIT_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
let gaps = [];
try {
  const changed = execFileSync('git', ['-C', wt, 'diff', 'HEAD', '--name-only'], GIT_OPTS).split('\n').filter(Boolean);
  // Untracked files count too — a brand-new consumer is exactly the shape that needs a doc row.
  const untracked = execFileSync('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard'], GIT_OPTS).split('\n').filter(Boolean);
  // The docs that ACTUALLY exist, read from the real tree: a service with no data-flow doc can never
  // be flagged (absence of a doc is not a doc-sync violation — see lib/docsync.mjs).
  let existing = [];
  try { existing = readdirSync(join(wt, 'doc', 'data-flows')).filter((f) => f.endsWith('.md')).map((f) => 'doc/data-flows/' + f); } catch { existing = []; }
  gaps = docSyncGaps([...changed, ...untracked], existing);
} catch (e) {
  console.log('FACTORY::DOCSYNC-ERROR::' + String((e && e.message) || e).slice(0, 200).replace(/\n/g, ' '));
  gaps = [];
}
for (const g of gaps) {
  console.log(`FACTORY::DOCSYNC-HIT::${g.service}::${g.doc}::` + g.triggers.map((t) => `${t.file} (${t.what})`).join('; '));
}
console.log('FACTORY::DOCSYNC::' + gaps.length);
process.exit(gaps.length ? 1 : 0);
