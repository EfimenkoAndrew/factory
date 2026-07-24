// Source ingestion — pure mappers that turn an external issue source (GitHub issues,
// a JSON export, a markdown checklist) into schema-valid work-items for state/normalized/,
// which `driver merge-graph` then folds into the findings-graph. Pure by design (no fs, no
// child_process) so the selftest exercises it directly; the driver (cmdIngest) does the I/O
// and calls these. This is the concrete answer to SETUP.md §6 "Audit ingestion: none shipped".
//
// HONEST-ACCEPTANCE INVARIANT: an item's `acceptance` + `regressionTest` are the factory's
// contract, and a raw issue rarely states them checkably. So a freshly-ingested item is NEVER
// auto-runnable: it lands as autonomyTier 'blocked' (no parseable acceptance → the triage queue)
// or at most 'escalate' (a section was found, but a human still confirms it). The operator/
// bmad-spec refines acceptance + files[] and flips it to 'auto'. Ingestion seeds; it never fabricates
// a green light. Review fix: the invariant is ENFORCED for every source path — `enforceIngestTier`
// clamps --json passthrough items too (an 'auto' or missing tier becomes escalate/blocked), so the
// merge-graph tier default can never promote an ingested item to schedulable.

import { createHash } from 'node:crypto';

const SEV_OK = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

// Label/keyword → severity. First match wins; order matters (critical before high, etc.).
// Boundaries exclude '-' before and alphanumerics after the token (review fix: 'not-critical'
// must not read as CRITICAL, and 'P10' must not read as the 'p1' of HIGH).
const SEV_LABELS = [
  [/(^|[^a-z-])(critical|sev-?1|p0|blocker|urgent)([^a-z0-9]|$)/i, 'CRITICAL'],
  [/(^|[^a-z-])(high|sev-?2|p1|major)([^a-z0-9]|$)/i, 'HIGH'],
  [/(^|[^a-z-])(medium|sev-?3|p2|moderate)([^a-z0-9]|$)/i, 'MEDIUM'],
  [/(^|[^a-z-])(low|sev-?4|p3|minor|trivial)([^a-z0-9]|$)/i, 'LOW'],
];

// Label → theme, so blast-radius/realInfra routing (config escalateThemes/realInfraThemes) can
// fire on ingested items. Extend freely; unmatched falls through to 'triage'.
// Review fix: 'doc' is word-bounded so a 'docker' label no longer routes to doc-drift.
const THEME_LABELS = [
  [/security|auth|vuln|cve|xss|csrf|injection/i, 'security'],
  [/money|billing|payment|invoic|charge|refund/i, 'money'],
  [/concurren|race|deadlock|idempoten/i, 'concurrency'],
  [/crypto|encrypt|secret|token/i, 'crypto'],
  [/perf|latency|slow|throughput/i, 'performance'],
  [/\bdocs?\b|readme|typo/i, 'doc-drift'],
  [/crm|salesforce|hubspot|pipedrive/i, 'crm-link-integrity'],
];

// Markdown section headings we lift into acceptance / regressionTest when an issue body carries them.
const ACCEPTANCE_HEADINGS = ['expected behaviou?r', 'acceptance( criteria)?', 'expected', 'definition of done'];
const REGTEST_HEADINGS = ['steps to reproduce', 'how to (verify|reproduce)', 'reproduction', 'repro', 'verification'];

export function severityFromLabels(labels, fallback = 'MEDIUM') {
  const hay = labelText(labels);
  for (const [re, sev] of SEV_LABELS) if (re.test(hay)) return sev;
  return SEV_OK.includes(fallback) ? fallback : 'MEDIUM';
}

export function themeFromLabels(labels, fallback = 'triage') {
  const hay = labelText(labels);
  for (const [re, theme] of THEME_LABELS) if (re.test(hay)) return theme;
  return fallback;
}

function labelText(labels) {
  if (!Array.isArray(labels)) return '';
  return labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).join(' ');
}

// Pull a markdown section body by heading (## / ### …, optional trailing ':'), stopping at the next
// heading of the same-or-shallower depth. Fenced code blocks are opaque (review fix): a '#' line
// inside ``` fences neither opens nor stops a section. Returns the trimmed inner text of the first
// matching heading whose body is non-empty, or null when none is.
export function extractSection(body, headings) {
  const hit = extractSectionWithHeading(body, headings);
  return hit ? hit.text : null;
}

// Same as extractSection but returns { heading, text } — the ACTUAL matched heading, so provenance
// strings can cite it verbatim (review fix: the old provenance hardcoded "Expected behaviour" even
// when the lifted section was "Acceptance criteria" / "Definition of done").
export function extractSectionWithHeading(body, headings) {
  if (!body || typeof body !== 'string') return null;
  const lines = body.split(/\r?\n/);
  const alt = headings.map((h) => h).join('|');
  const openRe = new RegExp(`^(#{1,6})\\s*(${alt})\\s*:?\\s*$`, 'i');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(openRe);
    if (!m) continue;
    const depth = m[1].length;
    const stopRe = new RegExp(`^#{1,${depth}}\\s`);
    const buf = [];
    let fenced = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*(```|~~~)/.test(lines[j])) fenced = !fenced;
      else if (!fenced && stopRe.test(lines[j])) break;
      buf.push(lines[j]);
    }
    const text = buf.join('\n').trim();
    if (text) return { heading: m[2], text };
  }
  return null;
}

export function clip(s, n = 500) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
}

// Review fix — the honest-acceptance invariant, ENFORCED (not just mapped): whatever the source
// claims, an INGESTED item may only be 'blocked' or 'escalate'. An 'auto' tier, a missing tier, or
// a typo'd tier clamps to 'escalate' when the item carries an acceptance (a human still confirms
// it) and 'blocked' otherwise. Without this, `--json` passthrough items with autonomyTier:'auto' —
// or a missing tier, which merge-graph defaults to 'auto' — would enter the graph schedulable.
export function enforceIngestTier(item) {
  const t = item && item.autonomyTier;
  if (t === 'blocked' || t === 'escalate') return item;
  return { ...item, autonomyTier: item && item.acceptance ? 'escalate' : 'blocked' };
}

// A GitHub issue (as `gh issue view N --json number,title,body,labels,state`) → work-item.
// idPrefix defaults 'GH'; pass a repo-specific one (e.g. 'SF') to group. Never returns a
// scheduleable item — see the honest-acceptance invariant at the top of the file.
export function githubIssueToItem(issue, opts = {}) {
  const num = issue.number;
  const id = `${opts.idPrefix || 'GH'}-${num}`;
  const labels = issue.labels || [];
  const severity = severityFromLabels(labels, opts.severity);
  const theme = themeFromLabels(labels, opts.theme);
  const body = issue.body || '';

  const acceptanceHit = extractSectionWithHeading(body, ACCEPTANCE_HEADINGS);
  const regtestSection = extractSection(body, REGTEST_HEADINGS);
  const hasAcceptance = !!acceptanceHit;

  // With a parseable acceptance section: escalate (human confirms). Without: blocked triage
  // (owner-decision) so it sits in the queue with the issue excerpt, never auto-runs.
  const tier = hasAcceptance ? 'escalate' : 'blocked';
  const fixType = hasAcceptance ? 'non-trivial' : 'owner-decision';

  const acceptance = hasAcceptance
    ? `From ${opts.repo ? opts.repo + ' ' : ''}#${num} "${acceptanceHit.heading}" (REVIEW before scheduling — confirm it is checkable and populate files[]): ${clip(acceptanceHit.text, 900)}`
    : `TRIAGE — ingested from ${opts.repo ? opts.repo + ' ' : ''}#${num}; author a checkable acceptance + regressionTest and the files[] lock set before this can be scheduled. Issue: "${clip(issue.title, 160)}" — ${clip(body, 500)}`;

  const regressionTest = regtestSection
    ? `Derived from the issue's reproduction steps (REVIEW — turn into a red→green test): ${clip(regtestSection, 700)}`
    : `NEEDS AUTHORING — describe the red→green regression proof for #${num} before scheduling.`;

  return {
    id,
    target: opts.target || '',
    layer: opts.layer || 'service',
    title: clip(issue.title, 200) || id,
    severity,
    theme,
    fixType,
    files: [],
    dependsOn: [],
    ownerDecision: hasAcceptance ? null : `Ingested from ${opts.repo || 'github'} #${num}. Triage: set files[], a checkable acceptance, and a regressionTest, then flip autonomyTier to 'auto'.`,
    acceptance,
    regressionTest,
    realInfra: false,
    autonomyTier: tier,
    source: `${opts.repo ? opts.repo.replace(/\s+/g, '') : 'github'}#${num}`,
    fixHint: '',
  };
}

// A markdown checklist ("- [ ] TITLE" lines) → thin triage items. UNCHECKED boxes only (review fix:
// a checked `[x]` box is DONE work — ingesting it resurrects completed tasks into the triage queue;
// the docs promise "- [ ] task" and the code now agrees). Ids are CONTENT-HASHED (review fix:
// positional ids re-attach ledger state to different tasks whenever the backlog is edited or
// reordered — a hash of the normalized title is stable under insertion/deletion/reorder; an
// in-batch duplicate title gets a numeric disambiguator).
export function markdownChecklistToItems(md, opts = {}) {
  if (!md || typeof md !== 'string') return [];
  const prefix = opts.idPrefix || 'BACKLOG';
  const out = [];
  const seen = new Map();
  const lines = md.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const m = lines[ln].match(/^\s*[-*+]\s*\[ ?\]\s+(.+?)\s*$/);
    if (!m) continue;
    const title = m[1];
    const hash = createHash('sha256').update(String(title).trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 8).toUpperCase();
    const dup = (seen.get(hash) || 0) + 1;
    seen.set(hash, dup);
    out.push({
      id: `${prefix}-${hash}${dup > 1 ? '-' + dup : ''}`,
      target: opts.target || '',
      layer: opts.layer || 'service',
      title: clip(title, 200),
      severity: opts.severity || 'MEDIUM',
      theme: opts.theme || 'triage',
      fixType: 'owner-decision',
      files: [],
      dependsOn: [],
      ownerDecision: `Ingested from ${opts.sourceName || 'markdown backlog'}. Triage: set files[], a checkable acceptance, and a regressionTest, then flip autonomyTier to 'auto'.`,
      acceptance: `TRIAGE — ${clip(title, 300)}. Author a checkable acceptance before scheduling.`,
      regressionTest: 'NEEDS AUTHORING — describe the red→green regression proof before scheduling.',
      realInfra: false,
      autonomyTier: 'blocked',
      source: `${opts.sourceName || 'markdown'}#L${ln + 1}`,
      fixHint: '',
    });
  }
  return out;
}

// Count the checked boxes an ingest run SKIPPED (review-fix companion to the unchecked-only rule),
// so the driver can say "skipped N checked" instead of silently dropping them.
export function countCheckedBoxes(md) {
  if (!md || typeof md !== 'string') return 0;
  return (md.match(/^\s*[-*+]\s*\[[xX]\]\s+\S/gm) || []).length;
}

// Summarize an ingested batch for the operator: how many are ready-to-refine (escalate) vs
// pure triage (blocked) — plus `other` (review fix): any tier that is neither, which the
// enforceIngestTier clamp makes impossible for ingest output but a hand-authored normalized
// file could still carry; a non-zero `other` must NEVER print "none are auto-runnable".
export function ingestReport(items) {
  const bySeverity = {};
  let escalate = 0;
  let blocked = 0;
  let other = 0;
  for (const it of items) {
    bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1;
    if (it.autonomyTier === 'escalate') escalate += 1;
    else if (it.autonomyTier === 'blocked') blocked += 1;
    else other += 1;
  }
  return { total: items.length, escalate, blocked, other, bySeverity };
}
