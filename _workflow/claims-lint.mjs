#!/usr/bin/env node
// KI-E11 (2026-07-19) — the EARLY claims-lint CLI: the fixer/editorial/runner run this in-session
// (via `verify/build-test.sh claims <worktree>`) so phantom doc-path claims are fixed BEFORE the
// review band instead of failing adversarial review (cycle-39 ITEM-HI-11: a fabricated
// `Api/Controllers/Support/` path cost a full FAILED round). Single source of truth: the SAME
// lib/doclint.mjs the driver's fold-time F2 WARN uses — no second regex to drift.
// Output contract (machine-greppable):
//   FACTORY::CLAIMS-MISS::<claim>   one line per phantom path claim (added .md lines only)
//   FACTORY::CLAIMS::<count>        always last; exit code 1 when count > 0, else 0
// Best-effort: any internal error reports FACTORY::CLAIMS::0 (a lint aid must never block a fix).
import { lintWorktreeDocClaims } from './lib/doclint.mjs';

const wt = process.argv[2] || '.';
let missing = [];
try { missing = lintWorktreeDocClaims(wt, 25) || []; } catch { missing = []; }
for (const m of missing) console.log('FACTORY::CLAIMS-MISS::' + m);
console.log('FACTORY::CLAIMS::' + missing.length);
process.exit(missing.length ? 1 : 0);
