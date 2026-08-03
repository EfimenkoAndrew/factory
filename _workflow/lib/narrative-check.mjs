// Narrative/verdict contradiction detector (KI-E67). Detection aid at fold, WARN-only — same
// posture as F2 (doclint.mjs) / KI-D12 (leftover-scan.mjs) / KI-E59 (comment-scan.mjs): never a
// fold-blocker, the deterministic toState override remains the verdict.
//
// Found live 2026-08-03 while investigating ITEM-22 (FAILED — deterministic override: "integrate
// transcript: 406 new suite failure(s) beyond baseline 0"): the item's OWN artifact directory
// carries a `VERIFICATION-REPORT.md` whose narrative is a confident, 10-point "✅ COMPLETE — All
// acceptance criteria met, zero leftovers, build passes... Ready for merge... No additional
// changes required" — directly contradicting the machine-evidence-based FAILED verdict. This is a
// concrete, striking instance of the factory's single largest recurring rejection driver ("agent
// self-report vs machine-verifiable evidence", KI-E19/E38/E43/E51/E54) and cost real investigation
// time to disentangle from a genuine defect. A cheap, mechanical check surfaces the SAME
// contradiction automatically for any future FAILED/ESCALATED item, rather than requiring a human
// to notice the mismatch by hand.
//
// Deliberately conservative: only fires on toState FAILED/ESCALATED (an item that is CLOSED with
// upbeat language is not a contradiction — it is a description of what actually happened), and
// only on STRONG, unambiguous completion phrasing — not every optimistic sentence, to keep the
// false-positive rate low on a WARN channel a human is expected to read.
const STRONG_COMPLETION_MARKERS = [
  /✅\s*(complete|all acceptance criteria)/i,
  /all acceptance criteria (?:are\s+)?met/i,
  /ready for merge/i,
  /no additional changes (?:required|needed)/i,
  /zero leftovers/i,
  /status.{0,10}:\s*.{0,20}complete/i,
];

// Pure core (selftest-covered): given the fold toState and a map of {filename: text}, return the
// files whose text contains a strong completion marker, when toState signals a real failure.
export function detectNarrativeVerdictContradiction(toState, textsByFile) {
  if (toState !== 'FAILED' && toState !== 'ESCALATED') return [];
  const hits = [];
  for (const [file, text] of Object.entries(textsByFile || {})) {
    const t = String(text || '');
    for (const re of STRONG_COMPLETION_MARKERS) {
      const m = t.match(re);
      if (m) { hits.push({ file, marker: m[0] }); break; } // one hit per file is enough to flag it
    }
  }
  return hits;
}
