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

// KI-E74C — the MIRROR case. detectNarrativeVerdictContradiction above catches a FAILED/ESCALATED
// verdict contradicted by confident-DONE prose; this catches the opposite direction, a CLOSED
// verdict contradicted by an artifact that ITSELF admits something is NOT actually resolved.
//
// Found live 2026-08-07 on ITEM-H1: the runner's OWN verify.json wrote, verbatim, "Build+targeted-
// test green here does NOT mean round 2's findings are resolved — they are not, and are unaddressed
// in this worktree as of this pass" — naming 5 specific unaddressed findings from an earlier review
// round. All 8 gates/reviews subsequently APPROVED anyway (the note had no channel to reach them —
// see KI-E74B, the separate PREVENTIVE fix that now surfaces it in every review-role prompt). This
// is the DETECTIVE backstop for when the preventive fix isn't enough — an agent still misses the
// surfaced note, or a similar admission lands in some OTHER artifact.
//
// Deliberately conservative, mirroring the ORIGINAL's discipline: fires ONLY on toState CLOSED (an
// item that ends FAILED/BLOCKED/ESCALATED with cautionary language is not a contradiction — it is
// an accurate description), and only on STRONG, unambiguous non-resolution admissions modeled
// directly on the ITEM-H1 phrasing — never a bare appearance of "unresolved" (a LOW finding
// correctly deferred as non-blocking commonly and legitimately uses that word).
const NON_RESOLUTION_MARKERS = [
  /does not mean[^.\n]{0,60}(?:resolved|addressed)/i,
  /\b(?:findings?|issues?)[^.\n]{0,40}(?:are|remain|stay) (?:not resolved|unresolved|unaddressed)/i,
  /unaddressed in (?:this|the) worktree/i,
  /resolved[,.]?\s*(?:—|-)\s*they are not\b/i,
];
// Pure core (selftest-covered): given the fold toState and a map of {filename: text}, return the
// files whose text contains a strong non-resolution admission, when toState signals success.
export function detectUnresolvedCaveatOnClose(toState, textsByFile) {
  if (toState !== 'CLOSED') return [];
  const hits = [];
  for (const [file, text] of Object.entries(textsByFile || {})) {
    const t = String(text || '');
    for (const re of NON_RESOLUTION_MARKERS) {
      const m = t.match(re);
      if (m) { hits.push({ file, marker: m[0] }); break; } // one hit per file is enough to flag it
    }
  }
  return hits;
}
