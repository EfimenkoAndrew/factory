// KI-L41 — convergence-bonus round (KNOWN-ISSUES §A.11 proposal, implemented 2026-07-03).
//
// Problem: a flat retry bound parks 95%-done items. Both 2026-07-02 escalation candidates
// (ITEM-C-DEPLOY at ~3 enumerated netpol label sites; ITEM-C5 at 4 enumerated doc/test
// fixes) were items whose failing-finding set was strictly SHRINKING round over round — the flat
// bound would have parked provably-converging work, while a naive "keep retrying" relaxation would
// re-burn full bands on items that are NOT converging.
//
// Invariant: one bonus attempt past `maxItemRetries` is granted DETERMINISTICALLY, at fold, from
// the structured gateDetails deltas (KI-L31 data) — never from an agent's self-assessment. The
// trajectory must be strictly narrower: fewer blocking findings AND max severity not worse. The
// bonus is bounded by `maxBonusRounds` (config; default 1) per item, so the cost governor stays
// predictable: worst case = maxItemRetries + maxBonusRounds bands.
//
// Pure functions — the driver owns ledger persistence; the self-test exercises these directly.

const SEV_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

// Summarise a result's gate band into a comparable shape:
//   { blockingGates, findings, maxRank }
// - blockingGates: count of non-APPROVED verdicts (NULL counts — fail-closed, an agent that
//   returned nothing is an unknown blocker, graded HIGH).
// - findings: total findings across blocking verdicts (a blocking verdict listing zero findings
//   still counts as 1 finding-equivalent, graded MEDIUM — it blocked for SOME reason).
// - maxRank: numeric rank of the most severe blocking finding (LOWER = MORE severe).
// Returns null when the result carries no gateDetails at all (pre-gate failure — test/verify/fold
// stage; no convergence judgment is possible there).
export function gateFindingsSummary(result) {
  const gd = result && result.gateDetails;
  if (!gd || !Object.keys(gd).length) return null;
  let blockingGates = 0, findings = 0, maxRank = 99;
  for (const d of Object.values(gd)) {
    if (!d) { blockingGates++; findings++; maxRank = Math.min(maxRank, SEV_RANK.HIGH); continue; }
    if (d.verdict === 'APPROVED') continue;
    blockingGates++;
    const fs = Array.isArray(d.findings) ? d.findings : [];
    if (fs.length) {
      findings += fs.length;
      for (const f of fs) maxRank = Math.min(maxRank, SEV_RANK[f && f.severity] ?? SEV_RANK.MEDIUM);
    } else {
      findings += 1;
      maxRank = Math.min(maxRank, SEV_RANK.MEDIUM);
    }
  }
  return { blockingGates, findings, maxRank };
}

// Strictly-narrower trajectory: the current FAILED round must have (a) at least one blocking
// verdict (a zero-blocking FAILED failed elsewhere — integrate/refute — not comparable), (b) fewer
// total blocking findings than the prior round, and (c) a max severity that did not get WORSE
// (rank did not decrease). Equal counts do NOT qualify — "strictly" is what separates convergence
// from oscillation (a reviewer re-wording the same findings keeps the count level).
export function isStrictlyNarrower(cur, prev) {
  if (!cur || !prev) return false;
  if (!cur.blockingGates || !prev.blockingGates) return false;
  return cur.findings < prev.findings && cur.maxRank >= prev.maxRank;
}

// KI-E239 (2026-09-24, failure-analysis-and-improvements-2026-09-24.md finding #3) — a second,
// narrower convergence-bonus shape, orthogonal to isStrictlyNarrower's round-over-round trajectory
// comparison. Real incidents: a prior item (gate:developer/gate:qa APPROVED, all 4 review flows
// dissented in unison on ONE narrow finding -- attempts exhausted before a corrected round could
// complete) and a sibling item this session (3 of 6 gates found the exact same one small finding after
// the other 3 had already approved, needing a full extra round). isStrictlyNarrower only ever
// compares ONE round's aggregate finding COUNT against the PRIOR round's — it has no notion of
// WHICH roles dissented, so it cannot recognize this shape, and in particular can never fire on the
// FIRST round of dissent (no `prev` to be narrower than). Empirically, "primary gates clean,
// reviewers converging on one corroborated thing" predicted a cheap, single-round fix in both
// incidents above — worth a bonus on its own merits, independent of any numeric trend.
//
// 'gate:*' keys are the primary/technical gates (developer, qa, architect, security, po); named
// review keys ('review:code-review' etc., plus 'editorial:*') are review-flow lenses — the same
// axis lib/recover.mjs's roleForGateKey/KEY_ROLE already encodes, reused here rather than
// re-derived. 'probe:*', 'adjudicator', and ':re-gate' rows are excluded exactly like
// dissentersFrom already excludes them (not gate/review verdicts).
const PRIMARY_GATE_PREFIX = 'gate:';

// Two findings "corroborate" when their titles share enough distinctive vocabulary to plausibly be
// the SAME underlying issue independently worded by different reviewers (real dissenters describing
// one bug essentially never produce byte-identical prose). Deliberately conservative: short/common
// words are dropped first, and a single shared generic word must never count on its own.
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'was',
  'be', 'this', 'that', 'with', 'not', 'but', 'it', 'as', 'at', 'by', 'from']);
function titleWords(title) {
  return new Set(String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length > 2 && !STOPWORDS.has(w)));
}
export function findingsCorroborate(a, b) {
  const wa = titleWords(a && a.title), wb = titleWords(b && b.title);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const smaller = Math.min(wa.size, wb.size);
  return shared >= 2 || shared / smaller >= 0.5;
}

// The above shape: every PRIMARY gate present in gateDetails is APPROVED (fail-closed —
// a null/missing-verdict primary gate, "an agent that returned nothing", blocks this path exactly
// like gateFindingsSummary's own fail-closed convention), every dissenting role is a review-flow
// lens (never a primary gate), at least 2 distinct review roles dissented, each of THOSE dissenting
// roles reported EXACTLY ONE finding (a role flagging several things is a bigger surface, not this
// narrow shape), and at least 2 of those single findings corroborate each other. A lone dissenting
// reviewer — however well-evidenced — never qualifies on its own; corroboration is what
// distinguishes "reviewers independently converged on something real" from "one reviewer found one
// thing" (which isStrictlyNarrower's own aggregate-count comparison already handles on its own
// merits, when there is a prior round to compare against).
export function isSingleCorroboratedReviewFinding(gateDetails) {
  const gd = gateDetails || {};
  const entries = Object.entries(gd).filter(([key]) =>
    !key.includes(':re-gate') && !key.startsWith('probe:') && key !== 'adjudicator' && !key.startsWith('adjudicator:'));
  if (!entries.length) return false;
  const primaryDissented = entries.some(([key, d]) => key.startsWith(PRIMARY_GATE_PREFIX) && (!d || d.verdict !== 'APPROVED'));
  if (primaryDissented) return false;
  const dissentingReviews = entries.filter(([key, d]) => !key.startsWith(PRIMARY_GATE_PREFIX) && d && d.verdict === 'CHANGES_REQUIRED');
  if (dissentingReviews.length < 2) return false;
  const singleFindingDissents = dissentingReviews.filter(([, d]) => Array.isArray(d.findings) && d.findings.length === 1);
  if (singleFindingDissents.length < 2) return false;
  for (let i = 0; i < singleFindingDissents.length; i++) {
    for (let j = i + 1; j < singleFindingDissents.length; j++) {
      if (findingsCorroborate(singleFindingDissents[i][1].findings[0], singleFindingDissents[j][1].findings[0])) return true;
    }
  }
  return false;
}

// Fold-time application: for every FAILED result, compare against the row's persisted prior-round
// summary; grant at most one bonus per fold and at most `maxBonusRounds` lifetime, ONLY when the
// grant is what keeps the item schedulable (attempts already past the base bound). Always persists
// the current summary as `row.convergence` for the next round's comparison. Mutates rows; returns
// the granted ids (the driver logs + persists the ledger).
export function applyConvergenceBonus(ledger, cfg, results) {
  if (!cfg || !cfg.retryBonusOnConvergence) return [];
  const bound = cfg.maxItemRetries;
  if (typeof bound !== 'number') return [];
  const maxBonus = typeof cfg.maxBonusRounds === 'number' ? cfg.maxBonusRounds : 1;
  const granted = [];
  for (const r of results || []) {
    if (!r || r.toState !== 'FAILED') continue;
    const row = ledger.items[r.id];
    if (!row) continue;
    const cur = gateFindingsSummary(r);
    if (!cur) continue; // pre-gate failure — nothing to compare; row.convergence stays as-is
    const prev = row.convergence || null;
    const cyc = String(r.resultId || '').split('#')[1] || null;
    const narrower = isStrictlyNarrower(cur, prev);
    // KI-E239 — a second, independent bonus-eligibility path, checked even when `narrower` is
    // false (most notably on the FIRST dissenting round, where isStrictlyNarrower has no `prev` to
    // compare against at all). Either path alone is sufficient; never both required.
    const singleCorroborated = isSingleCorroboratedReviewFinding(r.gateDetails);
    if ((narrower || singleCorroborated)
        && row.attempts > bound + (row.retryBonus || 0)
        && (row.retryBonus || 0) < maxBonus) {
      row.retryBonus = (row.retryBonus || 0) + 1;
      granted.push({
        id: r.id, from: prev, to: cur, retryBonus: row.retryBonus,
        reason: narrower ? 'strictly-narrower' : 'single-corroborated-review-finding',
      });
    }
    row.convergence = { cycle: cyc, ...cur };
  }
  return granted;
}

// KI-E105 (2026-09-02) — the MISSING HALF of KI-L41. Everything above is asymmetric: it only ever
// EXTENDS the retry budget (a narrowing trajectory earns a bonus round). Nothing ever SHORTENS it.
// An item whose blocking-finding set is flat or GROWING round over round still consumed its full
// `maxItemRetries` allowance — and a band is the single most expensive unit of work the factory has
// (a FULL band is ~5 opus gates + review.code + review.adversarial + refuter + multi-lens re-audit;
// KI-E88 measures the gate panel alone at ~4x LIGHT). Spending band three on a trajectory that has
// twice failed to make ANY numerical progress is close to pure waste, and it delays the human review
// the item evidently needs.
//
// The comparison data already existed and was simply unused: `applyConvergenceBonus` persists
// `row.convergence` on EVERY fold (line ~84), not just on the rounds it grants a bonus for. This
// reads the same field the bonus path writes, so the two directions can never disagree about what
// "the prior round" was.
//
// Deliberately CONSERVATIVE, in three ways, because a false stall parks work that would have closed:
//   - It is the strict complement of progress, not the complement of `isStrictlyNarrower`. A round
//     that reduces findings but whose max severity got WORSE is NOT narrowing (no bonus) yet is also
//     NOT stalled — real progress was made and the severity shift may be a re-classification. Only
//     `cur.findings >= prev.findings` — no numerical progress at all — counts as a stall.
//   - It requires BOTH rounds to carry comparable gate data (`blockingGates`), exactly as
//     `isStrictlyNarrower` does. A pre-gate failure (test/verify/fold stage) never counts toward a
//     stall: nothing was adjudicated, so there is no trajectory to judge.
//   - It needs `maxStallRounds` CONSECUTIVE stalled rounds (config; default 2), and any round with
//     real progress resets the counter to zero. One bad round is noise; two in a row is a pattern.
export function isNotConverging(cur, prev) {
  if (!cur || !prev) return false;
  if (!cur.blockingGates || !prev.blockingGates) return false;
  return cur.findings >= prev.findings;
}

// Fold-time stall accounting. Mirrors applyConvergenceBonus's shape (mutates rows, returns what it
// changed for the driver to log) and is called immediately after it so both read the SAME
// `row.convergence` value from the prior fold before it is overwritten.
//
// Ordering note: applyConvergenceBonus overwrites `row.convergence` with the CURRENT summary at the
// end of its loop, so this function cannot run after it and still see the prior round. It therefore
// takes the prior summary explicitly, captured by the driver BEFORE the bonus pass.
// KI-E167 (2026-09-13) — HALF of every real multi-attempt exhaustion is invisible to the mechanism
// above. gateFindingsSummary (and therefore isNotConverging/isStrictlyNarrower) returns null for ANY
// result whose gateDetails is empty — which is every failure that never reaches the gate band at all:
// a build failure, a missing RED-proof/realInfra marker, worktree debris, main-tree contamination, a
// refuted fix, a non-converged re-audit lens, a failed global-regression integrate. Audited against
// the live ledger (710 items, 276 CLOSED / 45 ESCALATED / 41 BLOCKED): of the 43 items that burned
// >=3 full attempts before landing ESCALATED/BLOCKED, 23 (53%) exhausted their budget on exactly one
// of these pre-band-blind stages — with stallRounds frozen the entire time because nothing above ever
// looks at them; only 12 (28%) exhausted on a gate-band trajectory the existing mechanism can see at
// all. A prior item is the sharpest live instance: its final two attempts both failed with the
// byte-identical "realInfra marker probe (KI-E10): verify-raw.txt has NO FACTORY::REALINFRA:: marker
// on disk..." note, and the existing mechanism never noticed the repeat — it burned a THIRD full band
// (the flat maxItemRetries bound, not the smart detector) before finally escalating.
//
// failSignature gives these failures a coarse, deterministic fingerprint from the one field every
// FAILED result already carries — `note` — without needing gateDetails at all. It intentionally
// identifies WHICH CHECK failed, not the exact defect inside it (cut at the first ": " or " — "
// separator, matching this file's own established "<check-name>[(<KI-ref>)]: <dynamic detail>" /
// "<check-name> — <dynamic detail>" note convention; falls back to a 60-char cap for a note with
// neither separator). Two consecutive FAILED rounds on the SAME item with the SAME signature is at
// least as strong a non-convergence signal as a flat gate-band finding count — the fixer's change had
// NO effect on the actual blocking condition, not merely an unchanged one — so it feeds the IDENTICAL
// `stallRounds` counter and `maxStallRounds` bound as the findings-based path above, rather than
// adding a second knob a host would also have to learn and tune.
export function failSignature(note) {
  const s = String(note || '').trim();
  if (!s) return null;
  let cut = s.length;
  const colon = s.indexOf(': ');
  if (colon >= 0) cut = Math.min(cut, colon);
  const dash = s.indexOf(' — ');
  if (dash >= 0) cut = Math.min(cut, dash);
  cut = Math.min(cut, 60);
  if (cut <= 0) cut = Math.min(s.length, 60);
  return s.slice(0, cut).trim().toLowerCase();
}

export function applyStallDetection(ledger, cfg, results, priorByItem) {
  const maxStall = typeof cfg?.maxStallRounds === 'number' ? cfg.maxStallRounds : 2;
  if (maxStall <= 0) return []; // 0 disables the mechanism entirely (host opt-out)
  const stalled = [];
  for (const r of results || []) {
    if (!r || r.toState !== 'FAILED') continue;
    const row = ledger.items[r.id];
    if (!row) continue;
    const cur = gateFindingsSummary(r);
    const sig = failSignature(r.note);
    // Fix (multi-lens review, ported from a host-mount session): `cur` can be a TRUTHY object with
    // ZERO blockingGates — gateFindingsSummary returns { blockingGates: 0, findings: 0, maxRank: 99 }
    // for a FAILED result whose gateDetails exist but are ALL verdict:'APPROVED' (a gate band that ran
    // and cleared, on a round that still failed for some OTHER, later reason). The bare `if (cur)`
    // took the gate-comparison branch for that shape too, and isNotConverging/isStrictlyNarrower both
    // treat a zero-blockingGates side as "not comparable" and fall through to `row.stallRounds = 0` —
    // silently CLEARING a real, already-accumulating signature-based stall streak the very next line
    // was supposed to detect. Requiring `cur.blockingGates` truthy before trusting the richer
    // comparison routes this shape to the signature fallback instead, exactly like a pre-gate failure.
    if (cur && cur.blockingGates) {
      // the richer, already-working comparison — unchanged from before KI-E167, and it always wins
      // when gate-band data exists (this branch never second-guesses it with the coarser signature).
      const prev = (priorByItem && priorByItem[r.id]) || null;
      if (isNotConverging(cur, prev)) {
        row.stallRounds = (row.stallRounds || 0) + 1;
        row.stallReason = 'findings'; // KI-E167 — persisted so a LATER fold's escalateExhausted (which never sees this function's return value) still knows which evidence shape to report
        if (row.stallRounds >= maxStall) stalled.push({ id: r.id, stallRounds: row.stallRounds, reason: 'findings', from: prev, to: cur });
      } else {
        row.stallRounds = 0; // any real progress clears the streak
      }
    } else if (sig && row.lastFailSignature && sig === row.lastFailSignature) {
      // KI-E167 fallback: no gate-band data this round, but the SAME check failed the SAME way as the
      // immediately-prior round (whatever kind of round that was). A genuinely incomparable round on
      // its own still neither manufactures progress nor erases a real prior stall — it only ever ADDS
      // a stall it can positively prove, exactly mirroring the findings path's conservatism.
      row.stallRounds = (row.stallRounds || 0) + 1;
      row.stallReason = 'signature';
      if (row.stallRounds >= maxStall) stalled.push({ id: r.id, stallRounds: row.stallRounds, reason: 'signature', signature: sig });
    }
    // Deliberately no trailing `else` here: a round with NEITHER a comparable gate-band trajectory NOR
    // a matching repeated-failure signature (most commonly: no note at all, e.g. a pre-gate test/verify
    // /fold crash) proves NOTHING either way — not progress, not a repeat — so stallRounds/stallReason
    // are left exactly as they were. Resetting on "no signal" would let one incidental note-less round
    // (an infra hiccup unrelated to the real blocking defect) silently erase an already-accumulating,
    // legitimately-proven stall streak, extending a chronically-stalled item's effective retry budget
    // for free. KI-E105/KI-E167 both pin this "untouched" outcome explicitly as a regression guard.
    // Always advance to THIS round's signature (even null, even on a cur-truthy round) so the next
    // comparison is against the immediately-preceding round — never a stale one from several rounds
    // back, which is what "consecutive" means everywhere else in this file.
    row.lastFailSignature = sig;
  }
  return stalled;
}

// A row is stall-parked when its consecutive-no-progress streak has reached the bound. Read by the
// driver's exhaustion sweep so a stalled item is escalated to the human queue on the SAME pass that
// parks retry-exhausted ones — one place decides "stop scheduling this", never two.
export function isStalled(cfg, row) {
  const maxStall = typeof cfg?.maxStallRounds === 'number' ? cfg.maxStallRounds : 2;
  if (maxStall <= 0) return false;
  return ((row && row.stallRounds) || 0) >= maxStall;
}

// Effective retry bound for a row: the flat config bound plus any convergence bonus this row earned.
// Single definition consumed by BOTH gatekeepers (computeReady scheduling + escalateExhausted
// parking) so they can never disagree about whether an item is retryable.
export function effectiveRetryBound(boundOrCfg, row) {
  const base = typeof boundOrCfg === 'number' ? boundOrCfg : (boundOrCfg && boundOrCfg.maxItemRetries);
  if (typeof base !== 'number') return null;
  return base + ((row && row.retryBonus) || 0);
}
