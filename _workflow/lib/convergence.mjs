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
    if (isStrictlyNarrower(cur, prev)
        && row.attempts > bound + (row.retryBonus || 0)
        && (row.retryBonus || 0) < maxBonus) {
      row.retryBonus = (row.retryBonus || 0) + 1;
      granted.push({ id: r.id, from: prev, to: cur, retryBonus: row.retryBonus });
    }
    row.convergence = { cycle: cyc, ...cur };
  }
  return granted;
}

// Effective retry bound for a row: the flat config bound plus any convergence bonus this row earned.
// Single definition consumed by BOTH gatekeepers (computeReady scheduling + escalateExhausted
// parking) so they can never disagree about whether an item is retryable.
export function effectiveRetryBound(boundOrCfg, row) {
  const base = typeof boundOrCfg === 'number' ? boundOrCfg : (boundOrCfg && boundOrCfg.maxItemRetries);
  if (typeof base !== 'number') return null;
  return base + ((row && row.retryBonus) || 0);
}
