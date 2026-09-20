export const responseContract = `Return JSON only: {"cases":[{"caseId":"...","verdict":"APPROVED|CHANGES_REQUIRED","findings":[{"findingId":"local unique id","rule":"documentation|bounds|tenant|idempotency|secrets|other","file":"relative path","line":1,"severity":"HIGH|MEDIUM|LOW|CRITICAL","text":"concrete input, consequence and minimal remedy"}]}]}. Return all six cases, including clean cases. Do not invent defects. Rules classify findings, not a required checklist. No tools, file writes or external research. The supplied complete files are the entire changed surface; acceptance defines scope. Existing brief requests for worktree reads/artifact writes are replaced by reviewing these embedded files and returning JSON. Judge only reachable violations of explicit acceptance; do not report unspecified validation requirements.`;

export const compactContract = `Independent adversarial code reviewer. Inspect every supplied changed file cold: logic, operators, invariants, mutation order, errors, resources and async behavior. Trace reachable boundaries (null/empty/zero/negative, off-by-one, duplicates and concurrency) where the stated input domain permits them. Check acceptance clause by clause. Verify evidence against complete embedded source rather than comments or previous reviews. Rank concrete correctness/security/acceptance violations with file and line, trigger, consequence and minimal fix. Drop style preferences, speculative unsupported inputs and handled paths. No minimum finding count. APPROVED only if no HIGH/CRITICAL finding survives; otherwise CHANGES_REQUIRED. Honor supplied host policy; scopeViolation would mean only an explicit product red-line, not a touch-set deviation. Recheck the findings once for completeness and false positives. Keep cases independent.`;

export function benchmarkCases() {
  const definitions = [
    ['docs-clean', 'documentation', 'approved', 'Document the configured retry count and all registered routes exactly. No other claims are required.', {
      'config.json': '{"retries":3,"routes":["/health","/orders"]}',
      'README.md': 'Retries: 3. Routes: /health and /orders.\n',
    }, []],
    ['docs-stale', 'documentation', 'rejected', 'Document the configured retry count and all registered routes exactly. No other claims are required.', {
      'config.json': '{"retries":3,"routes":["/health","/orders"]}',
      'README.md': 'Retries: 5. Routes: /health and /orders.\n',
    }, ['documentation:README.md']],
    ['page-clean', 'ordinary-code', 'approved', 'Inputs page and size are integers; size is 1..100. Reject page below 1 or above ceil(rows.length/size); otherwise return that one-based page. Empty rows have no valid page.', {
      'page.js': 'export function page(rows, page, size) {\n  if (page < 1 || page > Math.ceil(rows.length / size)) throw new RangeError();\n  return rows.slice((page - 1) * size, page * size);\n}\n',
    }, []],
    ['page-mixed', 'ordinary-code', 'mixed', 'Inputs page and size are integers; size is 1..100. Reject page below 1 or above ceil(rows.length/size); otherwise return that one-based page. Empty rows have no valid page.', {
      'page.js': 'export function page(rows, page, size) {\n  if (page < 1 || page > Math.ceil(rows.length / size)) throw new RangeError();\n  return rows.slice(page * size, (page + 1) * size);\n}\n',
    }, ['bounds:page.js']],
    ['tenant-rejected', 'high-risk', 'rejected', 'Only return an order when BOTH its id and its tenantId match authenticated server context. Inputs are nonempty strings. Order ids can repeat across tenants; rows are immutable. Return undefined when no match.', {
      'order.js': 'export function getOrder(rows, id, context) {\n  return rows.find(row => row.id === id);\n}\n',
    }, ['tenant:order.js']],
    ['payment-mixed', 'high-risk', 'mixed', 'Calls are sequential; event.id is a unique immutable string. Each event may arrive more than once. Credit balance by event.amount at most once per id; record processed ids in state.seen (a Set). Amount is a positive safe integer and balances remain safe integers. Never pass event.secret to the logger. All state operations and logger calls succeed synchronously.', {
      'payment.js': 'export function apply(state, event, log) {\n  if (state.seen.has(event.id)) return;\n  state.balance += event.amount;\n  log({ eventId: event.id, secret: event.secret });\n}\n',
    }, ['idempotency:payment.js', 'secrets:payment.js']],
  ];
  return definitions.map(([caseId, stratum, originalOutcome, acceptance, files, seeds]) => ({
    caseId, itemId: 'synthetic-' + caseId, stratum, originalOutcome,
    snapshot: { baseRevision: 'synthetic-v1', acceptance, files, policy: { noExternalAssumptions: true }, reviewerContract: responseContract },
    seeds,
  }));
}
