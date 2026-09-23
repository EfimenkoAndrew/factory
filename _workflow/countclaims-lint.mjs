#!/usr/bin/env node
// KI-E182 (2026-09-18) — the countclaims-lint CLI: fixer/editorial/runner (and a manual recovery
// operator) run this in-session (via `verify/build-test.sh countclaims <worktree> <itemDir>`) so a
// stale or invented "N/M passed" test-count claim is caught BEFORE it reaches a reviewer instead of
// costing a full delta re-gate round (EGS-4-3 recovery, 2026-09-18). Single source of truth:
// lib/countclaims.mjs.
// Output contract (machine-greppable):
//   FACTORY::COUNTCLAIMS-MISS::<claim text>   one line per unevidenced count claim (added .md lines only)
//   FACTORY::COUNTCLAIMS::<count>             completed checks only; exit 0 clean, 1 mismatch
// Missing/unavailable evidence is advisory exit 2, never a numeric clean completion marker.
import { lintItemCountClaims } from './lib/countclaims.mjs';
import { readFileSync } from 'node:fs';

const wt = process.argv[2] || '.';
const itemDir = process.argv[3] || '';
let report;
try {
  const options = { cap: 25 };
  const args = process.argv.slice(4);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--legacy') options.legacy = true;
    else if (flag === '--no-active-contract') options.noActiveContract = true;
    else if (['--transcript', '--progress', '--claim', '--repo-root'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('missing value for ' + flag);
      if (flag === '--transcript') (options.transcripts ||= []).push(value);
      else if (flag === '--repo-root') options.repoRoot = value;
      else options[flag.slice(2)] = JSON.parse(readFileSync(value, 'utf8'));
    } else throw new Error('unknown countclaims argument: ' + flag);
  }
  report = lintItemCountClaims(wt, itemDir, options);
} catch (e) { report = { status: 'unavailable', missing: [], sources: [], errors: [e.message] }; }
for (const source of report.sources) console.log('FACTORY::COUNTCLAIMS-SOURCE::' + JSON.stringify(source));
for (const m of report.missing) console.log('FACTORY::COUNTCLAIMS-MISS::' + m);
for (const error of report.errors) console.log('FACTORY::COUNTCLAIMS-NOTE::' + JSON.stringify(error));
console.log('FACTORY::COUNTCLAIMS-STATUS::' + report.status);
const complete = ['clean', 'mismatch'].includes(report.status);
if (complete) console.log('FACTORY::COUNTCLAIMS::' + report.missing.length);
process.exit(complete ? report.missing.length ? 1 : 0 : 2);
