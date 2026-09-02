#!/usr/bin/env node
// KI-E91 (2026-08-28, ported from a host-mount session) — the LedgerAnchor CLI:
// `verify/build-test.sh ledger-anchor <worktree>`. Cheap, EARLY prevention companion mirroring
// leftover-lint.mjs's engine-owned-lint shape. Single source of truth: lib/ledger-anchor.mjs
// (pure, selftest-covered).
// Output contract (machine-greppable, mirrors leftover-lint.mjs/registration-drift-lint.mjs):
//   FACTORY::LEDGER-ANCHOR-DUP-HIT::<anchor>::<level>::<fileA>::<fileB>
//   FACTORY::LEDGER-ANCHOR-TAG-HIT::<anchor>::<claimedFile>::<tagFound: true|false>
//   FACTORY::LEDGER-ANCHOR::<count>                                    always last
// ADVISORY, never blocking on its own (the classify step decides): a duplicate-at-the-same-level
// hit is a real signal but not a certain contradiction (an identical cross-post is legitimate); a
// TAG-HIT with tagFound=false is closer to certain but still classified for context. Best-effort:
// any internal error reports count 0 — a lint aid must never block a fix.
//
// LEDGER_PATHS is this host's configured set of standards-divergence ledger files — currently a
// SINGLE ledger (this repo has no sibling/subrepo ledger the way the origin host-mount session
// did), so the duplicate-anchor half of lib/ledger-anchor.mjs always finds zero candidates (there
// is no second file to compare against) while the tag-claim half stays fully active. Extend this
// array the moment a host configures a second ledger path — both halves activate unmodified.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findLedgerAnchorCandidates, fileHasStandardsEvolutionTag } from './lib/ledger-anchor.mjs';

const wt = process.argv[2] || '.';
const LEDGER_PATHS = ['_bmad-output/tech-debt/STANDARDS-DIVERGENCE-LEDGER.md'];
// KI-E54-style buffer sizing — see leftover-lint.mjs's sibling rationale: a monorepo's `git` output
// on some invocations can exceed Node's 1MB execFileSync default.
const GIT_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
let dup = [];
let tag = [];
try {
  const changed = execFileSync('git', ['-C', wt, 'diff', 'HEAD', '--name-only'], GIT_OPTS).split('\n').filter(Boolean);
  const touchedLedgers = LEDGER_PATHS.filter((p) => changed.includes(p));
  if (touchedLedgers.length) {
    const ledgerTexts = {};
    for (const p of LEDGER_PATHS) {
      try { ledgerTexts[p] = existsSync(join(wt, p)) ? readFileSync(join(wt, p), 'utf8') : null; } catch { ledgerTexts[p] = null; }
    }
    const claimSeen = new Set();
    for (const touched of touchedLedgers) {
      const diffText = execFileSync('git', ['-C', wt, 'diff', 'HEAD', '--', touched], GIT_OPTS);
      const { dup: d, tagClaims } = findLedgerAnchorCandidates(touched, diffText, ledgerTexts, LEDGER_PATHS);
      dup.push(...d);
      for (const c of tagClaims) {
        const key = c.anchor + '::' + c.claimedFile;
        if (claimSeen.has(key)) continue; // same claim reachable from >1 touched ledger — report once
        claimSeen.add(key);
        let fileText = null;
        try { fileText = existsSync(join(wt, c.claimedFile)) ? readFileSync(join(wt, c.claimedFile), 'utf8') : null; } catch { fileText = null; }
        tag.push({ anchor: c.anchor, claimedFile: c.claimedFile, tagFound: fileHasStandardsEvolutionTag(fileText) });
      }
    }
  }
} catch (e) {
  // Distinguish "genuinely clean" from "the lint itself broke" — an internal error must never
  // silently masquerade as a clean scan.
  console.log('FACTORY::LEDGER-ANCHOR-ERROR::' + String((e && e.message) || e).slice(0, 200).replace(/\n/g, ' '));
  dup = []; tag = [];
}
for (const d of dup) console.log(`FACTORY::LEDGER-ANCHOR-DUP-HIT::${d.anchor}::${d.level}::${d.fileA}::${d.fileB}`);
for (const t of tag) console.log(`FACTORY::LEDGER-ANCHOR-TAG-HIT::${t.anchor}::${t.claimedFile}::${t.tagFound}`);
console.log('FACTORY::LEDGER-ANCHOR::' + (dup.length + tag.length));
process.exit((dup.length + tag.length) ? 1 : 0);
