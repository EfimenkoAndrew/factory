#!/usr/bin/env node
// KI-E238 (2026-09-24) — the VacuousTestScan CLI: `verify/build-test.sh vacuous-test-scan <worktree>`.
// Cheap, EARLY prevention lint — catches a [Fact]/[Theory]/[SkippableFact] method whose only
// reachable assertion is gated behind a conditional early `return;` (or that never asserts at all),
// so it passes unconditionally regardless of whether the fix under test actually works. Motivating
// incidents: a prior item (4 test methods silently no-op'd on an unlocatable-path guard) and
// a sibling vacuous-test class (prior incident, though that one's root cause — scanning the wrong
// interface — is semantic and out of this scanner's reach). Single source of truth:
// lib/vacuous-test-scan.mjs (pure, unit-tested).
// Output contract (machine-greppable, mirrors leftover-lint.mjs/registration-drift-lint.mjs):
//   FACTORY::VACUOUS-TEST-HIT::<file>::<method>::<reason>
//   FACTORY::VACUOUS-TEST-SCAN::<count>                          always last
// ADVISORY, never blocking: exit 1 on a hit makes it loud in the same style as leftovers/
// registration-drift, but nothing in this engine treats that exit code as fatal — judgment stays
// with whoever reads the hit. Best-effort: any internal error reports count 0 — a lint aid must
// never block a fix.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanVacuousTests } from './lib/vacuous-test-scan.mjs';

const wt = process.argv[2] || '.';
const TEST_FILE_RE = /Tests?\.cs$/;
const GIT_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
let findings = [];
try {
  const changed = execFileSync('git', ['-C', wt, 'diff', 'HEAD', '--name-only'], GIT_OPTS).split('\n').filter(Boolean);
  const untracked = execFileSync('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard'], GIT_OPTS).split('\n').filter(Boolean);
  const modifiedTestFiles = [...new Set([...changed, ...untracked])].filter((f) => TEST_FILE_RE.test(f));
  for (const f of modifiedTestFiles) {
    let text;
    try { text = readFileSync(join(wt, f), 'utf8'); } catch { continue; } // deleted/renamed — skip
    for (const hit of scanVacuousTests(text)) findings.push({ file: f, ...hit });
  }
} catch (e) {
  // Distinguish "genuinely clean" from "the lint itself broke" — mirrors registration-drift-lint.mjs's
  // KI-E77 fix for the identical failure mode (an unhandled internal error must never silently
  // masquerade as a clean scan).
  console.log('FACTORY::VACUOUS-TEST-SCAN-ERROR::' + String((e && e.message) || e).slice(0, 200).replace(/\n/g, ' '));
  findings = [];
}
for (const f of findings) console.log(`FACTORY::VACUOUS-TEST-HIT::${f.file}::${f.method}::${f.reason}`);
console.log('FACTORY::VACUOUS-TEST-SCAN::' + findings.length);
process.exit(findings.length ? 1 : 0);
