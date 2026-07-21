export const meta = {
  name: 'impl-factory',
  description: 'AI Implementation Factory control plane. Receives a batch of READY work items (audit findings / stories) + agent templates + per-item model routing via args (emitted by driver.mjs select), then drives each item through the implement-and-auto-evaluate lifecycle: (plan) -> test-author(red) -> fixer -> verify(build+test) -> early edge-scan (pre-band edge-case hunt + one bounded amend, every code item) -> acceptance-scan (pre-band clause-coverage probe + one bounded amend, KI-E18) -> cheap haiku leftover-scan (pre-band deferral/tech-debt lint, KI-D12) -> the review stage (5 role gates + applicable BMAD review-named flows: code/adversarial/testreview + editorial) as separate adversarial subagents -> refuter -> scoped re-audit -> integrate. Worktree-isolated, model-routed, low-concurrency under throttle. Each agent writes its artifact to disk; the factory returns compact per-item results (a transition path) the driver folds into the ledger (single writer, resumable). NEVER runs mutating git — fixes stay on a factory/<id> branch in a worktree for the human to commit.',
  phases: [
    { title: 'Plan' }, { title: 'Test' }, { title: 'Fix' }, { title: 'Verify' },
    { title: 'EdgeScan' }, // KI-E12: the edge-case hunter runs EARLY (pre-band) for every code item; findings feed one bounded amend
    { title: 'Gates' }, { title: 'Refute' }, { title: 'Re-audit' }, { title: 'Integrate' },
    { title: 'Checkpoint' }, // KI-L48: result persistence for EVERY outcome (incl. FAILED) — its own group, never shown as 'Integrate'
  ],
}

// ---- inputs (emitted by driver.mjs `select`) ----
// KI-C1: prefer an inlined batch from a driver-emitted LAUNCHER script (the SCRIPT channel — 512KB,
// no ~2KB arg-size limit) over `args`. `args` stays valid for small batches / direct launches.
// The driver (cmdGroup) replaces the marker below with `const __FACTORY_BATCH__ = {...};` — placed
// AFTER `export const meta` so meta stays the FIRST statement (a Workflow hard requirement). As a
// plain comment it is inert, so factory.js still runs standalone via `args`.
/*__FACTORY_BATCH_INJECT__*/
const A = (typeof __FACTORY_BATCH__ !== 'undefined' && __FACTORY_BATCH__) ? __FACTORY_BATCH__ : ((typeof args === 'string') ? JSON.parse(args) : (args || {}))
const items = A.items || []
const TPLDIR = A.templatesDir || '_bmad-output/ai-factory/agents'  // subagents read their own role brief from here (keeps args small + briefs the source of truth)
const CFG = A.config || {}
const WT = A.worktree || null            // shared worktree { path, branch } for this batch (pilot mode)
const REPO = A.repoRoot || '.'
const CONC = A.concurrency || 2
const ATTEMPTS = A.attempts || 3
const DRY = !!A.dryRun

// ---- inlined pure helpers (byte-equivalent to _workflow/lib/pool.mjs — the runtime cannot import) ----
function makeLimiter(max) {
  let active = 0; const queue = []
  function pump() {
    while (active < max && queue.length > 0) {
      active++; const job = queue.shift()
      Promise.resolve().then(job.fn).then(
        function (v) { active--; job.resolve(v); pump() },
        function (e) { active--; job.reject(e); pump() })
    }
  }
  return function gate(fn) { return new Promise(function (resolve, reject) { queue.push({ fn: fn, resolve: resolve, reject: reject }); pump() }) }
}

const limit = makeLimiter(CONC)  // global agent-concurrency cap shared by ALL items + stages (Phase-4 parallel-safe)

// ---- inlined pure helper (byte-equivalent to _workflow/lib/acceptance.mjs — the runtime cannot import;
//      change both copies together, the selftest pins their parity) ----
function splitAcceptanceClauses(text, cap) {
  if (cap === undefined) cap = 8
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return []
  // Abbreviation guard: swap the abbreviation's ". " for ".\u0001" (a non-whitespace placeholder
  // the sentence-boundary lookbehind cannot match), restore after splitting.
  const marked = t.replace(/\b(e\.g|i\.e|etc|vs|cf)\.\s/gi, function (m) { return m.replace('. ', '.\u0001') })
  const rough = marked.split(/;\s*|(?<=[.!?])\s+(?=[A-Z0-9`"'(])/)
  const clauses = rough.map(function (c) { return c.replace(/\u0001/g, ' ').trim() }).filter(function (c) { return c.length >= 20 })
  if (clauses.length <= cap) return clauses
  return clauses.slice(0, cap - 1).concat(clauses.slice(cap - 1).join('; '))
}

// ---- schemas (compact structured returns; the full artifact is written to disk) ----
const FINDING = { type: 'object', additionalProperties: false, required: ['severity', 'title'], properties: { severity: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' }, fix: { type: 'string' } } }
const PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['rootCause', 'approach', 'recommendScopeStop', 'recommendEscalate'], properties: { rootCause: { type: 'string' }, approach: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, testStrategy: { type: 'string' }, blastRadius: { type: 'string' }, ruleRisks: { type: 'string' }, recommendEscalate: { type: 'boolean' }, recommendScopeStop: { type: 'boolean' } } }
// KI-L37: verificationOnly (reFix only) — the test-author attests every prior finding is already
// addressed in the CURRENT tree (or explicitly out of scope) and no NEW red is possible; the item
// skips the fixer and proceeds to verify + gates on the standing prior-round red proof.
const TEST_SCHEMA = { type: 'object', additionalProperties: false, required: ['red', 'note'], properties: { red: { type: 'boolean' }, verificationOnly: { type: 'boolean' }, testFiles: { type: 'array', items: { type: 'string' } }, runCmd: { type: 'string' }, evidence: { type: 'string' }, note: { type: 'string' } } }
const FIX_SCHEMA = { type: 'object', additionalProperties: false, required: ['applied', 'scopeStop', 'summary'], properties: { applied: { type: 'boolean' }, filesChanged: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, scopeStop: { type: 'boolean' }, divergence: { type: ['string', 'null'] }, note: { type: 'string' } } }
const STRARR = { type: 'array', items: { type: 'string' } }
// KI-L28: build/targetedTest are VERDICTS — the lifecycle gate tests /^pass/i on the RETURNED field.
// Two cycle-20 runners put the TEST NAME in targetedTest ("ServicesJsonServiceBMappingTests
// (all 5 ... pass)") while writing the correct verdict to verify.json on disk → both GREEN fixes
// false-failed pre-gates. The schema pattern makes the tool-call layer reject-and-retry instead.
const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['build', 'targetedTest', 'suite'], properties: { build: { type: 'string', pattern: '^(pass|fail)' }, targetedTest: { type: 'string', pattern: '^(pass|fail)' }, suite: { type: 'object', additionalProperties: true }, realInfraExercised: {}, realInfraKind: { type: 'string' }, dockerAbsent: { type: 'boolean' }, failingTests: STRARR, newFailures: STRARR, baselineFailures: STRARR, debris: STRARR, evidence: { type: 'string' }, note: { type: 'string' } } }
const GATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['gate', 'verdict', 'headline'], properties: { gate: { type: 'string' }, verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUIRED'] }, findings: { type: 'array', items: FINDING }, scopeViolation: { type: 'boolean' }, acceptanceMet: { type: 'boolean' }, redGreenConfirmed: { type: 'boolean' }, headline: { type: 'string' } } }
const REFUTE_SCHEMA = { type: 'object', additionalProperties: false, required: ['refuted', 'headline'], properties: { refuted: { type: 'boolean' }, severity: { type: 'string' }, attack: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } }, headline: { type: 'string' } } }
const REAUDIT_SCHEMA = { type: 'object', additionalProperties: false, required: ['converged', 'findingGone', 'headline'], properties: { converged: { type: 'boolean' }, findingGone: { type: 'boolean' }, newFindings: { type: 'array', items: FINDING }, headline: { type: 'string' } } }
const INTEG_SCHEMA = { type: 'object', additionalProperties: false, required: ['globalGreen', 'handoff'], properties: { globalGreen: { type: 'boolean' }, branch: { type: 'string' }, changedFiles: { type: 'array', items: { type: 'string' } }, regressionDelta: { type: 'number' }, handoff: { type: 'string' }, note: { type: 'string' } } }
// Adjudicator (KI-C8): the fable-5 tie-break for a DISPUTED CRITICAL/HIGH (split gate verdicts). UPHELD = the
// dissent was right (fix is defective -> back to fixer); OVERRULED = the dissent was wrong (proceed past gates).
const ADJUDICATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict', 'headline'], properties: { verdict: { type: 'string', enum: ['UPHELD', 'OVERRULED'] }, reasons: { type: 'array', items: { type: 'string' } }, headline: { type: 'string' } } }
// Decision-framer (KI-C9): frames an owner choice for a BLOCKED item (scope-stop / product-scope violation).
const DECISION_SCHEMA = { type: 'object', additionalProperties: false, required: ['decision', 'recommendation', 'headline'], properties: { decision: { type: 'string' }, options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { option: { type: 'string' }, consequence: { type: 'string' } } } }, recommendation: { type: 'string' }, headline: { type: 'string' } } }
// Checkpoint-writer (KI-L40): persists a finished item's full result object to state/items/<id>/result.json.
const CHECKPOINT_SCHEMA = { type: 'object', additionalProperties: false, required: ['written'], properties: { written: { type: 'boolean' }, note: { type: 'string' } } }
// Marker-probe (KI-E10): ONE disk-authoritative grep of verify-raw.txt for the FACTORY::REALINFRA:: marker.
// KI-L44 made the runner's RETURNED realInfraExercised field non-fatal in-run (it diverged from disk once);
// the probe reads the DISK (same file the fold greps) so a genuinely marker-less realInfra item fails fast
// BEFORE the expensive gate band instead of at fold (ITEM-C7B cycle 39 burned a full band this way).
const PROBE_SCHEMA = { type: 'object', additionalProperties: false, required: ['markerFound'], properties: { markerFound: { type: 'boolean' }, line: { type: 'string' } } }
// KI-D12 — LeftoverScan probe: a haiku agent runs the deterministic `build-test.sh leftovers` linter,
// then classifies each FACTORY::LEFTOVER-HIT candidate as a genuine fixer PUNT (incomplete work deferred —
// execution-policy.md §4) vs LEGIT (UI placeholder attr, a test asserting the behaviour, a
// constraint-explaining comment, prose). `clean=false` fails the item PRE-BAND (cheap, before the opus gates).
const LEFTOVER_SCHEMA = { type: 'object', additionalProperties: false, required: ['clean'], properties: { clean: { type: 'boolean' }, punts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'why'], properties: { file: { type: 'string' }, line: { type: 'string' }, why: { type: 'string' } } } } } }
// KI-E18 — AcceptanceScan probe: pre-band acceptance-clause coverage (the KI-D12 pattern applied to
// the #1 recent FAIL cause: 4/4 last band FAILs were acceptance-clause gaps the opus band found at
// full price). A haiku probe answers per deterministic clause "does the diff carry evidence?";
// gaps feed ONE bounded fixer amend; a malformed/unavailable probe never sinks the item.
const ACCEPT_SCHEMA = { type: 'object', additionalProperties: false, required: ['covered'], properties: { covered: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['clause', 'why'], properties: { clause: { type: 'string' }, why: { type: 'string' } } } } } }
// Sweep-designer: the canonical fix pattern for a whole root-cause cluster (designed once, applied N times).
const SWEEP_DESIGN_SCHEMA = { type: 'object', additionalProperties: false, required: ['pattern', 'headline'], properties: { pattern: { type: 'string' }, applicationNotes: { type: 'string' }, conformanceCheck: { type: 'string' }, headline: { type: 'string' } } }

// BMAD review-named skill -> the agent brief that encodes its methodology (agents/<role>.md).
const SKILL_ROLE = {
  'bmad-code-review': 'review-code',
  'bmad-review-adversarial-general': 'review-adversarial',
  'bmad-review-edge-case-hunter': 'review-edgecase',
  'bmad-testarch-test-review': 'review-testreview',
  'bmad-editorial-review-structure': 'review-editorial-structure',
  'bmad-editorial-review-prose': 'review-editorial-prose',
}

// ---- compact-args routing (Phase 4): mirrors config/model-routing.json. The Workflow runtime cannot
//      read files AND this session caps args size, so per-item run-args OMIT the verbose `routes`;
//      factory.js derives them here from fixType. item.routes, when present, still wins (Phase 2/3 compat). ----
const RT = {
  fixerMech: { model: 'claude-sonnet-5', effort: 'medium' }, fixerCrit: { model: 'claude-opus-4-8', effort: 'high' },
  testMech: { model: 'claude-sonnet-5', effort: 'medium' }, testCrit: { model: 'claude-opus-4-8', effort: 'high' },
  // KI-L64: runner pinned haiku→sonnet — haiku's 200k ceiling dies terminal ("Prompt is too long")
  // on big-solution verify runs (ITEM-H7 + ITEM-H5 cycle 35 burned ALL runner retries; ITEM-H-14
  // survived on retry luck). Same KI-L56 context-ceiling class + KI-L58 pin precedent.
  // KI-D11 (2026-07-19): fable-5 EXPERIMENT — planner + adjudicator route fable-5 (top-capability) with an
  // opus fallback (KI-D10). fable-5 access re-verified working in this env 2026-07-19 (FABLE-PROBE-OK),
  // reversing the KI-C8 access-gate. planner sets each non-trivial item's whole approach; adjudicator makes
  // the hardest call in the factory (a disputed FULL-band split). The opus fallback means a fable outage
  // (credit/access — the KI-L49 class) degrades to the prior opus routing, never sinks the item.
  planner: { model: 'claude-fable-5', effort: 'high', fallback: { model: 'claude-opus-4-8', effort: 'high' } }, runner: { model: 'claude-sonnet-5', effort: 'low' },
  gArch: { model: 'claude-opus-4-8', effort: 'high' }, gDev: { model: 'claude-sonnet-5', effort: 'medium' },
  gQa: { model: 'claude-sonnet-5', effort: 'medium' }, gSec: { model: 'claude-opus-4-8', effort: 'high' }, gPo: { model: 'claude-opus-4-8', effort: 'medium' },
  rCode: { model: 'claude-opus-4-8', effort: 'high' }, rAdv: { model: 'claude-opus-4-8', effort: 'high' },
  rEdge: { model: 'claude-sonnet-5', effort: 'medium' }, rTest: { model: 'claude-sonnet-5', effort: 'medium' },
  refuter: { model: 'claude-opus-4-8', effort: 'high' }, reauditor: { model: 'claude-sonnet-5', effort: 'medium' }, integrator: { model: 'claude-sonnet-5', effort: 'medium' }, // KI-L49: reauditor was model:null (inherit session model) — that inherited Fable 5 and DIED on credit-exhaustion (ITEM-C3 cycle 31) while every explicitly-routed stage still had credits; pinned to sonnet so no stage depends on the session model's credit pool. Also gives model diversity vs the opus refuter (the other independent adversarial pass).
  adjudicator: { model: 'claude-fable-5', effort: 'max', fallback: { model: 'claude-opus-4-8', effort: 'max' } }, decisionFramer: { model: 'claude-opus-4-8', effort: 'medium' }, // KI-D11 — adjudicator routed fable-5/max + opus/max fallback (fable access re-verified 2026-07-19, reversing KI-C8's cycle-6 access-gate; opus fallback preserves the prior behaviour on a fable outage)
}
// KI-B1 (closed 2026-07-12): the driver injects `routing: {RT, FLOW_RT}` into the batch, BUILT from
// config/model-routing.json at emit time via lib/routing-drift.mjs buildFactoryRouting (the same
// mapping the drift guard checks) — so the CONFIG is authoritative on every emitted run, and the
// inline tables above/below are the drift-guarded FALLBACK (legacy args launches, hand runs, older
// emitted scripts). Overlay BEFORE the FLOW_RT literal so its RT.* references see the injected routes.
if (A && A.routing && A.routing.RT) Object.assign(RT, A.routing.RT)
const FLOW_RT = { 'review.code': RT.rCode, 'review.adversarial': RT.rAdv, 'review.edgecase': RT.rEdge, 'review.testreview': RT.rTest,
  // KI-L58: editorial_prose pinned haiku→sonnet — haiku's 200k ceiling dies terminal ("Prompt is
  // too long") on doc-heavy items (ITEM-H9 cycle 33: runbook + dashboard JSON), the KI-L56
  // context-ceiling class at a review call site. Same pin precedent as the KI-L49 re-auditor.
  'review.editorial_structure': { model: 'claude-sonnet-5', effort: 'low' }, 'review.editorial_prose': { model: 'claude-sonnet-5', effort: 'low' } }
if (A && A.routing && A.routing.FLOW_RT) Object.assign(FLOW_RT, A.routing.FLOW_RT) // KI-B1 (see above)
// Derive the applicable BMAD review-flows from files[] when compact args omit item.reviewFlows (Phase-4).
// Kept in AGREEMENT with the driver's applicableReviewFlows: BOTH always run code(if code)+adversarial+
// test-review; the edge-case hunter runs for EVERY code item (KI-E12 — owner directive 2026-07-19; it
// executes EARLY, pre-band, see the EdgeScan stage in runItem); editorial on doc files.
// (item.reviewFlows from the verbose `select` path, when present, wins — it is already the same set.)
function flowsFor(item) {
  if (item.reviewFlows && item.reviewFlows.length) return item.reviewFlows
  const files = item.files || []
  const isDoc = function (f) { return /\.md$/i.test(f) || /(^|\/)docs?\//i.test(f) }
  const code = files.some(function (f) { return !isDoc(f) }), doc = files.some(isDoc)
  const out = []
  if (code) out.push({ skill: 'bmad-code-review', routeKey: 'review.code', band: 'method', blocking: true })
  out.push({ skill: 'bmad-review-adversarial-general', routeKey: 'review.adversarial', band: 'method', blocking: true })
  if (code) out.push({ skill: 'bmad-review-edge-case-hunter', routeKey: 'review.edgecase', band: 'method', blocking: true }) // KI-E12: every code item — the lens is 3/3 adjudicator-upheld (cycles 39-41); doc-only items have no execution paths to hunt
  out.push({ skill: 'bmad-testarch-test-review', routeKey: 'review.testreview', band: 'method', blocking: true }) // red->green test-quality gate runs for EVERY item
  if (doc) out.push({ skill: 'bmad-editorial-review-structure', routeKey: 'review.editorial_structure', band: 'editorial', blocking: false }, { skill: 'bmad-editorial-review-prose', routeKey: 'review.editorial_prose', band: 'editorial', blocking: false })
  return out
}
function routesFor(item) {
  const crit = item.fixType !== 'mechanical'
  const flows = {}
  for (const f of flowsFor(item)) flows[f.routeKey] = FLOW_RT[f.routeKey] || RT.rAdv
  return {
    planner: crit ? RT.planner : null, testAuthor: crit ? RT.testCrit : RT.testMech, fixer: crit ? RT.fixerCrit : RT.fixerMech,
    runner: RT.runner, gates: { architect: RT.gArch, developer: RT.gDev, qa: RT.gQa, security: RT.gSec, po: RT.gPo },
    refuter: RT.refuter, reauditor: RT.reauditor, integrator: RT.integrator, adjudicator: RT.adjudicator, decisionFramer: RT.decisionFramer, reviewFlows: flows,
  }
}

// KI-C10 — re-audit lens set (scoped audit-wave reuse): always the 'code' lens, plus the theme-relevant
// lens(es), plus 'architecture' for CRITICAL. Each lens runs as a separate scoped subagent; converged
// only if ALL agree the finding is gone and none found a new CRITICAL/HIGH.
function reauditLenses(item) {
  const t = (item.theme || '').toLowerCase()
  const out = ['code']
  if (/security|auth|crypto|multitenan|token|secret/.test(t)) out.push('security')
  if (/concurren|idempoten|race|dataflow|money|payment|financ/.test(t)) out.push('edge-case')
  if (/architect|layer|design|cross-service|contract/.test(t)) out.push('architecture')
  if (item.severity === 'CRITICAL' && out.indexOf('architecture') < 0) out.push('architecture')
  return out.filter(function (v, i) { return out.indexOf(v) === i })
}

// LIGHT vs FULL review band — the cost lever (root-cause triage). The long tail (doc-drift + mechanical,
// non-CRITICAL) runs a LEAN band: developer+qa gates + code/adversarial/testreview reviews ALL on sonnet,
// single-lens re-audit, NO opus role-gate panel (architect/security/po), NO adjudicator — ~4x cheaper.
// FULL (CRITICAL security/money/concurrency/idempotency) keeps the rigorous opus band. The driver's triage
// (cluster.mjs) can set item.band explicitly; otherwise it is derived here.
// P5 (gate rigor): these themes ALWAYS get the FULL opus gate panel (never LIGHT — a "mechanical" HIGH here
// must not strip the architect/security gates). Matches cluster.mjs FULL_THEMES (+ the dead-but-forward-compat
// `concurrency`, which folds into idempotency-dataflow in the live graph).
const BAND_FULL_THEMES = ['security-multitenancy', 'money-correctness', 'idempotency-dataflow', 'concurrency']
// P2 (machine container proof) — the real-infra floor fires ONLY when the DEFECT SHAPE depends on real-DB
// semantics the EF in-memory provider does NOT replicate: concurrency / transactions / isolation / locking,
// raw SQL / provider functions, unique-or-check constraint enforcement, provider-specific decimal/collation.
// A pure query-LOGIC bug (wrong filter, hardcoded placeholder, GroupBy/Count/Sum) runs IDENTICALLY on both
// providers, so an in-memory test genuinely proves it — Testcontainers would add latency and nothing else.
// (ITEM-C5 witness, 2026-06-27: a blanket money/idempotency/concurrency-THEME floor wrongly FAILED a
// hardcoded-zeros aggregate fix whose correctness is fully in-memory-expressible.) The normalizer's per-item
// `item.realInfra` stays the PRIMARY signal; this keyword floor is the safety net for a MIS-TRIAGED item whose
// own text betrays a real-infra need the normalizer missed (the ITEM-M1/M20 case P2 was created for).
const REALINFRA_SIGNAL = /concurren|race condition|\brace\b|lost update|toctou|isolation level|serializable|deadlock|advisory lock|unique (constraint|index)|23505|fromsql|raw sql|rowversion|optimistic concurren|pessimistic|\bfor update\b|interleav|double-?spend|idempoten.*(dup|race|concurrent)/
const SONNET = { model: 'claude-sonnet-5', effort: 'medium' }
function bandFor(item) {
  if (item.band === 'LIGHT' || item.band === 'FULL') return item.band
  // THEME DOMINATES fixType/severity (review P5): a security / money / concurrency / idempotency item ALWAYS
  // gets the full rigorous band (security + architect gates, multi-lens re-audit, adjudicator) — a "mechanical"
  // authz / HMAC / tenant-filter edit is still a security change whose load-bearing reviewer must NOT be dropped.
  if (BAND_FULL_THEMES.indexOf(item.theme) >= 0) return 'FULL'
  if (item.theme === 'doc-drift' || item.fixType === 'mechanical') return 'LIGHT'
  return 'LIGHT'
}

// ---- prompt composition: shared context + role brief (read by the agent) + item + worktree ----
// Factory home + per-item artifacts dir, ABSOLUTE (KI-L33). `verify/build-test.sh` and
// `state/items/<id>/` live under _bmad-output/ai-factory/, NOT the repo root — a relative
// "verify/build-test.sh from the REPO ROOT" is file-not-found, and an agent that hits that
// improvises (cycle-20: marker-less bash greps → the deterministic fold rightly killed the item).
// One absolute line in every prompt removes the entire path-ambiguity class.
const FDIR = REPO + '/' + String(TPLDIR || '_bmad-output/ai-factory/agents').replace(/\/agents\/?$/, '')
function itemsDir(id) { return FDIR + '/state/items/' + id }

function compose(role, item, extra) {
  const wtPath = (item.worktree && item.worktree.path) || (WT && WT.path) || (item.ledger && item.ledger.worktree) || REPO  // per-item worktree (Phase-4 isolation) wins, then batch worktree (pilot)
  const lines = [
    'TARGET: ' + item.target + '   WORK ITEM: ' + item.id + '  (' + item.severity + ' / ' + item.fixType + ' / ' + item.autonomyTier + ')',
    'WORKTREE (do ALL file reads/edits/builds inside this isolated git worktree; NEVER run git commit/add/checkout/restore/stash/reset/clean): ' + wtPath,
    'REPO ROOT (read-only reference): ' + REPO,
    'ARTIFACTS DIR (absolute — write ALL your state/items artifacts EXACTLY here, and read prior-attempt feedback from here): ' + itemsDir(item.id),
    'VERIFY SCRIPT (absolute — the ONLY sanctioned build/test entrypoint): bash ' + FDIR + '/verify/build-test.sh',
    '',
    'WORK-ITEM SPEC:',
    '  title: ' + item.title,
    '  theme: ' + item.theme + '   realInfra: ' + (!!item.realInfra),
    '  files (expected touch-set / lock set): ' + (item.files || []).join(', '),
    '  acceptance: ' + item.acceptance,
    '  regression-test-to-add: ' + item.regressionTest,
    '  fix-hint: ' + (item.fixHint || '(none)'),
    '  source: ' + item.source,
  ]
  // Cache-strategic doc index (2026-07-18): the driver ships a section map (headings + line
  // numbers) of the target's reference docs (data-flows / CONTEXT / AGENTS) in the SHARED
  // per-item prefix — agents Read ONLY the sections their role needs via offset/limit, never
  // whole 500-1000-line docs (repeated whole-doc reads across ~15 band agents were a top
  // token sink in the cycle-39/40 telemetry).
  if (Array.isArray(item.docMap) && item.docMap.length) {
    lines.push('', 'DOC MAP (section index of this target\'s reference docs — Read targeted sections via offset/limit at the @L line numbers; do NOT read these docs whole):')
    for (const d of item.docMap) lines.push('  ' + d)
  }
  // Similarity batch (owner directive 2026-07-04): the driver stamps batchPattern when the whole
  // batch is ONE similarity cluster — siblings apply the SAME class of change to their own targets.
  // Uniform diffs converge gates faster and give the user one review shape instead of N novel ones.
  if (item.batchPattern) {
    lines.push('', 'BATCH PATTERN — SIMILARITY BATCH: ' + item.batchPattern,
      '  Every sibling item in this batch applies the SAME class of change to its own target. Make YOUR change structurally IDENTICAL in shape to that shared pattern — same approach, same naming, same comment style, same test structure — minimally adapted to this target. Do NOT invent a novel approach where the shared pattern fits. If THIS target genuinely requires deviating from the pattern, deviate correctly and state exactly why in your result note.')
  }
  // KI-L32 — peer surface ownership: a fixer following gate findings must not silently redo a batch
  // sibling's work in ITS worktree (cycle-20: the ITEM-C-DEPLOY fixer re-delivered the split-out
  // services.json fix, duplicating ITEM-H-SERVICES-JSON's whole worktree).
  if (Array.isArray(item.peers) && item.peers.length) {
    lines.push('', 'PEER-OWNED SURFACES (sibling items in THIS batch own these files — do NOT modify them; if your fix genuinely requires one, STOP for that file and say so in your result note instead):')
    for (const p of item.peers) lines.push('  - ' + p.id + ': ' + (p.files || []).join(', '))
  }
  // GUARDRAILS — global-stable content stays in the SHARED prefix; every role-conditional block
  // moves BELOW it (cache-strategic order, 2026-07-18: all agents of one item share a single
  // identical prompt prefix through here, diverging only at the role tail).
  lines.push(
    '',
    'GUARDRAILS (.claude/rules/*.md are the acceptance criteria):',
    '  - Honour code-style / service-design / dataflow / security / trust-and-monetisation / deploy-verification.',
    '  - The FULL .claude/rules/*.md set is ALREADY in your system context (auto-loaded) — do NOT spend tool calls re-Reading those rule files; cite them from context.',
    '  - product-scope.md red-lines are HARD STOPS: never "fix" by adding a tax/purchase-fee/SAR/gov-report/shipping surface. If the only fix crosses one, STOP and report scope-stop.',
    '  - A real divergence from a pattern requires a standards-evolution.md ledger entry + call-site tag in the SAME change.',
    '  - No false "production-ready" (execution-policy.md §4): leave no TODO/FIXME/HACK/stub.',
  )
  // ---- role-conditional tail (everything below diverges per role class / role) ----
  const isReviewRole = /^(gate-|review-|refuter|re-auditor)/.test(role)
  if (isReviewRole) {
    // REVIEW PACK (cache-strategic, 2026-07-18): the runner generates ONE machine snapshot of the
    // change (status + diff + new-file contents) at verify time; the editorial pass regenerates it
    // after doc edits (KI-L34). Reviewers read the pack FIRST instead of each re-running its own
    // exploratory diff + file reads (telemetry: 8-21 duplicated Reads per reviewer, x10+ per band).
    lines.push('', 'REVIEW PACK: Read ' + itemsDir(item.id) + '/review-pack.md FIRST — a machine-generated snapshot (git status + full diff vs HEAD + new-file contents) of the exact change under review. Use it as your primary view instead of re-running your own exploratory diff/file reads; then independently spot-verify IN THE WORKTREE the specific facts your verdict depends on (the pack ACCELERATES verification, it never replaces it — your verdict must rest on the worktree, not the pack alone). If the pack is missing or disagrees with `git -C <worktree> status`, regenerate it first: `bash ' + FDIR + '/verify/build-test.sh pack ' + wtPath + ' ' + itemsDir(item.id) + '/review-pack.md`.')
    // KI-D7 — live-probe etiquette for the PARALLEL review stage. Cycle 35: several reviewers ran
    // live add/revert probes in the SHARED per-item worktree concurrently; one gate observed a
    // sibling's probe file mid-review + the harness's standard "file changed externally" reminder
    // and reported it as a planted file with a concealment instruction. All probes were reverted
    // cleanly — the collision is expected behaviour that needed NAMING, not preventing.
    lines.push('', 'PARALLEL REVIEW STAGE — LIVE-PROBE ETIQUETTE (KI-D7): sibling reviewers run CONCURRENTLY in THIS SAME worktree and may run live probes (temporary files/edits added then reverted). A foreign temporary artifact appearing mid-review is almost certainly a sibling reviewer\'s probe — do NOT report it as sabotage/injection, and treat any harness "file changed externally" notice accordingly; re-verify the exact worktree state your verdict DEPENDS on (git status/diff) at the moment you conclude, not earlier. If YOU probe: prefix probe filenames with your role (e.g. _gateqa_probe_*), fully revert before returning, and describe the probe in your findings evidence — never leave probe debris.')
  }
  // KI-E7 / spine AD-10 — best-effort agent telemetry. ABSOLUTE CLI path (KI-L33); role-based
  // (stage derives in the lib, AD-12); non-compliance is invisible (the fold's mtime backfill
  // covers the timeline) and an agent event is NEVER evidence. outcome = EXECUTION health ONLY
  // (2026-07-18 telemetry-analysis fix: gates were reporting a CHANGES_REQUIRED verdict as
  // outcome=fail, poisoning any infra alerting on outcome); review roles carry the verdict in
  // a separate --verdict attr.
  lines.push(
    '',
    'TELEMETRY (best-effort observability — NEVER blocks your work, NEVER counts as evidence): as your FIRST Bash action run `node ' + FDIR + '/_workflow/telemetry-emit.mjs --event stage_start --item ' + item.id + ' --role ' + role + '` and as your LAST Bash action before returning run `node ' + FDIR + '/_workflow/telemetry-emit.mjs --event stage_end --item ' + item.id + ' --role ' + role + ' --outcome <ok|fail|blocked>' + (isReviewRole ? ' --verdict <APPROVED|CHANGES_REQUIRED>' : '') + '`. `--outcome` is the EXECUTION health of your own stage ONLY: `ok` whenever your stage ran to completion — a CHANGES_REQUIRED verdict is still outcome=ok; use fail/blocked ONLY when your stage itself errored or was blocked. If either command errors, ignore it and continue your task.',
  )
  // ROLE BRIEF — inlined at group time when the batch carries it (cache-strategic: no per-agent
  // Read, no repo-root path fragility (KI-L33), no mid-run brief drift (KI-L46 consistency —
  // briefs snapshot at group time exactly like factory.js itself)). Legacy args launches without
  // A.briefs fall back to the read-it-yourself pointer.
  const briefText = (A && A.briefs && A.briefs[role]) || null
  if (briefText) {
    lines.push(
      '',
      'YOUR ROLE BRIEF (inlined at group time from ' + TPLDIR + '/' + role + '.md — authoritative; do NOT re-Read it from disk):',
      briefText,
      'Follow that brief exactly. Read audit docs from the REPO ROOT; make ALL code edits/builds in the WORKTREE.',
    )
  } else if (!/-probe$/.test(role)) {
    // KI-E18: *-probe roles (marker/leftover/acceptance) are self-contained one-command agents with
    // NO agents/<role>.md brief on disk — a dangling read pointer only wastes a tool call on a
    // file-not-found. Non-probe roles keep the read-it-yourself fallback.
    lines.push(
      '',
      'YOUR ROLE BRIEF — read it NOW from the REPO ROOT (it is NOT in the worktree, which is a clean checkout of committed code): ' + REPO + '/' + TPLDIR + '/' + role + '.md',
      'Follow that brief exactly. Read briefs + audit docs from the REPO ROOT; make ALL code edits/builds in the WORKTREE.',
    )
  }
  if (extra) lines.push('', extra)
  return lines.join('\n')
}

function planFor(item) {
  const r = item.routes || routesFor(item); const g = r.gates || {}
  return {
    id: item.id, severity: item.severity, fixType: item.fixType, autonomyTier: item.autonomyTier, band: bandFor(item),
    stages: {
      planner: r.planner ? (r.planner.model + '/' + r.planner.effort) : '(skip)',
      testAuthor: r.testAuthor ? (r.testAuthor.model + '/' + r.testAuthor.effort) : '?',
      fixer: r.fixer ? (r.fixer.model + '/' + r.fixer.effort) : '?',
      gates: Object.keys(g).map(function (k) { return k + ':' + (g[k] ? (g[k].model || 'inherit') : '?') }).join(' '),
      refuter: r.refuter ? (r.refuter.model + '/' + r.refuter.effort) : '?',
    },
  }
}

async function tryAgent(prompt, opts) {
  let lastErr = null
  for (let a = 0; a < ATTEMPTS; a++) {
    try {
      const r = await limit(function () { return agent(prompt, opts) })  // every agent routes through the global concurrency cap (Phase-4 parallel-items safe)
      if (r) return r
    } catch (e) {
      // KI-D9 (2026-07-19): agent() THROWS on a StructuredOutput retry-cap-exceeded (or a terminal API
      // error after its own retries) rather than returning null. An uncaught throw here killed the whole
      // item with "runItem threw" (ITEM-M-DPOP-RETRY-JTI cycle-42 first run) — bypassing the KI-L53
      // infraSuspect treatment (attempt-not-counted, capped at maxInfraRetries) that every OTHER null
      // stage-agent death already gets. Contain it: treat a throw exactly like a null return — retry, then
      // fall through to null so the caller's `if (!r) { res.infraSuspect = true; ... }` path applies.
      lastErr = e
      log('[throw] ' + (opts.label || '?') + ' attempt ' + (a + 1) + '/' + ATTEMPTS + ': ' + String((e && e.message) || e).slice(0, 160))
    }
    log('[retry] ' + (opts.label || '?') + ' attempt ' + (a + 1) + '/' + ATTEMPTS)
  }
  if (lastErr) log('[unavailable] ' + (opts.label || '?') + ' null after ' + ATTEMPTS + ' attempt(s) — last throw: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 160))
  return null
}

// ---- the lifecycle for one item (sequential within its worktree; gates run pooled) ----
async function runItem(item) {
  const id = item.id
  const R = item.routes || routesFor(item)
  const band = bandFor(item) // LIGHT | FULL — decided up front (drives the verify mode AND the gate band)
  const filesHaveCs = (item.files || []).some(function (f) { return /\.cs$/.test(f) })
  // P2 real-infra FLOOR — `realInfraLikely` is known early (it drives the test-author: write a Testcontainers
  // test when the normalizer flagged it OR the defect text betrays a real-DB-dependent shape). The binding
  // `needsRealInfra` (= realInfraLikely ∧ codeChange) is finalised at the verify stage.
  const realInfraText = ((item.title || '') + ' ' + (item.acceptance || '') + ' ' + (item.regressionTest || '') + ' ' + (item.fixHint || '')).toLowerCase()
  // KI-L39 — pure-coverage exemption: a `theme=test-coverage` item explicitly triaged realInfra=false
  // names in its acceptance/regressionTest text the guards the NEW TEST must cover ("Processing-race
  // guard", "idempotency duplicate-delivery early-return") — that text is the SUBJECT of the coverage,
  // not a defect shape needing a real DB (the code under test is already correct; the deliverable is
  // the test). The keyword floor stays intact for every other theme AND for a coverage item the
  // normalizer flagged realInfra=true. (ITEM-C7 witness, 2026-07-02: the text floor + P9
  // deterministically false-failed the whole class.)
  const pureCoverage = item.theme === 'test-coverage' && !item.realInfra
  const realInfraLikely = !!item.realInfra || (!pureCoverage && REALINFRA_SIGNAL.test(realInfraText))
  const wtPath = (item.worktree && item.worktree.path) || (WT && WT.path) || (item.ledger && item.ledger.worktree)
  // KI-C2 (closed 2026-07-12) — budget-governed batch, owner-shaped: there is NO default cap (owner
  // ruling 2026-06-27: observability, not a governor). Enforcement engages ONLY when the operator set
  // a token budget on the LAUNCH TURN — the runtime `budget` global then hard-throws once
  // spent >= total. This is the GRACEFUL half: refuse to START an item when remaining() is already
  // inside the reserve, so in-flight items keep the headroom to finish + checkpoint instead of dying
  // mid-band. The skipped item returns an id-less CLAIMED no-op (attempt NOT burned, NOT checkpointed
  // — `reconstruct` ignores it and `resume` prints its relaunch line).
  const BUDGET_RESERVE = (A.budget && A.budget.reserve) || 50000
  if (budget && budget.total && budget.remaining() < BUDGET_RESERVE) {
    return { id: id, attemptsDelta: 0, transitions: [], toState: 'CLAIMED', artifacts: {}, gates: {}, cost: {}, worktree: wtPath, branch: (item.worktree && item.worktree.branch) || (WT && WT.branch), budgetStopped: true, note: 'BUDGET-STOPPED before start: remaining ' + budget.remaining() + ' tokens < reserve ' + BUDGET_RESERVE + ' — item NOT attempted (still CLAIMED, no attempt burned; relaunch or re-group it next cycle)' }
  }
  const res = { id: id, resultId: id + '#' + (A.cycle || 0), attemptsDelta: 1, transitions: [], toState: 'FAILED', band: band, artifacts: {}, gates: {}, cost: {}, worktree: wtPath, branch: (item.worktree && item.worktree.branch) || (WT && WT.branch), note: '' } // attemptsDelta:1 — every run counts one attempt so the maxItemRetries bound fires; resultId = id#cycle for fold idempotency (KI-B4); band rides for the fold's telemetry stamp + KI-E19 manifest rule (KI-E23)
  const cost = function (route) { const m = (route && route.model) || 'inherit'; res.cost[m] = (res.cost[m] || 0) + 1 }
  // Shared command constants (hoisted 2026-07-19 so the fixer/editorial claims self-check can cite them).
  const BT = 'bash ' + FDIR + '/verify/build-test.sh'
  const RAW = itemsDir(id) + '/verify-raw.txt'
  const PACKCMD = BT + ' pack ' + wtPath + ' ' + itemsDir(id) + '/review-pack.md'
  // KI-E11 — deterministic phantom-path self-check, moved EARLY (fix/editorial time) from the fold-time
  // F2 WARN (cycle-39 ITEM-HI-11: fabricated `Api/Controllers/Support/` + a phantom consumer claim cost a
  // full FAILED review round). The fixer runs it BEFORE handing off; the fold's F2 WARN stays the backstop.
  const docTouch = (item.files || []).some(function (f) { return /\.md$/i.test(f) || /(^|\/)docs?\//i.test(f) })
  const claimsHint = ' DOC-CLAIM SELF-CHECK (KI-E11): if your change ADDS or EDITS any .md prose, run `' + BT + ' claims ' + wtPath + '` as one of your LAST actions — every FACTORY::CLAIMS-MISS line is a path your prose asserts but the tree does NOT contain (the fabricated-path class that fails adversarial review). Fix the prose (or the path) until it reports FACTORY::CLAIMS::0; a claim that is INTENTIONALLY a future/external path must be reworded so it does not read as an existing tree path.'
  async function call(role, route, schema, extra, phaseName) {
    const opts = { label: id + ':' + role, phase: phaseName }
    if (schema) opts.schema = schema
    if (route && route.model) opts.model = route.model
    if (route && route.effort) opts.effort = route.effort
    let r = await tryAgent(compose(role, item, extra), opts)
    if (r) { cost(route); return r }
    // KI-D10 (2026-07-19): a route MAY carry `fallback: {model, effort}`. When the primary model is null
    // after ATTEMPTS (access-gated / credit-exhausted / persistently malformed output), fall back ONCE to
    // the secondary model instead of failing the whole item on a single model's availability. Motivated by
    // the fable-5 experiment: fable-5 is top-capability but access/budget-gated (the KI-L49 credit-death
    // precedent), so the adjudicator + planner route fable-5 with an opus fallback — a fable outage degrades
    // to the prior opus routing, never sinks the item. The fallback attempt's cost is attributed to the
    // fallback route (accurate telemetry). A null AFTER the fallback still returns null -> infraSuspect path.
    if (route && route.fallback && route.fallback.model) {
      const fb = { label: id + ':' + role, phase: phaseName }
      if (schema) fb.schema = schema
      fb.model = route.fallback.model
      if (route.fallback.effort) fb.effort = route.fallback.effort
      log('[fallback] ' + id + ':' + role + ' ' + (route.model || '?') + ' -> ' + route.fallback.model)
      r = await tryAgent(compose(role, item, extra), fb)
      if (r) { cost(route.fallback); return r }
    }
    return r
  }
  const finish = function (state, note) { res.transitions.push(state); res.toState = state; res.note = note; return res }
  if (!wtPath) return finish('FAILED', 'no worktree assigned — refusing to run against the main checkout (isolation invariant, PLAN §6)')
  // KI-C9 — frame an owner decision for a BLOCKED (scope-stop) item, then block. The full framing (options +
  // consequences + recommendation) lands in decision.md for the human queue; the note carries the headline.
  const frameAndBlock = async function (reason) {
    const fr = await call('decision-framer', R.decisionFramer, DECISION_SCHEMA, 'This item is BLOCKED (cannot be auto-resolved without an owner ruling): ' + reason + '. Frame the decision for the human queue: the specific question, 2-4 options each with its consequence, and a recommendation. WRITE state/items/' + id + '/decision.md.', 'Plan')
    res.artifacts.decision = 'state/items/' + id + '/decision.md'
    return finish('BLOCKED', (fr && fr.headline) ? fr.headline : reason)
  }
  // Phase-6 re-fix convergence: when re-running a previously-FAILED item, feed the prior gate/review feedback
  // to the test-author + fixer so the re-attempt COMPLETES the fix instead of repeating the same omission
  // (cycle-6 learning: ITEM-FIND-H10 did half the finding; without the feedback a re-fix loops to the bound).
  const reFixNote = item.reFix ? ('RE-FIX — a PRIOR attempt FAILED. FIRST read the prior feedback at ' + itemsDir(id) + '/ in THIS order: (1) feedback.md if present — the AUTHORITATIVE driver-written digest of the prior attempt\'s returned verdicts + findings (KI-L31; when any other file disagrees with it, feedback.md wins), (2) last-failure.md (the exact fail reason, incl. test/verify/fold-stage fails where NO gate ran, and any STALE-artifact warnings), (3) gate-*.md + review-*.md + adjudication.md for full prose — but treat any file last-failure.md flags as STALE as the PRIOR attempt\'s content, not current feedback. The prior fix is ALREADY in this worktree but was INCOMPLETE/WRONG/rejected — CORRECT it (do not just repeat it). ') : ''

  // 1. plan (non-trivial / escalate only)
  phase('Plan')
  if (R.planner) {
    const plan = await call('planner', R.planner, PLAN_SCHEMA, null, 'Plan')
    res.artifacts.plan = 'state/items/' + id + '/plan.md'
    if (plan && plan.recommendScopeStop) return await frameAndBlock('planner scope-stop — ' + (plan.ruleRisks || plan.approach || ''))
    if (plan && plan.recommendEscalate) item._escalate = true
  }

  // 2. test-author -> RED
  phase('Test')
  // P1: the RED proof must be MACHINE-observed, not self-reported. The test-author runs the new test against the
  // CURRENT (unfixed) worktree and tees the output to verify-red-raw.txt with a `FACTORY::RED::<exitcode>` marker;
  // the driver re-greps it to prove the test is non-vacuous (genuinely fails on old code). A vacuous test that
  // passes on both old AND new code is the silent way a bad fix sails through — this closes it.
  const redHint = 'RED PROOF (mandatory): after writing the regression test, RUN it against the CURRENT unfixed worktree and TEE the raw output to ' + itemsDir(id) + '/verify-red-raw.txt (ABSOLUTE path — never a relative state/items/...). A .cs test MUST fail now (compile-or-assert red, non-zero exit); a grep/script assertion MUST show the defect present. Emit a marker line `FACTORY::RED::<exitcode>` into that file (non-zero for a .cs test). The driver re-greps it — a self-reported red=true without a failing transcript does NOT advance the item.'
  // P2: if the defect shape is real-DB-dependent (normalizer flag OR a concurrency/raw-SQL/constraint keyword),
  // the test MUST be Testcontainers-backed (an in-memory green will be REJECTED at fold). If it is a pure
  // query-LOGIC bug, an in-memory test is correct — do NOT force a container where the provider behaves identically.
  const testRealInfraHint = realInfraLikely ? ' REAL-INFRA: this finding is real-DB-dependent — write a Testcontainers (real Postgres/Redis) regression test, NOT EF in-memory, and print `FACTORY::REALINFRA::<kind>` from the test once the container is up (the in-memory provider does not replicate the defect, so a green there would be rejected at fold).' : ''
  // KI-L55 — the two HONEST no-red shapes exist on the FIRST round too (cycle-32 live evidence:
  // ITEM-H8 stale finding, ITEM-HIGH-17 pure coverage — both punished with FAILED for
  // reporting truthfully). Brief them explicitly; the fold requires the SAME transcript either way.
  const testVoHint = item.reFix ? '' : (pureCoverage
    ? ' PURE TEST-COVERAGE ITEM: the deliverable IS the new tests — correct production code has no red state, so do NOT fabricate a failing variant. Write the missing tests (they should PASS against the current code), RUN them, tee the raw output + a `FACTORY::RED::<exitcode>` marker (0 expected) to the SAME verify-red-raw.txt path, and return red=false + verificationOnly=true with the coverage delta (targets covered, test counts) in evidence.'
    : ' STALE-FINDING PROTOCOL: if you determine the finding is ALREADY RESOLVED on the current tree (the acceptance criterion demonstrably holds — trace the actual wiring, do not stop at the cited lines), do NOT fabricate a red. Write a PASSING pinning test that empirically proves the acceptance holds, RUN it, tee the raw output + `FACTORY::RED::0` to verify-red-raw.txt, and return red=false + verificationOnly=true with file:line + provenance evidence in note. The full gate band adjudicates the claim — a wrong stale-claim will be CHANGES_REQUIRED\'d.')
  const test = await call('test-author', R.testAuthor, TEST_SCHEMA, (item.reFix ? (reFixNote + 'Write the red proof for what is STILL broken per that feedback — do NOT duplicate an already-passing test; the proof MUST fail on the current worktree state. If NOTHING is still broken (you re-verified every prior finding against the CURRENT tree and each is fixed with an already-passing pinning test, or explicitly out of scope), return red=false + verificationOnly=true and document the full re-verification (files read, suites run, counts) in evidence/note — do NOT invent a vacuous duplicate test just to produce a red. ') : '') + redHint + testVoHint + testRealInfraHint, 'Test')
  res.artifacts.test = 'state/items/' + id + '/test.json'
  // KI-L53: a null stage agent (retries exhausted / skipped) is an INFRA failure, not a quality
  // verdict — mark infraSuspect so the fold's auto-infra-retry does not burn the item's attempt.
  if (!test) { res.infraSuspect = true; return finish('FAILED', 'test-author agent UNAVAILABLE (null after retries — possible infra/credit failure, NOT a quality verdict)') }
  // KI-L37 — verification-only reFix: a PRE-APPLIED reFix (operator or prior round already landed the
  // fix + its tests) has, by definition, nothing NEW to red-prove — the defect's red proof was
  // produced in an earlier round and lives in verify-red-raw.txt (the fold's P1 re-greps that file,
  // whatever attempt produced it). Forcing a fresh red here made the cycle-24 C-DEPLOY regate FAIL
  // despite a 300/300-verified worktree. When the test-author attests verificationOnly on a reFix,
  // skip the fixer (nothing to change) and go straight to the independent verify + full gate band —
  // the gates, refuter, and re-audit still adjudicate the diff on their own evidence.
  // KI-L55: verificationOnly is legal on ANY round (was reFix-only). The trust model is unchanged —
  // the claim is adjudicated by the independent verify + the FULL gate band + refuter + re-audit
  // (exactly what guards the reFix path), and the fold's deterministic P1-inverse requires machine
  // proof the pinning/coverage tests RAN and PASSED on the current tree (verify-red-raw.txt exit 0).
  const verificationOnly = !!(test.verificationOnly === true && !test.red)
  res.verificationOnly = verificationOnly // fold: inverts P1 (transcript must show PASS, not FAIL) + skips P9 (no fixer ran by design)
  if (!test.red && !verificationOnly) return finish('FAILED', 'no red proof: ' + (test.note || 'test did not fail on old code'))
  res.transitions.push('RED') // for verificationOnly this represents the STANDING red proof from the prior round's verify-red-raw.txt

  // 3. fixer — skipped on a verification-only reFix (there is nothing to change; the runner + gates verify)
  if (!verificationOnly) {
    phase('Fix')
    const fix = await call('fixer', R.fixer, FIX_SCHEMA, reFixNote + 'The red regression test is already in the worktree. Make it green with the minimal correct fix' + (item.reFix ? ', addressing EVERY CHANGES_REQUIRED finding — the prior fix is PARTIAL, so COMPLETE it (do not just repeat it).' : '.') + claimsHint, 'Fix')
    res.artifacts.fix = 'state/items/' + id + '/fix.json'
    if (!fix) { res.infraSuspect = true; return finish('FAILED', 'fixer agent UNAVAILABLE (null after retries — possible infra/credit failure, NOT a quality verdict)') } // KI-L53
    if (fix.scopeStop) return await frameAndBlock('fixer scope-stop — ' + (fix.summary || ''))
    if (!fix.applied) return finish('FAILED', 'fixer did not apply: ' + (fix.note || fix.summary || ''))
  }

  // 4. runner (independent build + green + suite)
  phase('Verify')
  const sln = item.solution || CFG.solution || (item.target + ' solution (e.g. ' + item.target + '/' + item.target + '.sln)') // per-item solution wins (multi-target groups)
  // P10: codeChange counts the test the test-author ACTUALLY wrote — a doc/config item whose fix shipped a real
  // .cs regression test MUST still build + run it (a doc-skip must never bypass the independent build/green gate).
  const codeChange = filesHaveCs || (test && Array.isArray(test.testFiles) && test.testFiles.some(function (f) { return /\.cs$/.test(f) }))
  // P2: an item needs real infra when its FIX surface is .cs code (filesHaveCs) AND realInfraLikely
  // (normalizer flag OR defect-shape keyword). KI-L45: this deliberately keys on filesHaveCs, NOT on
  // codeChange — P10 widened codeChange to count a .cs regression TEST, which dragged doc/config items
  // (ITEM-C3 cycle 26: Dockerfile + services.json fix, incidental 'concurren' in item text) into a
  // Postgres/Redis container demand their fix cannot meaningfully satisfy. A doc/config fix's oracle is
  // its own check (docker build / grep / script); codeChange itself is unchanged (a .cs test still
  // requires build+green machine markers per P3/P10).
  const needsRealInfra = filesHaveCs && realInfraLikely
  res.codeChange = codeChange       // P3: driver FAILs a code item that produced no machine verify evidence (verify-raw.txt)
  res.needsRealInfra = needsRealInfra // P2: driver requires the FACTORY::REALINFRA container marker for these
  res.rootCauseFiles = pureCoverage ? [] : (item.files || []).filter(function (f) { return /\.cs$/.test(f) && !/Tests?\//i.test(f) && !/Tests?\.cs$/i.test(f) }) // P9: the non-test files the fix MUST touch — [] for pure coverage (KI-L39: files[] names the SUBJECT under test; the correct fix adds ONLY the new test)
  // SPEED: a doc/config item (no .cs) skips dotnet entirely (it would waste minutes); a LIGHT code item builds
  // only the TOUCHED project, not the whole solution; FULL keeps the full solution build + suite.
  // KI-L33: EXACT command lines, absolute paths, no placeholders the runner must resolve — a runner
  // that cannot find a relative verify/build-test.sh improvises marker-less checks and the fold then
  // (rightly) kills a green fix for missing machine evidence. The only free variable left is the
  // touched .csproj / test filter, which only the fix determines.
  // REVIEW PACK (cache-strategic, 2026-07-18): the runner generates the reviewers' shared change
  // snapshot as its LAST verify action — pure shell redirection to disk, ZERO runner context cost
  // (never read the pack back). The whole review band then Reads this ONE file instead of each
  // re-running its own exploratory diff + file reads. (BT/RAW/PACKCMD hoisted above, 2026-07-19.)
  const packHint = ' FINALLY generate the review pack for the gate band (exact command, output goes to disk — do NOT read it back): `' + PACKCMD + '`.'
  // KI-E11 — the runner ALSO tees the claims lint into the machine transcript for doc-touching items,
  // so reviewers (and the fold's F2 WARN) see the same deterministic phantom-path evidence.
  const claimsVerifyHint = docTouch ? ' DOC-CLAIM LINT (KI-E11): also run `' + BT + ' claims ' + wtPath + ' 2>&1 | tee -a ' + RAW + '` — FACTORY::CLAIMS-MISS lines are path claims the tree does not contain; report them in note (the fixer was briefed to leave this at FACTORY::CLAIMS::0).' : ''
  const verifyHint = (!codeChange
    ? 'DOC/CONFIG item — the fix touches NO .cs files, so do NOT run dotnet build/test. Run the regression-test check from the spec (the grep/script assertion) + confirm the acceptance. Report build="pass (n-a: no code change)", targetedTest per the grep, suite={"passed":0,"failed":0,"skipped":0}.'
    : (band === 'LIGHT'
      ? 'LIGHT code item — run EXACTLY these two commands (substitute only the touched test .csproj + the new test\'s filter), nothing hand-rolled: (1) `' + BT + ' build <touched .csproj> 2>&1 | tee -a ' + RAW + '` (2) `' + BT + ' filter <test .csproj> "<TestClassName>" 2>&1 | tee -a ' + RAW + '`. SKIP the full-solution build + full suite for speed. The FACTORY:: markers those commands emit into ' + RAW + ' ARE the machine evidence the fold requires — without them a green fix is overridden to FAILED.'
      : 'FULL code item — run EXACTLY these three commands (substitute only the test .csproj + filter): (1) `' + BT + ' build ' + sln + ' 2>&1 | tee -a ' + RAW + '` (2) `' + BT + ' filter <test .csproj> "<TestClassName>" 2>&1 | tee -a ' + RAW + '` (3) `' + BT + ' suite ' + sln + ' 2>&1 | tee -a ' + RAW + '`. The FACTORY:: markers in ' + RAW + ' ARE the machine evidence the fold requires.')) + claimsVerifyHint + packHint
  const realInfraHint = needsRealInfra ? ' REAL-INFRA MANDATORY (' + item.theme + '/' + item.severity + '): the targeted test MUST run against real Postgres/Redis via Testcontainers, NOT EF in-memory. Emit a machine marker line `FACTORY::REALINFRA::<kind>` (e.g. Testcontainers-Postgres) into verify-raw.txt ONLY when a real container actually started and the test bound to it; if Docker is unavailable set dockerAbsent=true and DO NOT emit the marker. The driver re-greps verify-raw.txt for that marker — a self-reported realInfraExercised without the marker does NOT close the item. GREP-ANCHORED SELF-REPORT (KI-E10): before returning, run `grep -c "FACTORY::REALINFRA::" ' + RAW + '` and set realInfraExercised STRICTLY from that output (>0 -> true, 0 -> false); quote the grep command + its output in evidence — never report the field from memory.' : ''
  const verify = await call('runner', R.runner, VERIFY_SCHEMA, verifyHint + realInfraHint + (item.reFix ? ' RE-FIX: the PRIOR attempt\'s test file(s) are EXPECTED in this worktree alongside the new one — do NOT report them as debris; only flag genuine scratch/diagnostic/duplicate files.' : ''), 'Verify')
  res.artifacts.verify = 'state/items/' + id + '/verify.json'
  if (!verify) { res.infraSuspect = true; return finish('FAILED', 'runner agent UNAVAILABLE (null after retries — possible infra/credit failure, NOT a quality verdict)') } // KI-L53
  if (!/^pass/i.test(String(verify.build))) return finish('FAILED', 'build failed: ' + (verify.evidence || ''))
  if (!/^pass/i.test(String(verify.targetedTest))) return finish('FAILED', 'targeted test not green')
  // Debris and fix-introduced NEW failures fail the item; a pre-existing environmental failure
  // (baselineFailures) does NOT — distinguishes a bad fix from a deprived runner.
  // KI-L23 (ITEM-H4): FAIL on debris ONLY when it is OBVIOUS junk (root-level factory artifacts,
  // scratch/temp/sandbox files, editor cruft). The runner (LLM) reports anything outside the audit's
  // files[] as debris, but files[] can be wrong/incomplete — a LEGITIMATE new source file the fix needed
  // (ITEM-H4's real AlreadyExistsException.cs, flagged because the audit listed wrong paths) is NOT
  // debris; it is for the GATES + the conservative fold-time debrisFiles (lib/verify.mjs) to judge.
  // Mirror that conservative rule here (inlined byte-equivalent — the Workflow runtime cannot import lib).
  const isObviousDebris = function (f) {
    const n = String(f || '').replace(/^\.?\//, '').trim(), b = n.split('/').pop()
    if (!n.includes('/')) { if (/\.json$/i.test(b) || /-raw\.txt$/i.test(b)) return true; if (/^(verify|test|fix|plan|refute|reaudit|integrate|adjudication|decision|last-failure)\b.*\.(md|txt|json)$/i.test(b)) return true }
    if (/(^|\/)(scratch|sandbox|tmp|temp)\//i.test(n)) return true
    if (/^(temp|tmp|scratch|sandbox|mock|diagnostic|debug|deleteme|delete[_-]me|junk)/i.test(b)) return true
    if (/\.(bak|orig|tmp|swp|rej)$/i.test(b)) return true
    return false
  }
  const realDebris = (Array.isArray(verify.debris) ? verify.debris : []).filter(isObviousDebris)
  if (realDebris.length) return finish('FAILED', 'worktree debris (scratch/temp/artifact files): ' + realDebris.join(', '))
  if (Array.isArray(verify.newFailures)) {
    if (verify.newFailures.length) return finish('FAILED', 'fix introduced ' + verify.newFailures.length + ' new test failure(s): ' + verify.newFailures.join(', '))
  } else {
    // No explicit newFailures from the runner: subtract the reported baseline so a deprived-runner
    // environmental failure does not fail a good fix (only NEW failures beyond baseline count).
    const failed = (verify.suite && (verify.suite.failed || verify.suite.Failed)) || 0
    const baseline = Array.isArray(verify.baselineFailures) ? verify.baselineFailures.length : 0
    if (failed - baseline > 0) return finish('FAILED', 'suite has ' + (failed - baseline) + ' new failure(s) beyond the ' + baseline + ' baseline')
  }
  // Phase-3 real-infra binding gate: a money / security / concurrency / idempotency item CANNOT close
  // on an EF in-memory green (the #1 audit theme — the green-build illusion). The regression test MUST
  // have run against real Postgres/Redis (Testcontainers). If Docker is absent the item PARKS (never a
  // silent in-memory pass). KI-L44: the sandboxed factory cannot read verify-raw.txt, and the runner's
  // RETURNED realInfraExercised field can diverge from its own on-disk artifact (ITEM-CR-5, cycle 26:
  // disk verify.json true + FACTORY::REALINFRA:: marker present in raw, returned field !== true →
  // false-failed the item BEFORE gates). So a non-true self-report no longer FAILS in-run — the item
  // proceeds to gates and the driver's fold-time P2 grep of verify-raw.txt (deterministic,
  // disk-authoritative) is the single close/fail authority for the marker.
  if (needsRealInfra && verify.realInfraExercised !== true) {
    if (verify.dockerAbsent) return finish('BLOCKED', 'realInfra item needs Docker/Testcontainers (real Postgres/Redis) — Docker absent on this runner; parked, NOT closed on an in-memory green')
    // KI-E10 — disk-authoritative marker PROBE before the band. KI-L44 keeps the runner's RETURNED
    // field non-fatal (it diverged from disk once, ITEM-CR-5); the probe instead GREPS the same
    // file the fold greps. markerFound=false = the band is deterministically doomed at fold
    // (ITEM-C7B cycle 39: a full band incl. 8 opus calls burned on exactly this) — fail fast
    // with precise feedback. Probe null (infra) or true -> proceed; the fold grep stays the authority.
    const probe = await call('marker-probe', { model: 'claude-haiku-4-5', effort: 'low' }, PROBE_SCHEMA, 'Run EXACTLY this ONE command via Bash: `grep -m1 "FACTORY::REALINFRA::" ' + RAW + '` — if it prints a line return markerFound=true with that line; if it prints nothing (exit 1) return markerFound=false. Do NOTHING else: no edits, no other commands, no interpretation.', 'Verify')
    if (probe && probe.markerFound === false) return finish('FAILED', 'realInfra marker probe (KI-E10): verify-raw.txt has NO FACTORY::REALINFRA:: marker on disk — the regression test never bound a real container (in-memory green). Failing BEFORE the gate band; write/fix the Testcontainers test (the fold-time grep remains the close authority).')
    res.note = (probe && probe.markerFound === true)
      ? 'realInfra marker probed PRESENT on disk (runner self-report lagged its own artifact — KI-L44 class); fold grep remains the authority'
      : 'realInfra self-report not true — close/fail deferred to the driver fold-time FACTORY::REALINFRA:: marker grep'
  } else if (needsRealInfra) res.note = 'real-infra verified (' + (verify.realInfraKind || 'Testcontainers') + ')'
  // Propagate the runner's environmental baseline so the driver's DETERMINISTIC fold-time check (KI-D3) does
  // not false-fail a legitimate pass on a deprived runner (build / targeted-test failures stay baseline-independent).
  res.baselineFailures = Array.isArray(verify.baselineFailures) ? verify.baselineFailures : []
  res.transitions.push('GREEN', 'BUILT', 'TESTED')

  // Editorial (Band C) — advisory, doc items only; applies doc fixes in the worktree, NEVER blocks.
  // KI-L34: runs BEFORE the gate band (it used to run after) so the gates review the editorial
  // output as part of the diff. Invariant: NOTHING mutates the worktree after the gate band — the
  // diff the gates approve is byte-for-byte the diff that integrates (an unreviewed post-gate
  // mutation is the same class as ITEM-C5's late fixer edit).
  // KI-L36: RF must be declared BEFORE this block (the reorder originally left it in the gates
  // section below — a temporal dead zone `node --check` cannot catch; every doc item crashed with
  // "Cannot access 'RF' before initialization" in cycle 24).
  const RF = R.reviewFlows || {}
  for (const f of flowsFor(item).filter(function (x) { return x.band === 'editorial' })) {
    const er = await call(SKILL_ROLE[f.skill], RF[f.routeKey], GATE_SCHEMA, 'Advisory editorial pass; apply doc fixes in the worktree but NEVER block the item. Do NOT break the delivered regression test (re-run it if you change anything it asserts on). If you changed ANY .md prose, run the claims lint `' + BT + ' claims ' + wtPath + '` and fix any FACTORY::CLAIMS-MISS your edits introduced (KI-E11). If you changed ANY file, REGENERATE the review pack as your LAST Bash action so the gate band reviews the FINAL diff (KI-L34): `' + PACKCMD + '`.', 'Verify')
    res.artifacts['review:' + f.skill.replace('bmad-', '')] = 'state/items/' + id + '/' + SKILL_ROLE[f.skill] + '.md'
    // KI-E23 (improvement-analysis P6a): record the ADVISORY editorial verdict in the gates map +
    // gateDetails so the fold's item_folded event and feedback.md carry it — 23 instrumented runs
    // had ZERO recorded editorial outcomes, leaving the lens's value unmeasurable (the next ~20
    // runs decide whether the double editorial pass earns its spend). Advisory stays advisory:
    // nothing here blocks the item.
    const ek = 'editorial:' + f.skill.replace('bmad-editorial-review-', '')
    res.gates[ek] = er ? er.verdict : 'NULL'
    res.gateDetails = res.gateDetails || {}
    res.gateDetails[ek] = er ? { verdict: er.verdict, headline: er.headline, findings: (er.findings || []).slice(0, 6), advisory: true } : null
  }

  // KI-L35: on a reFix round a reviewer that anchors on the PRIOR round's findings (its own old
  // artifact, a sibling's review, feedback.md) can re-assert an ALREADY-FIXED finding as a fresh
  // CHANGES_REQUIRED (cycle-21 adversarial re-blocked the delivered netpol-port fix verbatim).
  // Every blocking reviewer on a reFix is told: prior findings are HYPOTHESES to re-verify against
  // the CURRENT tree, never conclusions to copy forward.
  const staleGuard = item.reFix ? ' RE-FIX ROUND: prior-round findings may ALREADY be addressed in this diff. Re-verify EVERY prior finding against the CURRENT worktree state (grep/read the actual files) before re-asserting it — a finding copied forward without fresh verification is a FALSE CHANGES_REQUIRED. feedback.md in the artifacts dir is the prior round\'s authoritative digest; treat it as the list of things to CHECK, not to repeat.' : ''
  // KI-L55: a verificationOnly item shipped NO production-code change by design — the gate's job
  // flips from "is this fix correct" to "does the acceptance ALREADY hold on the current tree".
  const voGuard = verificationOnly ? ' VERIFICATION-ONLY ITEM: no fixer ran — the test-author attests the acceptance criterion ALREADY holds on the current tree (stale finding), or the new tests themselves ARE the deliverable (pure test-coverage). Independently verify the ACCEPTANCE against the CURRENT worktree (read the actual wiring, not just the cited lines): if the underlying defect is STILL present, CHANGES_REQUIRED with file:line evidence; if the claim holds, judge the pinning/coverage tests on quality as usual.' : ''

  // 4b. EARLY EDGE SCAN (KI-E12, owner directive 2026-07-19) — the edge-case hunter runs BEFORE the
  //     full gate band for EVERY code item (was: FULL-band CRITICAL/HIGH only, positioned inside the
  //     band). Cycles 39-41 telemetry: 0/3 pre-gate approvals, 3/3 dissents adjudicator-UPHELD — every
  //     real finding surfaced AFTER the whole band was spent and cost a full FAILED round. Early
  //     position: findings feed ONE bounded fixer amend + re-scan; the FINAL verdict then joins the
  //     gate-band verdict set unchanged (fold/adjudication/re-gate machinery untouched). Worktree
  //     mutation happens pre-band only (same invariant as the editorial pass, KI-L34).
  let edgeFinal = null, edgeRoute = null, edgeExtra = null
  const edgeFlow = flowsFor(item).find(function (f) { return f.routeKey === 'review.edgecase' && f.band === 'method' })
  if (edgeFlow) {
    phase('EdgeScan')
    edgeRoute = band === 'LIGHT' ? SONNET : (RF[edgeFlow.routeKey] || RT.rEdge)
    edgeExtra = 'Apply the ' + edgeFlow.skill + ' BMAD review methodology to the WORKTREE DIFF only (git -C <worktree> diff). Verdict CHANGES_REQUIRED on any CRITICAL/HIGH you find; APPROVED only if the diff is clean by your lens.' + staleGuard + voGuard + ' EARLY SCAN (pre-band, KI-E12): you run BEFORE the full gate band so unhandled boundaries get fixed cheaply now instead of failing the whole item after the band. Findings-only discipline as usual.'
    edgeFinal = await call('review-edgecase', edgeRoute, GATE_SCHEMA, edgeExtra, 'EdgeScan')
    res.artifacts['review:review-edge-case-hunter'] = 'state/items/' + id + '/review-edgecase.md'
    const edgeFindings = (edgeFinal && edgeFinal.findings) || []
    if (edgeFinal && edgeFinal.verdict === 'CHANGES_REQUIRED' && edgeFindings.length && !verificationOnly) {
      // ONE bounded amend: the fixer addresses the scan's findings, re-verifies the touched surface,
      // regenerates the pack; the re-scan's verdict is final (no second amend — the band adjudicates).
      const amend = await call('fixer', R.fixer, FIX_SCHEMA, 'EARLY EDGE-SCAN AMEND (KI-E12): the edge-case hunter walked your fix\'s branching paths BEFORE the gate band and found unhandled boundaries. Address EVERY finding below with the minimal correct guard (or state in note precisely why a finding is out of this item\'s scope). Then re-run the targeted build+test via `' + BT + ' build <touched .csproj> 2>&1 | tee -a ' + RAW + '` and `' + BT + ' filter <test .csproj> "<TestClassName>" 2>&1 | tee -a ' + RAW + '`, and REGENERATE the review pack: `' + PACKCMD + '`. FINDINGS: ' + JSON.stringify(edgeFindings.slice(0, 12)) + claimsHint, 'EdgeScan')
      if (amend && amend.scopeStop) return await frameAndBlock('fixer scope-stop during edge-scan amend — ' + (amend.summary || ''))
      if (amend && amend.applied) {
        const rescan = await call('review-edgecase', edgeRoute, GATE_SCHEMA, edgeExtra + ' RE-SCAN: an amend just addressed your prior findings — re-walk the AMENDED diff fresh; prior findings are hypotheses to re-verify (KI-L35), never conclusions to copy forward.', 'EdgeScan')
        if (rescan) edgeFinal = rescan
      }
    }
  }

  // 4c. ACCEPTANCE SCAN (KI-E18, improvement-analysis P1 2026-07-20) — a CHEAP haiku probe that
  //     answers "which acceptance clause has NO corresponding evidence in the diff?" BEFORE the
  //     expensive gate band. Evidence: the last four band FAILs were ALL acceptance-clause coverage
  //     gaps (a clause delivered in letter not behaviour; a clause read narrowly; a clause whose
  //     surface the lock set forbade) — each discovered by opus reviewers at full price. The clause
  //     split is deterministic (inlined splitAcceptanceClauses, lib/acceptance.mjs); the probe
  //     judges COVERAGE only (the band judges quality); gaps feed ONE bounded fixer amend + one
  //     re-probe; still-uncovered clauses FAIL the item pre-band, cheap, with exact clause-level
  //     feedback for the reFix (gateDetails -> feedback.md). Runs AFTER the edge-scan amend (it
  //     probes the final diff shape) and BEFORE the leftover scan (whose lint must see any amend
  //     this stage lands). Skipped for verificationOnly (no fix diff by design — the gate band
  //     adjudicates the stale-claim instead) and for single-clause acceptances (the band already
  //     checks those wholesale). Fail-open: a null/malformed probe never sinks an item.
  if (!verificationOnly) {
    const clauses = splitAcceptanceClauses(item.acceptance, 8)
    if (clauses.length >= 2) {
      phase('EdgeScan')
      const clauseList = clauses.map(function (c, i) { return '  ' + (i + 1) + '. ' + c }).join('\n')
      const acceptPrompt = 'ACCEPTANCE SCAN (KI-E18 — pre-band clause-coverage probe). The acceptance criterion splits into the numbered clauses below. STEP 1: Read ' + itemsDir(id) + '/review-pack.md (the machine snapshot of this change). STEP 2: for EACH clause, decide whether the CHANGE (the diff / new files; for a clause about pre-existing behaviour, the worktree state) contains CONCRETE evidence the clause is satisfied — a specific hunk, file, or test. Judge COVERAGE, not quality (the review band judges quality). Return covered=true ONLY if EVERY clause is evidenced; otherwise covered=false with each un-evidenced clause in gaps (quote the clause + why no evidence). Do NOT edit anything.\nCLAUSES:\n' + clauseList
      let ac = await call('acceptance-probe', { model: 'claude-haiku-4-5', effort: 'low' }, ACCEPT_SCHEMA, acceptPrompt, 'EdgeScan')
      if (ac && ac.covered === false && Array.isArray(ac.gaps) && ac.gaps.length) {
        // ONE bounded amend (mirrors the edge-scan amend), then ONE re-probe; the re-probe's verdict is final.
        const amend = await call('fixer', R.fixer, FIX_SCHEMA, 'ACCEPTANCE-GAP AMEND (KI-E18): a pre-band probe found acceptance clause(s) with NO evidence in your diff — the gate band would FAIL the item at full price for exactly this (the #1 recent FAIL cause). Address EVERY gap below with the minimal correct change (or state in note precisely why a clause is already satisfied or out of this item\'s scope). Then re-verify the touched surface (code: `' + BT + ' build <touched .csproj> 2>&1 | tee -a ' + RAW + '` + `' + BT + ' filter <test .csproj> "<TestClassName>" 2>&1 | tee -a ' + RAW + '`; doc/config: the spec\'s grep) and REGENERATE the review pack: `' + PACKCMD + '`. GAPS: ' + JSON.stringify(ac.gaps.slice(0, 8)) + claimsHint, 'EdgeScan')
        if (amend && amend.scopeStop) return await frameAndBlock('fixer scope-stop during acceptance amend — ' + (amend.summary || ''))
        if (amend && amend.applied) {
          const re = await call('acceptance-probe', { model: 'claude-haiku-4-5', effort: 'low' }, ACCEPT_SCHEMA, acceptPrompt + '\nRE-SCAN: an amend just addressed the prior gaps — judge the AMENDED diff fresh; prior gaps are hypotheses to re-verify, never conclusions to copy forward.', 'EdgeScan')
          if (re && typeof re.covered === 'boolean') ac = re
        }
      }
      if (ac && typeof ac.covered === 'boolean') {
        res.gates['probe:acceptance-scan'] = ac.covered ? 'APPROVED' : 'CHANGES_REQUIRED'
        res.gateDetails = res.gateDetails || {}
        res.gateDetails['probe:acceptance-scan'] = {
          verdict: ac.covered ? 'APPROVED' : 'CHANGES_REQUIRED',
          headline: ac.covered ? 'every acceptance clause evidenced in the diff' : ((ac.gaps || []).length + ' acceptance clause(s) with NO evidence in the diff'),
          findings: (ac.gaps || []).slice(0, 12).map(function (g) { return { severity: 'HIGH', title: 'un-evidenced acceptance clause: ' + String(g.clause || '').slice(0, 140), fix: String(g.why || '') } }),
        }
        if (!ac.covered) {
          const gapNote = (ac.gaps || []).slice(0, 6).map(function (g) { return String(g.clause || '').slice(0, 90) }).join(' | ')
          return finish('FAILED', 'acceptance-scan (KI-E18): acceptance clause(s) with NO evidence in the diff after one bounded amend — ' + (gapNote || 'see gateDetails') + '. Pre-band fail (cheap — no gate band was spent); the fix must address EVERY acceptance clause.')
        }
      }
    }
  }

  // 4d. LEFTOVER SCAN (KI-D12, owner directive 2026-07-19) — a CHEAP haiku pass that enforces
  //     execution-policy.md §4 ("no leftovers") on the fixer's OWN diff BEFORE the expensive gate band.
  //     A deterministic linter (build-test.sh leftovers) greps the FINAL pre-band diff's ADDED lines for
  //     the deferral/tech-debt lexicon (TODO/FIXME/HACK/XXX, NotImplementedException, "for now",
  //     "deferred", "temporary workaround", "follow-up", stubs — excluding the SANCTIONED
  //     standards-evolution: tags + secret-template placeholders + factory docs); the SAME haiku call
  //     then classifies each candidate as a genuine PUNT vs LEGIT (a UI placeholder attr, a test of the
  //     behaviour, a constraint-explaining comment). A genuine punt FAILS the item here — cheap and early
  //     — feeding the fixer on reFix, instead of the opus PO/adversarial gates catching it after a full
  //     band (or missing it). Runs after the edge-scan amend settles so it sees the final diff. Runs for
  //     EVERY code item INCLUDING verificationOnly ones (KI-D12 refinement, cycle-43 live: a pure-coverage
  //     item's DELIVERABLE is added test code, which can itself carry a leftover — a `[Fact(Skip="TODO")]`,
  //     commented-out assertions, a "// TODO test the error path" — exactly the intentionally-created debt
  //     this scan exists to catch; legit test stubs classify as LEGIT via haiku). Gated only on codeChange
  //     (a doc-only item has no added code to punt in). The linter output is teed to leftover-raw.txt so
  //     the fold can re-grep the deterministic FACTORY::LEFTOVER::<n> backstop.
  if (codeChange) {
    phase('EdgeScan')
    const LRAW = itemsDir(id) + '/leftover-raw.txt'
    const lo = await call('leftover-probe', { model: 'claude-haiku-4-5', effort: 'low' }, LEFTOVER_SCHEMA,
      'LEFTOVER SCAN (KI-D12). STEP 1 — run EXACTLY this via Bash and TEE the output: `' + BT + ' leftovers ' + wtPath + ' 2>&1 | tee ' + LRAW + '`. It prints `FACTORY::LEFTOVER-HIT::<file>::<lexeme>::<line>` per candidate + a final `FACTORY::LEFTOVER::<count>`. STEP 2 — for EACH hit, classify it against the ACTUAL line: a genuine PUNT is incomplete work the fix deferred (a real TODO/FIXME/HACK, a `throw new NotImplementedException()`, stubbed-out logic, a "for now"/"temporary"/"follow-up"/"until X ships" comment that postpones the real fix). LEGIT (NOT a punt): a UI `placeholder=` attribute, a test that asserts NotImplementedException/stub behaviour, a comment EXPLAINING a real constraint (not deferring work), a lexeme appearing inside a string literal or identifier. Return clean=true ONLY if ZERO genuine punts; otherwise clean=false with each punt in `punts` (file, the offending line, and why it is a deferral). Do NOT edit anything.', 'EdgeScan')
    res.artifacts['probe:leftover-scan'] = 'state/items/' + id + '/leftover-raw.txt'
    // Only act on an EXPLICIT boolean verdict (the schema REQUIRES `clean`, so a real haiku response
    // always carries it). A malformed / unavailable probe (lo == null, or lo without a boolean clean) is
    // ignored — a missing cheap-lint verdict must never sink an item; the fold's deterministic re-grep of
    // leftover-raw.txt is the backstop and the full gate band still runs.
    if (lo && typeof lo.clean === 'boolean') {
      res.gates['probe:leftover-scan'] = lo.clean ? 'APPROVED' : 'CHANGES_REQUIRED'
      if (!lo.clean) {
        const punts = (lo.punts || []).slice(0, 8).map(function (p) { return (p.file || '?') + ': ' + (p.why || p.line || '') }).join(' | ')
        return finish('FAILED', 'leftover-scan (KI-D12): fixer-introduced deferral(s)/tech-debt not ledgered — ' + (punts || 'see leftover-raw.txt') + '. execution-policy.md §4: no leftovers.')
      }
    }
  }

  // 5. REVIEW band — role gates (Band A) + method review-flows (Band B), EACH a separate adversarial
  //    subagent (never nested in the doing agent). 4 technical role gates + applicable method flows run
  //    pooled; the PO role gate runs LAST (functional acceptance after the technical band).
  phase('Gates')
  const gateRoles = band === 'LIGHT' ? ['developer', 'qa'] // LIGHT: skip the opus architect/security/po panel
    : (item.gateSet && item.gateSet.length ? item.gateSet : (CFG.gateSet || ['architect', 'developer', 'qa', 'security', 'po']))
  const techGates = gateRoles.filter(function (g) { return g !== 'po' })
  // KI-E12: the edge-case hunter left the late band ONLY when the early scan produced a verdict
  // (edgeFinal); a null early scan (agent unavailable) falls back to the late-band slot so verdict
  // coverage is never lost.
  const methodFlows = flowsFor(item).filter(function (f) { return f.band === 'method' && f.blocking && !(edgeFinal && f.routeKey === 'review.edgecase') })
  const blocking = techGates.map(function (g) { return { key: 'gate:' + g, role: 'gate-' + g, route: band === 'LIGHT' ? SONNET : R.gates[g], extra: (staleGuard + voGuard) || null } })
    .concat(methodFlows.map(function (f) {
      return { key: 'review:' + f.skill.replace('bmad-', ''), role: SKILL_ROLE[f.skill], route: band === 'LIGHT' ? SONNET : RF[f.routeKey],
        extra: 'Apply the ' + f.skill + ' BMAD review methodology to the WORKTREE DIFF only (git -C <worktree> diff). Verdict CHANGES_REQUIRED on any CRITICAL/HIGH you find; APPROVED only if the diff is clean by your lens.' + staleGuard + voGuard }
    }))
  const brRes = await Promise.all(blocking.map(function (x) { return call(x.role, x.route, GATE_SCHEMA, x.extra, 'Gates') }))  // each agent() routes through the global limiter (caps total concurrency)
  // KI-E12: the early scan's FINAL verdict joins the band's verdict set — recording, failedBlk,
  // adjudication membership, and the P8 re-gate loop treat it exactly like an in-band reviewer.
  if (edgeFinal) { blocking.push({ key: 'review:review-edge-case-hunter', role: 'review-edgecase', route: edgeRoute, extra: edgeExtra }); brRes.push(edgeFinal) }
  // KI-L31: capture the FULL structured verdict (headline + findings), not just the verdict string —
  // the driver projects these into state/items/<id>/feedback.md at fold, so the reFix loop never
  // depends on a reviewer remembering to write its artifact file (a returned-but-unwritten review
  // otherwise leaves the PRIOR attempt's file as poisoned feedback).
  res.gateDetails = res.gateDetails || {}
  const detail = function (gr) { return gr ? { verdict: gr.verdict, headline: gr.headline, acceptanceMet: gr.acceptanceMet, redGreenConfirmed: gr.redGreenConfirmed, findings: (gr.findings || []).slice(0, 12), reasons: gr.reasons } : null }
  for (let i = 0; i < blocking.length; i++) {
    const b = blocking[i], gr = brRes[i]
    res.artifacts[b.key] = 'state/items/' + id + '/' + b.role + '.md'
    res.gates[b.key] = gr ? gr.verdict : 'NULL'
    res.gateDetails[b.key] = detail(gr)
    // KI-L57: honour a gate's scopeViolation flag ONLY when the same gate did NOT approve — a
    // genuine red-line crossing is never approvable, so {verdict:'APPROVED', scopeViolation:true}
    // is a self-contradictory agent result (live: ITEM-H9 cycle 33 — the developer gate's
    // prose said "product-scope: CLEAR", verdict APPROVED, yet the stray boolean hard-stopped the
    // item into the owner queue on a false premise). The inconsistent flag is preserved on
    // gateDetails for the audit trail instead of blocking.
    if (gr && gr.scopeViolation) {
      if (gr.verdict !== 'APPROVED') return await frameAndBlock(b.key + ': product-scope violation (hard stop)')
      if (res.gateDetails[b.key]) res.gateDetails[b.key].scopeViolationIgnored = true
    }
  }
  const failedBlk = blocking.filter(function (b, i) { return (brRes[i] ? brRes[i].verdict : 'NULL') !== 'APPROVED' })
  // KI-L53: a NULL gate (agent unavailable after retries) is an INFRA failure, not a dissent — name it
  // separately in the note (so the fold's auto-infra-retry can spare the attempt) and never send a
  // null-only "dispute" to the adjudicator (there are no findings to adjudicate; fail-closed stands).
  const nullBlk = blocking.filter(function (b, i) { return !brRes[i] })
  if (nullBlk.length) res.infraSuspect = true
  const unavailNote = function () { return nullBlk.length ? '; stage agent UNAVAILABLE (null after retries — possible infra/credit failure, NOT a quality verdict): ' + nullBlk.map(function (b) { return b.key }).join(', ') : '' }
  if (failedBlk.length) {
    // KI-C8 — a SPLIT verdict on a CRITICAL/HIGH item is contestable: adjudicate (fable-5) rather than an
    // unconditional bounce. Unanimous CHANGES_REQUIRED, or any MEDIUM/LOW item, fails straight to the fixer.
    // KI-E15 (2026-07-20): the `band === 'FULL'` guard is DROPPED — a split on ANY CRITICAL/HIGH item
    // adjudicates, LIGHT band included. Cycle 46 ran two genuine LIGHT-band HIGH splits (ITEM-H17 5-vs-1,
    // ITEM-H-A6 6-vs-1) that failed straight to the operator, who had to convene the adjudicator
    // MANUALLY — both dissents were UPHELD with exact bounded remedies that direct-recovered same-session.
    // In-band adjudication turns "FAILED, unexplained dispute" into "FAILED + authoritative §5 remedy"
    // (or OVERRULED → proceeds), at a cost bounded to genuine splits only (unanimous fails and MEDIUM/LOW
    // items still skip it; the KI-L53 null-only outage guard is unchanged).
    const heavy = item.severity === 'CRITICAL' || item.severity === 'HIGH'
    const disputed = heavy && failedBlk.length < blocking.length && failedBlk.length > nullBlk.length // a null-only "dispute" is an outage, not a dissent
    if (disputed) {
      // P8: an adjudicator can never wave through the SECURITY gate on a security/crypto CRITICAL — that dissent
      // is non-adjudicable; the fix must SATISFY the gate, not be overruled past it.
      const securityDissent = failedBlk.some(function (b) { return b.key === 'gate:security' || b.key === 'review:review-security' })
      const securityCrit = item.severity === 'CRITICAL' && (item.theme === 'security-multitenancy' || /crypto|secret|token|auth|tls|pii/i.test(item.theme + ' ' + (item.title || '')))
      if (securityDissent && securityCrit) return finish('FAILED', 'security gate dissented on a security/crypto CRITICAL — non-adjudicable; the fix must satisfy the security gate (P8), it cannot be overruled')
      const adj = await call('adjudicator', R.adjudicator, ADJUDICATE_SCHEMA, 'DISPUTED ' + item.severity + ': review(s) [' + failedBlk.map(function (b) { return b.key }).join(', ') + '] returned CHANGES_REQUIRED while ' + (blocking.length - failedBlk.length) + ' other(s) APPROVED the SAME diff. Adjudicate on the merits of the worktree diff: is the fix genuinely defective (UPHELD -> back to the fixer) or were the dissenting review(s) wrong (OVERRULED -> the fix proceeds)? WRITE state/items/' + id + '/adjudication.md.', 'Gates')
      res.artifacts.adjudication = 'state/items/' + id + '/adjudication.md'
      res.gates['adjudicator'] = adj ? adj.verdict : 'NULL'
      res.gateDetails['adjudicator'] = detail(adj)
      if (!adj || adj.verdict !== 'OVERRULED') return finish('FAILED', 'review(s) not APPROVED + adjudicator ' + (adj ? adj.verdict : 'NULL') + ': ' + failedBlk.map(function (b) { return b.key }).join(', '))
      // P8: OVERRULE is not a free pass — RE-RUN the dissenting gate(s) once against the (unchanged) diff and
      // proceed ONLY if they now APPROVE. The adjudicator breaks a genuine tie; it does not silence a gate.
      const reRes = await Promise.all(failedBlk.map(function (b) { return call(b.role, b.route, GATE_SCHEMA, (b.extra || 'Re-gate this worktree diff.') + ' RE-GATE: adjudication OVERRULED the prior dissent as wrong-on-the-merits; judge the SAME diff strictly and independently. APPROVED only if it is genuinely clean by your lens.', 'Gates') }))
      for (let i = 0; i < failedBlk.length; i++) res.gateDetails[failedBlk[i].key + ':re-gate'] = detail(reRes[i])
      const stillFailed = failedBlk.filter(function (b, i) { return (reRes[i] ? reRes[i].verdict : 'NULL') !== 'APPROVED' })
      if (stillFailed.length) return finish('FAILED', 'adjudicator OVERRULED but the re-gate still not APPROVED (P8): ' + stillFailed.map(function (b) { return b.key }).join(', '))
      // re-gate APPROVED: proceed past the gate band.
    } else {
      return finish('FAILED', 'review(s) not APPROVED: ' + failedBlk.map(function (b) { return b.key }).join(', ') + unavailNote())
    }
  }
  if (gateRoles.includes('po')) {
    const po = await call('gate-po', R.gates.po, GATE_SCHEMA, null, 'Gates')
    res.artifacts['gate:po'] = 'state/items/' + id + '/gate-po.md'
    res.gates['gate:po'] = po ? po.verdict : 'NULL'
    res.gateDetails['gate:po'] = detail(po)
    if (!po) { res.infraSuspect = true; return finish('FAILED', 'PO gate agent UNAVAILABLE (null after retries — possible infra/credit failure, NOT a quality verdict)') } // KI-L53
    if (res.gates['gate:po'] !== 'APPROVED') return finish('FAILED', 'PO gate not APPROVED')
  }
  res.transitions.push('GATED')

  // 6+7. REFUTE + RE-AUDIT — two INDEPENDENT adversarial passes over the SAME verified+gated diff: the refuter
  //      ATTACKS the fix (the in-memory-illusion skeptic); the multi-lens re-audit CONFIRMS the original finding
  //      is gone AND no new CRITICAL/HIGH (KI-C10 audit-wave reuse). Neither reads the other's output, so they
  //      run CONCURRENTLY in one batch — saving a full opus stage's wall-clock per FULL item. BOTH must pass
  //      (refuter not-refuted AND every lens converged). A rare refutation also runs the lenses (the lost
  //      fail-fast is cheap vs the latency win on the common not-refuted path); all route through the CONC limiter.
  phase('Refute+Re-audit')
  // P7: a FULL / realInfra item ALWAYS runs the dedicated opus refuter; only a LIGHT item lets the
  // adversarial/edge-case review flow stand in for it (cost).
  const refuteCovered = band === 'LIGHT' && !needsRealInfra && methodFlows.some(function (f) { return f.skill === 'bmad-review-adversarial-general' || f.skill === 'bmad-review-edge-case-hunter' })
  const lenses = band === 'LIGHT' ? ['code'] : reauditLenses(item) // LIGHT: single-lens re-audit (cost)
  // one concurrent batch: the optional refuter (always slot 0 when present) + one re-auditor per lens
  const pv = []
  if (!refuteCovered) pv.push({ kind: 'refute' })
  for (const lens of lenses) pv.push({ kind: 'lens', lens: lens })
  const pvRes = await Promise.all(pv.map(function (t) {
    return t.kind === 'refute'
      ? call('refuter', R.refuter, REFUTE_SCHEMA, null, 'Refute+Re-audit')
      : call('re-auditor', R.reauditor, REAUDIT_SCHEMA, 'Apply the ' + t.lens + ' audit lens ONLY, scoped to the worktree diff + its immediate blast radius. Confirm the ORIGINAL finding is gone (cite the now-correct file:line, not the test) AND that THIS lens finds no new CRITICAL/HIGH in the change.', 'Refute+Re-audit')
  }))
  // refuter verdict (slot 0 when present)
  if (!refuteCovered) {
    const ref = pvRes[0]
    res.artifacts.refute = 'state/items/' + id + '/refute.md'
    if (!ref) { res.infraSuspect = true; return finish('FAILED', 'refuter agent UNAVAILABLE (null after retries — possible infra/credit failure, NOT a quality verdict)') } // KI-L53
    if (ref.refuted) return finish('FAILED', 'refuted: ' + (ref.attack || ref.headline || ''))
  }
  res.transitions.push('REFUTE_OK')
  // re-audit convergence (the lens results, with the refuter slot dropped when present)
  const raRes = refuteCovered ? pvRes : pvRes.slice(1)
  res.artifacts.reaudit = 'state/items/' + id + '/reaudit.md'
  res.gates['reaudit'] = lenses.map(function (l, i) { return l + '=' + (raRes[i] ? (raRes[i].converged ? 'ok' : 'no') : 'NULL') }).join(' ')
  // KI-L50: distinguish a NULL re-auditor (agent returned null after exhausting retries — an
  // infra/credit/skip failure, NOT a quality verdict) from a ran-but-did-not-converge lens. The note
  // makes the distinction visible in the results artifact so the orchestrator can fold the null case
  // with --infra-retry (attempt not counted) instead of burning the item's budget on an outage.
  const raNull = lenses.filter(function (l, i) { return !raRes[i] })
  const raNoConv = lenses.filter(function (l, i) { return raRes[i] && !raRes[i].converged })
  if (raNull.length || raNoConv.length) {
    if (raNull.length) res.infraSuspect = true // orchestrator hint: a stage agent was unavailable (retries exhausted) — likely infra/credit; confirm against the run's <failures> summary before --infra-retry
    const parts = []
    if (raNull.length) parts.push('re-auditor agent UNAVAILABLE (null after retries — possible infra/credit failure, NOT a quality verdict) on lens(es): ' + raNull.join(', '))
    if (raNoConv.length) parts.push('re-audit did not converge on lens(es): ' + raNoConv.join(', '))
    return finish('FAILED', parts.join('; '))
  }
  res.transitions.push('REAUDITED')

  // 8. escalate-tier stops here for human sign-off (auth/money/crypto/cross-service)
  if (item.autonomyTier === 'escalate' || item._escalate) {
    return finish('ESCALATED', 'auto-drafted + fully verified; awaiting human sign-off before integrate (blast-radius)')
  }

  // 9. integrator — global green + hand-off (no mutating git)
  phase('Integrate')
  const integHint = codeChange
    ? 'Solution: ' + sln + '. Run the GLOBAL regression build + full suite in the worktree — EXACTLY: `bash ' + FDIR + '/verify/build-test.sh build ' + sln + ' 2>&1 | tee -a ' + itemsDir(id) + '/integrate-raw.txt` then `bash ' + FDIR + '/verify/build-test.sh suite ' + sln + ' 2>&1 | tee -a ' + itemsDir(id) + '/integrate-raw.txt` (ABSOLUTE paths; the driver re-greps that file for the FACTORY::BUILD / FACTORY::SUITE markers — a self-reported globalGreen without the transcript does NOT integrate). regressionDelta = new failures beyond the verify-stage baseline. Do NOT stage/commit/merge.'
    : 'Solution: ' + sln + '. DOC/CONFIG item — no .cs changed; confirm the doc/config acceptance, report globalGreen=true, regressionDelta=0. Do NOT stage/commit/merge.'
  const integ = await call('integrator', R.integrator, INTEG_SCHEMA, integHint, 'Integrate')
  res.artifacts.integrate = 'state/items/' + id + '/integrate.md'
  res.integrateRaw = codeChange // P6: driver re-parses integrate-raw.txt for a code item before allowing CLOSED
  if (!integ) { res.infraSuspect = true; return finish('FAILED', 'integrator agent UNAVAILABLE (null after retries — possible infra/credit failure, NOT a quality verdict)') } // KI-L53
  if (!integ.globalGreen || (integ.regressionDelta || 0) > 0) return finish('FAILED', 'global regression at integration')
  if (integ.branch) res.branch = integ.branch
  res.transitions.push('INTEGRATED', 'CLOSED')
  res.toState = 'CLOSED'
  res.note = 'red→green; ' + Object.keys(res.gates).length + ' gates APPROVED; refute OK; re-audit converged; global green'
  return res
}

// ---- sweep mode: design the canonical fix ONCE, apply it across every site (LIGHT), gate the pattern once ----
function sweepCompose(role, sweep, wtPath, site, extra) {
  const targets = sweep.sites.map(function (s) { return s.target }).filter(function (v, i, a) { return a.indexOf(v) === i })
  const SWD = REPO + '/' + ((TPLDIR || '').replace(/\/agents$/, '') || '_bmad-output/ai-factory') + '/state/sweeps/sweep-' + sweep.index // absolute sweep-dir prefix
  const lines = [
    'SWEEP: ' + sweep.label + '   (theme ' + sweep.theme + ' · ' + sweep.sites.length + ' sites / ' + targets.length + ' services)',
    'WORKTREE (do ALL edits/builds here; NEVER run git commit/add/checkout/restore/stash/reset/clean): ' + wtPath,
    'REPO ROOT (read-only reference + briefs + audit docs): ' + REPO,
    '',
    'ROOT-CAUSE PATTERN (the same defect repeated across services): ' + sweep.label,
    'DESIGN DOC (read/write here): ' + SWD + '-design.md',
    site ? ('THIS SITE: ' + site.target + ' · finding ' + site.findingId + ' (' + site.severity + ') · files [' + (site.files || []).join(', ') + '] · ' + site.title)
      : ('ALL SITES: ' + targets.join(', ')),
    'FULL SWEEP SPEC (every site + its source-finding pointer — read it for the per-site defects + samples): ' + SWD + '.json',
    '',
    'GUARDRAILS (.claude/rules/*.md are acceptance): product-scope red-lines are HARD STOPS; no TODO/FIXME/stub; match surrounding idiom.',
    'YOUR ROLE BRIEF — read NOW from the REPO ROOT: ' + REPO + '/' + TPLDIR + '/' + role + '.md',
  ]
  if (extra) lines.push('', extra)
  return lines.join('\n')
}

async function applySweepSite(sweep, site, wtPath, cost) {
  const prompt = sweepCompose('fixer', sweep, wtPath, site,
    'SWEEP APPLY: read the DESIGN DOC (path above), then apply the DESIGNED pattern to THIS SITE ONLY — ' + site.target + ', files [' + (site.files || []).join(', ') + ']. Do NOT redesign; replicate the canonical pattern exactly for this service. COMPLETENESS: correct EVERY instance of a wrong fact in each file — grep the WHOLE file; a stale stack/broker/version often appears in MULTIPLE places (the header AND a lower deployment/external-services block), and a targeted edit that fixes one line but leaves a contradicting duplicate FAILS the gate (cycle-9 IAM lesson). Read large source/doc files in CHUNKS (offset/limit) — do NOT read an entire huge file or service tree wholesale; it can blow the context window (cycle-9 MARKETING thrash). Leave no stub. Return filesChanged + a 1-line summary.')
  const r = await tryAgent(prompt, { label: 'sweep:apply:' + site.findingId, phase: 'Fix', model: 'claude-sonnet-5', effort: 'medium', schema: FIX_SCHEMA })
  if (r) cost('claude-sonnet-5')
  return { findingId: site.findingId, target: site.target, applied: !!(r && r.applied && !r.scopeStop), scopeStop: !!(r && r.scopeStop), summary: (r && r.summary) || 'no result' }
}

async function runSweep(sweep) {
  const wtPath = (A.worktree && A.worktree.path) || (sweep.worktree && sweep.worktree.path)
  const res = { index: sweep.index, label: sweep.label, theme: sweep.theme, designed: false, gateVerdict: null, gates: {}, sites: [], cost: {}, worktree: wtPath, branch: (A.worktree && A.worktree.branch) || (sweep.worktree && sweep.worktree.branch), note: '' }
  const cost = function (m) { res.cost[m] = (res.cost[m] || 0) + 1 }
  if (!wtPath) { res.note = 'no worktree assigned — refusing to run against the main checkout'; return res }

  // 1. DESIGN once (opus) — the canonical fix pattern for the whole cluster. Skipped on a chunked re-run
  //    (sweep.skipDesign): the design doc is already on disk and the per-site fixers read it.
  res.design = 'state/sweeps/sweep-' + sweep.index + '-design.md'
  if (sweep.skipDesign) {
    res.designed = 'prior'
  } else {
    phase('Plan')
    const design = await tryAgent(sweepCompose('sweep-designer', sweep, wtPath, null,
      'Design the SINGLE canonical fix that resolves this root-cause cluster across ALL ' + sweep.sites.length + ' sites. Read 2-3 sample source findings (from the FULL SWEEP SPEC above) + the relevant rule files. WRITE the DESIGN DOC (path shown above): the exact change template, per-service application notes, and a conformance check. Return the pattern.'),
      { label: 'sweep:design', phase: 'Plan', model: 'claude-opus-4-8', effort: 'high', schema: SWEEP_DESIGN_SCHEMA })
    if (design) cost('claude-opus-4-8')
    if (!design || !design.pattern) { res.note = 'sweep design failed (no pattern returned)'; return res }
    res.designed = true
  }

  // 2. APPLY per site — PARALLEL when sites touch DISJOINT files (e.g. each service's own AGENTS.md → big
  //    wall-clock win), SEQUENTIAL when any two sites share a file (e.g. all PDBs in pod-disruption-budgets.yaml)
  //    to avoid a write race. LIGHT sonnet, in the shared worktree.
  phase('Fix')
  const fc = {}; for (const s of sweep.sites) for (const f of (s.files || [])) fc[f] = (fc[f] || 0) + 1
  const sharedFile = sweep.sites.some(function (s) { return (s.files || []).some(function (f) { return fc[f] > 1 }) })
  if (sharedFile) { res.sites = []; for (const site of sweep.sites) res.sites.push(await applySweepSite(sweep, site, wtPath, cost)) }
  // NO outer `limit` here — applySweepSite's agent() ALREADY routes through the global limiter (via tryAgent).
  // Wrapping the whole site in limit() too would hold a slot while its inner agent() waits for one -> nested-
  // limiter DEADLOCK (no agents run). The Promise.all fans out; the inner limit caps real concurrency at CONC.
  else { res.sites = await Promise.all(sweep.sites.map(function (site) { return applySweepSite(sweep, site, wtPath, cost) })) }
  res.applyMode = sharedFile ? 'sequential (shared file)' : 'parallel (disjoint files)'
  const applied = res.sites.filter(function (s) { return s.applied }).length

  // 2b. VERIFY (CODE sweeps only) — a DOC sweep has nothing to build, so it is correctly skipped; a CODE
  //     sweep MUST compile after the applies (a bad pattern could break N services' build). Build the
  //     affected projects once; a doc-only diff reports n-a. Routed haiku (mostly tool execution).
  const codeSweep = sweep.sites.some(function (s) { return (s.files || []).some(function (f) { return /\.cs$/.test(f) }) })
  if (codeSweep) {
    phase('Verify')
    // KI-L64: sweep verify pinned haiku→sonnet with the item runner — same 200k-ceiling death on big build/test output.
    const v = await tryAgent(sweepCompose('runner', sweep, wtPath, null, 'CODE-SWEEP VERIFY: inspect the worktree diff (git -C <worktree> diff). If it changed any .cs, build the affected solution(s)/projects + run the relevant tests via verify/build-test.sh and report build pass/fail + failures. If the diff is doc-only, report build="pass (n-a: no code change)".'), { label: 'sweep:verify', phase: 'Verify', model: 'claude-sonnet-5', effort: 'low', schema: VERIFY_SCHEMA })
    if (v) cost('claude-sonnet-5')
    res.verify = v ? String(v.build || '?') : 'NULL'
    if (v && !/^pass/i.test(String(v.build))) { res.gateVerdict = 'CHANGES_REQUIRED'; res.gates = { build: 'FAILED' }; res.note = 'designed; ' + applied + '/' + sweep.sites.length + ' applied; CODE-SWEEP BUILD FAILED: ' + (v.evidence || ''); return res }
  }

  // 3. GATE the pattern ONCE (architect + security on the design + the full worktree diff). The two gates are
  //    INDEPENDENT reviews of the same diff — run them CONCURRENTLY (mirrors runItem's parallel gate panel;
  //    each agent() still routes through the global CONC limiter, so total concurrency stays bounded).
  phase('Gates')
  const [arch, sec] = await Promise.all([
    tryAgent(sweepCompose('gate-architect', sweep, wtPath, null, 'Review the SWEEP design + the full worktree diff (git -C <worktree> diff). Is the pattern correct AND consistently applied across all sites? CHANGES_REQUIRED on any CRITICAL/HIGH or any site that deviates.'), { label: 'sweep:gate-architect', phase: 'Gates', model: 'claude-opus-4-8', effort: 'high', schema: GATE_SCHEMA }),
    tryAgent(sweepCompose('gate-security', sweep, wtPath, null, 'Security review of the SWEEP pattern + diff across all sites (multi-tenancy, authz, secrets, scope red-lines).'), { label: 'sweep:gate-security', phase: 'Gates', model: 'claude-opus-4-8', effort: 'high', schema: GATE_SCHEMA }),
  ])
  if (arch) cost('claude-opus-4-8')
  if (sec) cost('claude-opus-4-8')
  res.gates = { architect: arch ? arch.verdict : 'NULL', security: sec ? sec.verdict : 'NULL' }
  res.gateVerdict = (arch && arch.verdict === 'APPROVED' && sec && sec.verdict === 'APPROVED') ? 'APPROVED' : 'CHANGES_REQUIRED'
  // Capture the BLOCKING (CRITICAL/HIGH) gate findings + map each to a site by target name, so the driver can
  // close PER-SITE: a CHANGES_REQUIRED that flags only ONE site must NOT block the other GOOD sites (cycle-9:
  // 5/6 AGENTS.md sites were correct; only IAM was incomplete). LOW/MEDIUM findings are forward-to-dev, not blocking.
  const allFindings = [].concat((arch && arch.findings) || [], (sec && sec.findings) || []).filter(Boolean)
  res.findings = allFindings.map(function (f) { return { severity: f.severity, file: f.file, title: f.title } }) // ALL findings (incl MEDIUM/LOW) for visibility
  const blocking = allFindings.filter(function (f) { return f.severity === 'CRITICAL' || f.severity === 'HIGH' }) // only HIGH/CRITICAL block a site; MEDIUM/LOW are forward-to-dev nits
  for (const site of res.sites) site.gateFlagged = blocking.some(function (f) { return f.file && String(f.file).indexOf(site.target) >= 0 })
  res.note = 'designed; ' + applied + '/' + sweep.sites.length + ' applied; gate ' + res.gateVerdict + (blocking.length ? ' (' + blocking.length + ' blocking; ' + res.sites.filter(function (s) { return s.gateFlagged }).length + ' site(s) flagged)' : '')
  return res
}

// ---- run ----
phase('Plan')
log('factory: ' + items.length + ' item(s), conc ' + CONC + (DRY ? ' (DRY-RUN)' : '') + (WT ? ', worktree ' + WT.path : ''))
const plan = items.map(planFor)
for (const p of plan) log('  plan ' + p.id + ' [' + p.fixType + '] test=' + p.stages.testAuthor + ' fix=' + p.stages.fixer + ' gates=' + p.stages.gates + ' refute=' + p.stages.refuter)

// Sweep mode (root-cause fan-out): design the canonical fix ONCE, apply it to every site (LIGHT), gate the
// pattern once. Dispatched when args carries a `sweep` spec (cluster.mjs --emit / driver sweep).
if (A.sweep) {
  if (DRY) return { mode: 'dry-run-sweep', sweep: { index: A.sweep.index, label: A.sweep.label, theme: A.sweep.theme, sites: (A.sweep.sites || []).length } }
  log('sweep: ' + A.sweep.label + ' — design once + apply ' + (A.sweep.sites || []).length + ' sites')
  const sres = await runSweep(A.sweep)
  return { mode: 'sweep', cycle: A.cycle, usage: (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function') ? { outputTokens: budget.spent() } : undefined, sweep: sres } // KI-E23 (P6c)
}

if (DRY || !items.length) {
  return { mode: DRY ? 'dry-run' : 'empty', cycle: A.cycle, plan, results: [] }
}

// Phase-4 scale-out: items run IN PARALLEL, each in its OWN worktree (item.worktree). Every agent()
// call routes through the global `limit` (makeLimiter(CONC)), so total concurrent agents stay <= CONC
// across all items + stages — an item never holds a slot while awaiting another, so there is no
// nested-limiter deadlock. Isolated per-item worktrees => zero cross-item contamination (Phase-2 finding 4).
// KI-L40 — kill-resilience checkpoint: the batch's results previously existed ONLY in this workflow's
// memory until the final return, so a session kill mid-run lost every COMPLETED item's lifecycle and
// the whole band re-ran (cycle 25 was launched 3×, ~2 dead bands). The moment an item resolves, a
// cheap haiku agent persists its full result to state/items/<id>/result.json (the runtime has no fs —
// an agent is the only writer available) and self-verifies the JSON parses. After a kill:
// `driver.mjs reconstruct` rebuilds results-cycle-<N>.json from these checkpoints, the normal fold
// applies the completed items (the deterministic override still re-checks all machine evidence), and
// only genuinely unfinished items re-run. Best-effort: a failed checkpoint never fails the item.
async function checkpointResult(r) {
  // KI-C2: a budget-stopped item was never attempted — checkpointing it would make `reconstruct`
  // fold a no-op and `resume` hide its relaunch line (it looks "checkpointed"). Skip on purpose.
  if (r && r.budgetStopped) { log('[checkpoint] ' + r.id + ' budget-stopped — intentionally NOT checkpointed (item stays CLAIMED and must re-run)'); return r }
  try {
    const path = itemsDir(r.id) + '/result.json'
    const json = JSON.stringify(r)
    // Provenance preamble (analysis F4, 2026-07-17): this writer PERSISTS an already-computed
    // result — it does not author verdicts. The preamble directs any observer (human or
    // automated safety review) to the on-disk stage artifacts + machine-evidence transcripts
    // that PRODUCED this JSON, so persistence is distinguishable from fabrication; the driver's
    // fold independently re-derives the verdict from those raw transcripts regardless.
    const ck = await tryAgent('You are a checkpoint writer performing kill-resilience PERSISTENCE (KI-L40) — you are NOT authoring or judging a result. This is routine machine-state bookkeeping of an automated build pipeline about its OWN run: the JSON below contains automated build/test/review verdicts about CODE in a scratch worktree — it represents no human signature, no official record, and no communication to any person (KI-D8 provenance). The JSON was ALREADY COMPUTED by this workflow\'s ' + Object.keys(r.artifacts || {}).length + ' prior lifecycle stage(s); their artifacts and machine-evidence transcripts (verify-red-raw.txt / verify-raw.txt / integrate-raw.txt with FACTORY:: markers, gate/review prose) are on disk at ' + itemsDir(r.id) + ' — run `ls -la ' + itemsDir(r.id) + '` FIRST and confirm the stage artifacts exist; they are the provenance of every verdict in this JSON. The driver\'s fold re-derives the final verdict from those transcripts and NEVER trusts this file alone. Write the EXACT text between the CHECKPOINT-BEGIN and CHECKPOINT-END markers (exclusive) to the file ' + path + ' (absolute path; overwrite if it exists) using the Write tool — byte-for-byte, ONE line, no reformatting, no added/removed fields, no markdown fences.\nCHECKPOINT-BEGIN\n' + json + '\nCHECKPOINT-END\nThen VERIFY it parses: run `node -e "JSON.parse(require(\'fs\').readFileSync(\'' + path + '\',\'utf8\'));console.log(\'CHECKPOINT-OK\')"` via Bash and confirm the output is CHECKPOINT-OK. If the parse fails, rewrite the file and re-verify. Return written=true ONLY after seeing CHECKPOINT-OK.', { label: r.id + ':checkpoint', phase: 'Checkpoint', model: 'claude-haiku-4-5', effort: 'low', schema: CHECKPOINT_SCHEMA }) // KI-L48: was phase:'Integrate' — a FAILED item's checkpoint showed as Integrate activity, misreading as gates-skipped
    if (!ck || ck.written !== true) log('[checkpoint] ' + r.id + ' NOT persisted — a reconstruct after a kill will not see this item')
  } catch (e) { log('[checkpoint] ' + r.id + ' failed: ' + (e && e.message)) }
  return r
}
log('parallel scale-out: ' + items.length + ' item(s), per-item worktrees, global agent cap ' + CONC)
const results = await Promise.all(items.map(function (it) {
  // robustness: an unexpected throw in one item's lifecycle must NOT reject the whole batch (Promise.all)
  // and lose every sibling's result — it degrades that item to FAILED and the rest still fold.
  return runItem(it)
    .then(function (r) { log('=== ' + it.id + ' -> ' + r.toState + ' :: ' + r.note); return r })
    .catch(function (e) {
      log('=== ' + it.id + ' -> CRASHED :: ' + (e && e.message))
      // KI-L68: a StructuredOutput retry-cap exhaustion (N consecutive agent calls with no valid
      // output) is the harness-throw flavour of the KI-L50 "agent UNAVAILABLE" class — mark it
      // infraSuspect so the fold auto-applies attempt-not-counted (capped by maxInfraRetries).
      var infra = /StructuredOutput retry cap \(\d+\) exceeded/.test(String(e && e.message))
      return { id: it.id, resultId: it.id + '#' + (A.cycle || 0), attemptsDelta: 1, transitions: ['FAILED'], toState: 'FAILED', artifacts: {}, gates: {}, cost: {}, worktree: (it.worktree && it.worktree.path) || (WT && WT.path), branch: (it.worktree && it.worktree.branch) || (WT && WT.branch), note: 'runItem threw: ' + (e && e.message), infraSuspect: infra || undefined }
    })
    .then(checkpointResult) // KI-L40 — persist BOTH outcomes (resolved AND crashed) the moment they exist
}))
// KI-E23 (P6c): per-run token usage — budget.spent() is the runtime's output-token counter for this
// turn; the driver's fold emits it as a `usage` telemetry event so cost analyses stop extrapolating
// from call counts. Observational only (never fold evidence).
return { mode: 'run', cycle: A.cycle, plan, usage: (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function') ? { outputTokens: budget.spent() } : undefined, results: results }
