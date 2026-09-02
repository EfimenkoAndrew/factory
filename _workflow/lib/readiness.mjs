// KI-E106 (2026-09-02) — ITEM READINESS: a deterministic pre-`group` gate on the INPUT contract.
//
// Why the input side matters more than any single agent. `acceptance` is the contract EVERY
// downstream stage checks the diff against — the KI-E18 AcceptanceScan splits it into clauses and
// probes per clause, `gate-po` signs off against it, the re-auditor confirms it, and KI-E22 lints
// its named surfaces. Yet it is authored by hand and, until now, nothing BLOCKED on its quality: the
// only check was KI-E22's advisory WARN. That asymmetry is expensive in a specific way — a
// badly-scoped item does not fail cheaply, it buys ~15-25 agent calls of expensive argument, fails,
// and re-bands up to `maxItemRetries + maxBonusRounds` times. KI-E18's own row records acceptance-
// clause coverage gaps as 4/4 of one cycle's band FAILs, and KI-E27 concedes outright that a raw
// ingested issue "rarely states a checkable acceptance + regressionTest".
//
// So this gate sits where the cost is still zero: BEFORE the worktree is cut and the band is spent.
//
// SCOPE — deliberately narrow, and this bound is the whole design. It checks only what can be
// decided MECHANICALLY and objectively about the item's own text: is there an acceptance criterion
// the downstream probes can actually split; is there a regression-test description; is there a
// file-lock set. It does NOT judge whether the acceptance is *correct*, *well-scoped*, or *good* —
// that is a human/authoring judgment, and a gate that guessed at it would reject real work and
// train operators to reach for the override reflexively, which is how a blocking gate becomes
// noise. Every rule here is one an author can satisfy unambiguously.
//
// The gate is BLOCKING with an explicit `--force-unready` escape, matching the repo's posture on
// checks that can be wrong about a specific item (KI-E29/KI-E90 warn-don't-exclude for scheduling
// risk; this one excludes because unlike those, the failure is in the item itself and no amount of
// scheduling luck fixes it).
//
// Reuses `splitAcceptanceClauses` — the SAME splitter the KI-E18 probe runs — so "the acceptance
// yields no checkable clause" here means exactly what it will mean at probe time. There is no second
// definition of "checkable" to drift.
import { splitAcceptanceClauses } from './acceptance.mjs';

// Minimum length for a regressionTest description to count as stated. A bare "yes"/"test"/"n/a" is
// not a red->green contract anyone can write a test from. Deliberately low — the bar is "the author
// wrote something specific", not "the author wrote something good".
const MIN_REGRESSION_TEXT = 15;

// Values authors use to mean "none" — these are ABSENT, not stated, and must not pass on length.
const NULLISH_TEXT = /^(n\/?a|none|tbd|todo|\?+|-+|pending|unknown)$/i;

function stated(v, min) {
  const t = String(v == null ? '' : v).trim();
  if (!t || NULLISH_TEXT.test(t)) return false;
  return t.length >= min;
}

// Returns { ready, problems: [{ code, detail }] }. `problems` is ordered and stable so the driver
// can print it deterministically and a test can pin it.
export function itemReadiness(wi) {
  const problems = [];
  const item = wi || {};

  // 1. acceptance must yield at least one clause the KI-E18 probe could actually check.
  const clauses = splitAcceptanceClauses(item.acceptance, 8);
  if (!stated(item.acceptance, 1)) {
    problems.push({ code: 'acceptance-missing', detail: 'no acceptance criterion — every downstream stage (acceptance-scan, gate-po, re-auditor) checks the diff against this; without it they have nothing to check' });
  } else if (!clauses.length) {
    problems.push({ code: 'acceptance-uncheckable', detail: 'acceptance is present but splits into ZERO checkable clauses (every fragment is under the 20-char floor the KI-E18 splitter applies) — the pre-band coverage probe would silently have nothing to probe: ' + JSON.stringify(String(item.acceptance).slice(0, 120)) });
  }

  // 2. a stated red->green contract. KI-E27's honest-acceptance invariant exists because ingestion
  //    routinely cannot produce one; an item that reaches `group` without it will burn a test-author
  //    round inventing the contract, which is exactly the self-certification the factory avoids.
  if (!stated(item.regressionTest, MIN_REGRESSION_TEXT)) {
    problems.push({ code: 'regression-test-missing', detail: 'no regressionTest description (or a placeholder like "TBD"/"n/a") — the test-author has no stated red->green contract and would have to invent one, which no gate is positioned to check against the ORIGINAL intent' });
  }

  // 3. a file-lock set. Empty files[] disables the KI-E14 lock (nothing to serialize on), makes the
  //    KI-E22 surface lint vacuous, and leaves the fold's P9 root-cause assertion with an empty
  //    rootCauseFiles — which short-circuits TRUE, i.e. the check silently stops applying.
  if (!Array.isArray(item.files) || !item.files.length) {
    problems.push({ code: 'files-empty', detail: 'files[] is empty — the KI-E14 file-lock has nothing to serialize on, the KI-E22 acceptance-surface lint is vacuous, and the fold\'s P9 root-cause check short-circuits to PASS (an empty rootCauseFiles set asserts nothing)' });
  }

  return { ready: problems.length === 0, problems };
}

// Batch helper: the unready subset, in input order. Items whose tier is `blocked` are SKIPPED — they
// are not scheduled anyway (they await an owner ruling), so reporting them here would be noise that
// the operator cannot act on.
export function unreadyItems(items) {
  return (items || [])
    .filter((wi) => wi && wi.autonomyTier !== 'blocked')
    .map((wi) => ({ id: wi.id, ...itemReadiness(wi) }))
    .filter((r) => !r.ready);
}
