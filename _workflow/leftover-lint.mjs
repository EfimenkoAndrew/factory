#!/usr/bin/env node
// KI-D12 (2026-07-19) — the LeftoverScan CLI: the fixer/runner run this in-session (via
// `verify/build-test.sh leftovers <worktree>`) so an intentionally-created leftover (TODO/FIXME/HACK/
// "for now"/"deferred"/NotImplementedException/…) is caught on the FIXER's own diff BEFORE the review
// band — enforcing execution-policy.md §4 cheaply and early. Single source of truth: the SAME
// lib/leftover-scan.mjs the driver's fold-time re-check and the factory's haiku probe read.
// Output contract (machine-greppable, mirrors claims-lint):
//   FACTORY::LEFTOVER-HIT::<file>::<lexeme>::<trimmed added line>   one per candidate (capped at 25)
//   FACTORY::LEFTOVER::<count>                                      always last; exit 1 when count>0
// Best-effort: any internal error reports FACTORY::LEFTOVER::0 (a lint aid must never block a fix).
import { findLeftovers } from './lib/leftover-scan.mjs';

const wt = process.argv[2] || '.';
let hits = [];
try { hits = findLeftovers(wt, 25) || []; } catch { hits = []; }
for (const h of hits) console.log('FACTORY::LEFTOVER-HIT::' + h.file + '::' + h.lexeme + '::' + h.line);
console.log('FACTORY::LEFTOVER::' + hits.length);
process.exit(hits.length ? 1 : 0);
