#!/usr/bin/env node
// KI-E104 (2026-09-02) — the ROOT-CAUSE-TOUCH CLI: the deterministic half of a PRE-BAND P9.
//
// P9 ("a diff that touched ONLY tests greened the test, it did not fix the bug") is one of the
// fold's deterministic overrides in `driver.mjs` — and it ran ONLY at fold, i.e. AFTER the entire
// gate band had already been spent. That is the exact economics KI-E83 fixed for its sibling P1
// (the RED-proof marker), after ITEM-H24 and ITEM-H26 each burned a FULL band with 9 and 8 gates
// APPROVED before the fold's grep rejected them. P9 is strictly cheaper to hoist than P1 was: it
// needs no marker, no transcript and no agent judgment — just the worktree's own diff — so the whole
// check is a `git status` and a regex.
//
// Single source of truth: the SAME `lib/verify.mjs` predicate the fold's P9 applies (`nonTestChanged`,
// which `touchedRootCause` itself is now defined in terms of), and the SAME `lib/worktree.mjs`
// `changedFiles` the fold reads. There is deliberately no second derivation to drift.
//
// Output contract (machine-greppable, mirrors leftover-lint/claims-lint):
//   FACTORY::ROOTCAUSE-FILE::<path>   one per non-test changed file (capped at 25)
//   FACTORY::ROOTCAUSE::<count>       always last; exit 1 when count === 0
//
// NOTE the INVERTED exit polarity vs its sibling lints: for leftovers/comments a non-zero count is
// the failure, here a ZERO count is. Stated explicitly because the marker names look alike.
//
// Best-effort on INFRASTRUCTURE failure only (unreadable worktree / git unavailable): reports
// `FACTORY::ROOTCAUSE-SKIP` and exits 0, because a lint that cannot run must never fail a fix that
// might be correct — the fold's own P9 still applies later as the authoritative backstop. This is
// the KI-E20 "announce a skipped diff check, never let silence read as clean" posture: the skip is
// a DISTINCT marker, so a caller can tell "no non-test files" from "could not look".
import { changedFiles } from './lib/worktree.mjs';
import { nonTestChanged } from './lib/verify.mjs';

const wt = process.argv[2] || '.';
let changed = null;
try { changed = changedFiles(wt); } catch { changed = null; }
if (!Array.isArray(changed)) {
  console.log('FACTORY::ROOTCAUSE-SKIP worktree unreadable or git unavailable: ' + wt);
  process.exit(0);
}
const nonTest = nonTestChanged(changed);
for (const f of nonTest.slice(0, 25)) console.log('FACTORY::ROOTCAUSE-FILE::' + f);
console.log('FACTORY::ROOTCAUSE::' + nonTest.length);
process.exit(nonTest.length ? 0 : 1);
