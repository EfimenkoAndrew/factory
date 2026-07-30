#!/usr/bin/env node
// KI-E59 (2026-07-30) — the CommentScan CLI: the fixer/runner run this in-session (via
// `verify/build-test.sh comments <worktree>`) so a comment the factory itself added or reworded is
// caught on the FIXER's own diff BEFORE the review band — the deterministic backstop for the
// host-policy-gated NO-COMMENTS rule (KI-E51/KI-E55/KI-E57; active only when the host enables
// `policies.noNewComments`) that fixer.md/test-author.md/gate-developer.md/review-code.md carry.
// Single source of truth: lib/comment-scan.mjs.
// Output contract (machine-greppable, mirrors claims-lint/leftover-lint):
//   FACTORY::COMMENT-HIT::<file>::<kind>::<trimmed added line>   one per candidate (capped at 50)
//   FACTORY::COMMENT-SCAN-SKIPPED::<n>                           when n untracked files were unreadable
//   FACTORY::COMMENT::<count>                                    always last on a completed scan; exit 1 when count>0
//   FACTORY::COMMENT-SCAN-ERROR::<reason>                        scan could NOT run (no count line; exit 2)
// A consumer must treat a missing FACTORY::COMMENT line / exit 2 as GATE-UNAVAILABLE, never as a
// clean scan (AP#19 — a silent 0 on failure previously read as APPROVED downstream).
import { findComments } from './lib/comment-scan.mjs';

const wt = process.argv[2] || '.';
let hits;
try {
  hits = findComments(wt, 50) || [];
} catch (e) {
  console.log('FACTORY::COMMENT-SCAN-ERROR::' + String((e && e.message) || e).split('\n')[0].slice(0, 200));
  process.exit(2);
}
for (const h of hits) console.log('FACTORY::COMMENT-HIT::' + h.file + '::' + h.kind + '::' + h.line);
if (hits.skipped) console.log('FACTORY::COMMENT-SCAN-SKIPPED::' + hits.skipped);
console.log('FACTORY::COMMENT::' + hits.length);
process.exit(hits.length ? 1 : 0);
