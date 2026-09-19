#!/usr/bin/env node
// KI-E182 (2026-09-18) — the countclaims-lint CLI: fixer/editorial/runner (and a manual recovery
// operator) run this in-session (via `verify/build-test.sh countclaims <worktree> <itemDir>`) so a
// stale or invented "N/M passed" test-count claim is caught BEFORE it reaches a reviewer instead of
// costing a full delta re-gate round (EGS-4-3 recovery, 2026-09-18). Single source of truth:
// lib/countclaims.mjs.
// Output contract (machine-greppable):
//   FACTORY::COUNTCLAIMS-MISS::<claim text>   one line per unevidenced count claim (added .md lines only)
//   FACTORY::COUNTCLAIMS::<count>             always last; exit code 1 when count > 0, else 0
// Best-effort: any internal error reports FACTORY::COUNTCLAIMS::0 (a lint aid must never block a fix).
import { lintItemCountClaims } from './lib/countclaims.mjs';

const wt = process.argv[2] || '.';
const itemDir = process.argv[3] || '';
let missing = [];
try { missing = lintItemCountClaims(wt, itemDir, 25) || []; } catch { missing = []; }
for (const m of missing) console.log('FACTORY::COUNTCLAIMS-MISS::' + m);
console.log('FACTORY::COUNTCLAIMS::' + missing.length);
process.exit(missing.length ? 1 : 0);
