#!/usr/bin/env node
// KI-E237 (provisional number — reconcile against KNOWN-ISSUES.md at integration time if it
// collides with a concurrently-authored entry) — the ConcurrencyScan CLI:
// `verify/build-test.sh concurrency-scan <worktree>`. Single source of truth: lib/concurrency-scan.mjs
// (pure, selftest-covered).
// Output contract (machine-greppable, mirrors registration-drift-lint.mjs):
//   FACTORY::CONCURRENCY-SCAN-HIT::<file>::<pattern>::<line, truncated>
//   FACTORY::CONCURRENCY-SCAN::<count>                                    always last
// ADVISORY, never blocking: this never gates pass/fail on its own — factory.js uses a nonzero
// count only to decide whether to inject a mandatory repetition-testing notice into the relevant
// gate/review prompts (see factory.js's own KI-E237 comment). Best-effort: any internal error
// reports count 0 — a lint aid must never block a fix.
import { execFileSync } from 'node:child_process';

const wt = process.argv[2] || '.';
const GIT_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
let hits = [];
try {
  const { scanConcurrencyTouch } = await import('./lib/concurrency-scan.mjs');
  const diff = execFileSync('git', ['-C', wt, 'diff', 'HEAD'], GIT_OPTS);
  hits = scanConcurrencyTouch(diff);
} catch (e) {
  console.log('FACTORY::CONCURRENCY-SCAN-ERROR::' + String((e && e.message) || e).slice(0, 200).replace(/\n/g, ' '));
  hits = [];
}
for (const h of hits) console.log(`FACTORY::CONCURRENCY-SCAN-HIT::${h.file}::${h.pattern}::${h.line}`);
console.log('FACTORY::CONCURRENCY-SCAN::' + hits.length);
process.exit(hits.length ? 1 : 0);
