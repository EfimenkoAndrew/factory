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
// a green light.

export const SOURCE_TYPES = ['github', 'json', 'markdown'];

const SEV_OK = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

// Label/keyword → severity. First match wins; order matters (critical before high, etc.).
const SEV_LABELS = [
  [/(^|[^a-z])(critical|sev-?1|p0|blocker|urgent)([^a-z]|$)/i, 'CRITICAL'],
  [/(^|[^a-z])(high|sev-?2|p1|major)([^a-z]|$)/i, 'HIGH'],
  [/(^|[^a-z])(medium|sev-?3|p2|moderate)([^a-z]|$)/i, 'MEDIUM'],
  [/(^|[^a-z])(low|sev-?4|p3|minor|trivial)([^a-z]|$)/i, 'LOW'],
];

// Label → theme, so blast-radius/realInfra routing (config escalateThemes/realInfraThemes) can
// fire on ingested items. Extend freely; unmatched falls through to 'triage'.
const THEME_LABELS = [
  [/security|auth|vuln|cve|xss|csrf|injection/i, 'security'],
  [/money|billing|payment|invoic|charge|refund/i, 'money'],
  [/concurren|race|deadlock|idempoten/i, 'concurrency'],
  [/crypto|encrypt|secret|token/i, 'crypto'],
  [/perf|latency|slow|throughput/i, 'performance'],
  [/doc|readme|typo/i, 'doc-drift'],
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

// Pull a markdown section body by heading (## / ### …), stopping at the next heading of the
// same-or-shallower depth. Returns trimmed inner text, or null if no matching heading.
export function extractSection(body, headings) {
  if (!body || typeof body !== 'string') return null;
  const lines = body.split(/\r?\n/);
  const alt = headings.map((h) => h).join('|');
  const openRe = new RegExp(`^(#{1,6})\\s*(?:${alt})\\s*$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(openRe);
    if (!m) continue;
    const depth = m[1].length;
    const stopRe = new RegExp(`^#{1,${depth}}\\s`);
    const buf = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (stopRe.test(lines[j])) break;
      buf.push(lines[j]);
    }
    const text = buf.join('\n').trim();
    if (text) return text;
  }
  return null;
}

export function clip(s, n = 500) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
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

  const acceptanceSection = extractSection(body, ACCEPTANCE_HEADINGS);
  const regtestSection = extractSection(body, REGTEST_HEADINGS);
  const hasAcceptance = !!acceptanceSection;

  // With a parseable acceptance section: escalate (human confirms). Without: blocked triage
  // (owner-decision) so it sits in the queue with the issue excerpt, never auto-runs.
  const tier = hasAcceptance ? 'escalate' : 'blocked';
  const fixType = hasAcceptance ? 'non-trivial' : 'owner-decision';

  const acceptance = hasAcceptance
    ? `From ${opts.repo ? opts.repo + ' ' : ''}#${num} "Expected behaviour" (REVIEW before scheduling — confirm it is checkable and populate files[]): ${clip(acceptanceSection, 900)}`
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

// A markdown checklist ("- [ ] TITLE" lines) → thin triage items. Each becomes a blocked
// owner-decision item (author acceptance later). idPrefix + 1-based index form the id.
export function markdownChecklistToItems(md, opts = {}) {
  if (!md || typeof md !== 'string') return [];
  const prefix = opts.idPrefix || 'BACKLOG';
  const out = [];
  let n = 0;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[[ xX]?\]\s+(.+?)\s*$/);
    if (!m) continue;
    n += 1;
    const title = m[1];
    out.push({
      id: `${prefix}-${n}`,
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
      source: `${opts.sourceName || 'markdown'}#${n}`,
      fixHint: '',
    });
  }
  return out;
}

// Summarize an ingested batch for the operator: how many are ready-to-refine (escalate) vs
// pure triage (blocked), so the report says what still needs authoring.
export function ingestReport(items) {
  const bySeverity = {};
  let escalate = 0;
  let blocked = 0;
  for (const it of items) {
    bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1;
    if (it.autonomyTier === 'escalate') escalate += 1;
    else if (it.autonomyTier === 'blocked') blocked += 1;
  }
  return { total: items.length, escalate, blocked, bySeverity };
}
