// KI-E126 (2026-09-02) — DOC-SYNC: the pure half of the `verify/build-test.sh docsync` lint.
//
// `dataflow.md § Documentation Synchronization` is unambiguous: "Every PR that modifies a
// controller, Mediator handler, MassTransit consumer, EventMapper, integration event contract,
// background job, or service-to-service HTTP client MUST update the corresponding
// doc/data-flows/{Service}.md file in the same PR", and the review gates treat a stale doc as a
// BLOCKING finding. Until now nothing checked it before the gate band.
//
// Cost of that, measured: cycle 81's EGS-1-2 was judged an "excellent, correct,
// independently-verified" fix that met every acceptance clause, and FAILED anyway — CHANGES_REQUIRED
// "only because doc/data-flows/ServiceName.md §6.2/6.3/6.5 still documents the retired SQL
// mechanisms". A full 5-opus gate panel plus refuter plus adjudicator, spent to discover a missing
// doc edit that a path comparison finds for free.
//
// Deliberately CONSERVATIVE — this feeds a probe that can fail an item pre-band, and a false fail
// costs a whole re-band:
//   - Only files whose path shape matches a doc-sync trigger count (controller/handler/consumer/
//     EventMapper/job/service-client), so ordinary source edits never trip it.
//   - The service is derived from the FIRST path segment, which is this repo's layout
//     (`ServiceName/src/...`, `WebPortal/Controllers/...`).
//   - A trigger only becomes a finding when the service's data-flow doc ACTUALLY EXISTS
//     (`existingDocs`, supplied by the caller from the real repo). A shared library or a service
//     that has no such doc can never be flagged — absence of a doc is not a violation.
//   - Anything already touching that doc in the same diff is satisfied, which is the whole rule.

export const DOCSYNC_TRIGGERS = [
  { what: 'controller', re: /(^|\/)[A-Za-z0-9_]*Controller\.cs$/ },
  { what: 'command/query handler', re: /(^|\/)[A-Za-z0-9_]*(CommandHandler|QueryHandler)\.cs$/ },
  { what: 'MassTransit consumer', re: /(^|\/)[A-Za-z0-9_]*Consumer\.cs$/ },
  { what: 'EventMapper', re: /(^|\/)[A-Za-z0-9_]*EventMapper\.cs$/ },
  { what: 'integration event', re: /(^|\/)MarketPlace\.Shared\.Events\/.*\.cs$/ },
  { what: 'background job', re: /(^|\/)[A-Za-z0-9_]*(Job|HostedService)\.cs$/ },
  { what: 'service-to-service client', re: /(^|\/)[A-Za-z0-9_]*ServiceClient\.cs$/ },
];

// The service that owns a path — this repo's top-level-directory-per-service layout.
export function serviceOf(path) {
  const p = String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const seg = p.split('/')[0];
  return seg && !seg.startsWith('.') && seg !== 'doc' ? seg : '';
}

export function docPathFor(service) {
  return service ? `doc/data-flows/${service}.md` : '';
}

// changed: the diff's file list. existingDocs: the data-flow docs that really exist in the repo
// (Set or array of `doc/data-flows/X.md`). Returns one finding per service that needed its doc
// updated and did not, naming the trigger files so the reader can see WHY it fired.
export function docSyncGaps(changed, existingDocs) {
  const files = Array.isArray(changed) ? changed.map((f) => String(f).replace(/\\/g, '/')) : [];
  if (!files.length) return [];
  const have = new Set([...(existingDocs || [])].map((d) => String(d).replace(/\\/g, '/')));
  const touchedDocs = new Set(files.filter((f) => /^doc\/data-flows\/[^/]+\.md$/.test(f)));
  const bySvc = new Map();
  for (const f of files) {
    if (/(^|\/)[A-Za-z0-9_]*Tests?\.cs$/.test(f)) continue; // a test file is not the documented surface
    const t = DOCSYNC_TRIGGERS.find((x) => x.re.test(f));
    if (!t) continue;
    const svc = serviceOf(f);
    const doc = docPathFor(svc);
    if (!svc || !have.has(doc)) continue;   // no doc exists for this service -> nothing to keep in sync
    if (touchedDocs.has(doc)) continue;     // already updated in the same diff -> the rule is met
    if (!bySvc.has(svc)) bySvc.set(svc, { service: svc, doc, triggers: [] });
    if (bySvc.get(svc).triggers.length < 6) bySvc.get(svc).triggers.push({ file: f, what: t.what });
  }
  return [...bySvc.values()];
}
