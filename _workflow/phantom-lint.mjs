#!/usr/bin/env node
// KI-E141 (2026-09-05) — the PHANTOM-MANIFEST CLI: the deterministic half of a PRE-BAND P11.
//
// P11 ("fix.json's filesChanged was never deterministically compared to the real worktree diff")
// is one of the fold's deterministic overrides in `driver.mjs` — and it ran ONLY at fold, i.e.
// AFTER the entire gate band had already been spent. KI-E118's own words, verbatim: "this
// pipeline's most expensive observed failure... partial work reported as complete" (KI-E93 covered
// 1 of 3 named controllers; KI-E94 fixed one switch arm and left its twin; the 2026-08-09 haiku
// batch closed 1/17 with three fixers reporting "all acceptance criteria met"). That is the EXACT
// economics KI-E83 fixed for its sibling P1 and KI-E104 fixed for its sibling P9 — this hoists the
// third and last fold-time-only member of that family.
//
// Single source of truth: the SAME lib/verify.mjs predicate the fold's P11 applies
// (phantomManifest, which itself normalises via pathToken — the KI-E122/KI-E134 annotated-entry
// and {path,change}-object shapes are handled there, not re-derived here), and the SAME
// lib/worktree.mjs changedFiles the fold reads.
//
// Output contract (machine-greppable, mirrors rootcause-lint/leftover-lint):
//   FACTORY::PHANTOM-FILE::<path>   one per claimed-but-absent file (capped at 25)
//   FACTORY::PHANTOM::<count>       always last; exit 1 when count > 0 (a phantom exists)
//
// The claimed-files list is read from a SCRATCH JSON file the calling probe writes FRESH (via the
// Write tool) immediately before invoking this script — NEVER from state/items/<id>/fix.json.
// KI-E117's stepwise fixer never writes a consolidated fix.json to disk at all (only
// fix-step-N.json per step + fix-consolidation.json for the final sweep); the UNION filesChanged
// the fold actually checks (res.filesChanged) is assembled by runItem()'s own JS code and exists
// only in memory until result.json. Reading fix.json from disk would have made this probe silently
// INERT for exactly the shape it matters most for (KI-E117 stepwise: "a stepwise run's manifest is
// the UNION of per-step claims, so a phantom names the step that lied") — caught before shipping by
// checking whether MEDIA-M4's own 7-step run had ever written one (it had not). Mirrors the
// checkpointResult/checkpointProgress pattern instead: factory.js already HOLDS the authoritative
// value (res.filesChanged) and hands it to an agent to persist verbatim via the Write tool, exactly
// like every other cross-call handoff in this pipeline.
import { readFileSync } from 'node:fs';
import { changedFiles, committedSinceBase } from './lib/worktree.mjs';
import { phantomManifest, pathToken } from './lib/verify.mjs';

const wt = process.argv[2] || '.';
const claimedPath = process.argv[3] || '';

let changed = null;
try { changed = changedFiles(wt); } catch { changed = null; }
if (!Array.isArray(changed)) {
  console.log('FACTORY::PHANTOM-SKIP worktree unreadable or git unavailable: ' + wt);
  process.exit(0);
}

let claimed = null;
if (claimedPath) {
  try {
    const parsed = JSON.parse(readFileSync(claimedPath, 'utf8'));
    if (Array.isArray(parsed) && parsed.length) claimed = parsed;
  } catch { claimed = null; }
}
if (!Array.isArray(claimed)) {
  console.log('FACTORY::PHANTOM-SKIP no readable non-empty claimed-files JSON at: ' + (claimedPath || '(no path given)'));
  process.exit(0);
}

// KI-E271: clean-worktree fallback — if the worktree has no uncommitted changes but the fixer
// DID claim files, check whether a prior session already committed the fix to the branch tip.
// This handles the NOTIF-H6-SIBLINGS pattern: prior session commits → phantom probe sees an
// empty `git status` → every claimed file would be misclassified as a phantom. Using the last
// commit's diff as the effective "changed" set lets the probe verify correctly in that case.
// Emits FACTORY::PHANTOM-COMMITTED-FALLBACK (machine-greppable) so the fold can see which
// path fired; still emits FACTORY::PHANTOM:: at the end so the calling agent always gets a count.
if (changed.length === 0) {
  let committed = null;
  try { committed = committedSinceBase(wt); } catch { committed = null; }
  if (Array.isArray(committed) && committed.length > 0) {
    console.log('FACTORY::PHANTOM-COMMITTED-FALLBACK ' + committed.length + ' file(s) from last commit used (worktree clean — prior session committed the fix)');
    changed = committed;
  }
}

const phantoms = phantomManifest(changed, claimed);
// KI-E134: phantoms carries the ORIGINAL claimedFiles entries (possibly {path,change} objects) —
// display the extracted path, never a bare String(entry) that renders an object as "[object Object]"
// (the exact display bug the fold's own P11 message was fixed to avoid; mirrored here verbatim).
for (const f of phantoms.slice(0, 25)) console.log('FACTORY::PHANTOM-FILE::' + (pathToken(f) || JSON.stringify(f)));
console.log('FACTORY::PHANTOM::' + phantoms.length);
process.exit(phantoms.length ? 1 : 0);
