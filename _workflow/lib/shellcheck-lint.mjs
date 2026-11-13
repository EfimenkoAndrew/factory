// KI-E241 (2026-09-24, MSG-CR-3 follow-up — parent assigns the final KI-E number when
// integrating this alongside sibling in-flight forks' own new KI entries): shellcheck pre-band
// probe. MSG-CR-3's 9-round
// defect chain was mostly pure bash pitfalls found the expensive way (gate/review agents, one at a
// time) — a function invoked as `f "$x" || ...` silently disabling `set -e` inside it, then a
// `Process.Start("chmod", ...)` racing the exec of the same file. This is the first probe in this
// engine to shell out to `shellcheck` rather than a text/AST-shape diff — same "a real external tool
// answers this, text-diffing cannot" posture as KI-E185's `dotnet ef migrations
// has-pending-model-changes` probe.
//
// IMPORTANT, verified empirically before shipping (the KI-E185 lesson: verify against REAL tool
// output before trusting an assumption): shellcheck's DEFAULT check set does NOT flag the MSG-CR-3
// masking-bug shape at all (`shellcheck --format=json` on both a broken and a fixed version of the
// real pattern returns `[]`). The relevant check, SC2310 ("This function is invoked in an ||
// condition so set -e will be disabled. Invoke separately if failures should cause the script to
// exit."), is an OPTIONAL check, only emitted with `--enable=all`, and only at `info` severity — so
// this probe MUST pass `--enable=all --severity=style` (the lowest severity, so nothing optional is
// filtered) to have any chance of catching the class it exists for. This also means "findings" here
// legitimately includes low-signal style nits (e.g. SC2250 "prefer braces around variable
// references") alongside the high-signal SC2310 class — this probe is deliberately ADVISORY (like
// `registration-drift.mjs`/KI-E77), surfacing everything for a human/gate-agent to triage by
// severity, never auto-blocking on volume.

export const SHELLCHECK_JSON_VERSION = 1;

// A curated set of codes worth calling out by name in the summary — not because other codes don't
// matter, but because these are the ones with a direct incident citation in this repo's own history.
const NOTABLE_CODES = new Map([
  [2310, 'function invoked under || disables set -e inside it (the MSG-CR-3 masking-bug class — verify the function captures $? and checks it explicitly before returning)'],
]);

const SEVERITY_RANK = { error: 0, warning: 1, info: 2, style: 3 };

export function classifyShellcheckOutput(jsonText, { exitCode = null } = {}) {
  let findings;
  try {
    findings = JSON.parse(jsonText);
  } catch {
    // shellcheck's own JSON output is malformed/empty — distinguish this from "ran cleanly", never
    // silently report clean on a parse failure (the KI-E185 anchored-grep lesson: an ambiguous
    // signal must not collapse into the wrong verdict).
    return { verdict: 'inconclusive', findings: [], summary: 'shellcheck output could not be parsed as JSON', exitCode };
  }
  if (!Array.isArray(findings)) {
    return { verdict: 'inconclusive', findings: [], summary: 'shellcheck output was not a JSON array', exitCode };
  }
  if (findings.length === 0) {
    return { verdict: 'clean', findings: [], summary: 'shellcheck: 0 findings (--enable=all --severity=style)', exitCode };
  }
  const normalized = findings
    .map((f) => ({
      file: f.file, line: f.line, column: f.column, level: f.level, code: f.code, message: f.message,
      notable: NOTABLE_CODES.get(f.code) || null,
    }))
    .sort((a, b) => (SEVERITY_RANK[a.level] ?? 9) - (SEVERITY_RANK[b.level] ?? 9));
  const byLevel = {};
  for (const f of normalized) byLevel[f.level] = (byLevel[f.level] || 0) + 1;
  const notableCount = normalized.filter((f) => f.notable).length;
  const levelSummary = Object.entries(byLevel).map(([level, n]) => `${level}=${n}`).join(' ');
  const summary = `shellcheck: ${findings.length} finding(s) (${levelSummary})`
    + (notableCount ? `, ${notableCount} notable (incident-cited class)` : '');
  return { verdict: 'findings', findings: normalized, summary, exitCode };
}

export function unavailableResult(reason) {
  return { verdict: 'unavailable', findings: [], summary: 'shellcheck not available: ' + reason, exitCode: null };
}
