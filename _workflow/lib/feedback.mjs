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
