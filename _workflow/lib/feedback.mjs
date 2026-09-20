// KI-L31 — the reFix feedback channel as a DETERMINISTIC PROJECTION.
//
// Problem class: every gate/review agent both RETURNS a structured verdict (schema-forced,
// reliable) and WRITES a prose artifact file (a side effect an LLM can forget — cycle-20's
// adversarial reviewer returned a fresh CRITICAL that existed only in the run journal while the
// on-disk review-*.md was the prior attempt's). Any feedback loop that reads the files trusts N
// side effects; a single miss silently feeds a reFix stale findings.
//
// Invariant established here: the authoritative feedback for a failed attempt is DERIVED from the
// structured results the factory returned — one writer (the driver, at fold), one file
// (state/items/<id>/feedback.md), regenerated on every fold. Agent-written prose stays useful as
// supplementary detail but is never the authority. Pure function: results in, markdown out — the
// self-test exercises it without a filesystem.
export function renderFeedback(result) {
  const gd = result && result.gateDetails;
  if (!gd || !Object.keys(gd).length) return null;
  const cyc = String(result.resultId || '').split('#')[1] || '?';
  const lines = [
    `# feedback — ${result.id} (attempt/cycle ${cyc}) — AUTHORITATIVE`,
    '',
    '> Driver-written projection of the structured verdicts this attempt RETURNED (KI-L31).',
    '> The per-role gate-*.md / review-*.md files are supplementary prose and MAY be stale or',
    '> unwritten — when they disagree with this file, THIS file wins.',
    '',
    `**Outcome:** ${result.toState}${result.note ? ' — ' + result.note : ''}`,
    `**Stage path:** ${(result.transitions || []).join(' → ') || '(none)'}`,
    '',
  ];
  for (const [key, d] of Object.entries(gd)) {
    if (!d) { lines.push(`## ${key} — NULL (agent returned nothing; fail-closed)`, ''); continue; }
    lines.push(`## ${key} — ${d.verdict}${d.headline ? '' : ''}`);
    if (d.headline) lines.push('', d.headline);
    if (d.acceptanceMet === false) lines.push('', '- acceptanceMet: **false**');
    if (d.redGreenConfirmed === false) lines.push('- redGreenConfirmed: **false**');
    const f = Array.isArray(d.findings) ? d.findings : [];
    if (f.length) {
      lines.push('', '### Findings');
      for (const x of f) {
        lines.push(`- **${x.severity || '?'}** — ${x.title || '(untitled)'}${x.file ? ` (\`${x.file}\`)` : ''}`);
        if (x.fix) lines.push(`  - fix: ${x.fix}`);
      }
    }
    if (Array.isArray(d.reasons) && d.reasons.length) {
      lines.push('', '### Reasons', ...d.reasons.map((r) => `- ${r}`));
    }
    lines.push('');
  }
  return lines.join('\n');
}

// KI-E166 (ported from a host-mount session) — feedback.md is "regenerated on every fold" (this
// file's own header comment) — meaning a finding raised by an EARLIER cycle (e.g. a gate-qa
// test-coverage gap) is silently LOST the moment a LATER cycle's own, different rejection reason
// (e.g. a docsync gap) overwrites the file, even though the earlier finding was never actually
// fixed. A reFix round that faithfully reads feedback.md — exactly as its own briefing already
// instructs — then has zero visibility into that older, still-open finding: it can "fix" the newer
// one while the older one sails through unaddressed, until a LATER gate independently rediscovers
// it from scratch. Live incident on the origin host: a later cycle's gate:qa named the EXACT gap an
// earlier gate-qa pass on the SAME item had already flagged, never fixed because the intervening
// round only addressed a different, unrelated finding — that intervening round's own feedback.md
// (regenerated for THAT cycle's own failure reason) carried no trace of the earlier finding at all.
//
// mergeFeedbackHistory keeps the CURRENT cycle's content authoritative and on top (byte-identical
// behavior for an item with no prior feedback.md — the common first-attempt case) but APPENDS the
// prior file's content below a clearly-labeled header instead of discarding it outright. Capped so
// a chronically-failing item's file cannot grow unbounded across many cycles. Each cycle's prior
// content is re-truncated to the cap before being re-appended, so the total file size stays bounded
// at roughly (this cycle's own content) + CAP, not an ever-growing chain.
export const FEEDBACK_HISTORY_CAP = 6000;
export function mergeFeedbackHistory(freshContent, priorContent) {
  if (!priorContent || !String(priorContent).trim()) return freshContent;
  const trimmedPrior = String(priorContent).trim().slice(0, FEEDBACK_HISTORY_CAP);
  return freshContent
    + '\n---\n\n## PRIOR CYCLE(S)\' FEEDBACK (KI-E166)\n\n'
    + 'Re-verify EACH finding below against the CURRENT tree before dismissing it — do not assume '
    + 'it was already fixed just because a LATER cycle failed for a different reason. A finding '
    + 'here that still reproduces is exactly as binding as one in the section above.\n\n'
    + trimmedPrior;
}
