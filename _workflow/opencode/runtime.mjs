// tools/ai-factory/_workflow/opencode/runtime.mjs
//
// OPENCODE ADAPTER (KI-O1) — the per-item state machine that replaces Claude Code's native
// `Workflow` execution of `_workflow/factory.js` for a session (like OpenCode) that has no
// `Workflow` tool. This is a CHECKPOINT-DRIVEN CLI: the controlling agent (you) calls `next` to
// learn what to do, either runs a MECHANICAL step itself (build/test via build-test.sh — no LLM
// needed, byte-identical to the real pipeline) or dispatches an AGENT step via its own Task tool
// (using the prompt/schema this module hands back), then calls `submit` with the structured JSON
// result. State persists to `state/items/<id>/opencode-progress.json` between calls, so the
// controlling agent can drive this across many separate tool-call turns.
//
// Ported from `_workflow/factory.js`'s `runItem()` (single-item path only — sweep-mode/multi-item
// batch parallelism are OUT OF SCOPE for this port; drive items one at a time). Mirrors its phase
// sequence, retry/adjudication/bounded-amend logic, and produces a `state/items/<id>/result.json`
// in the EXACT shape `driver.mjs fold` validates (see KNOWN-ISSUES.md KI-O1 for the fidelity gaps
// this port documents, chiefly: no per-call model tiering — every agent step actually runs on
// whatever model backs the controlling session's Task subagent, not the intended RT/FLOW_RT tier).
//
// Usage (from the HOST repo root, same convention as driver.mjs):
//   node tools/ai-factory/_workflow/opencode/runtime.mjs init <itemId>
//   node tools/ai-factory/_workflow/opencode/runtime.mjs next <itemId>
//   node tools/ai-factory/_workflow/opencode/runtime.mjs submit <itemId> --role <role> --json <file|->
//   node tools/ai-factory/_workflow/opencode/runtime.mjs mech <itemId> <step> [--json <file>]
//   node tools/ai-factory/_workflow/opencode/runtime.mjs status <itemId>
//   node tools/ai-factory/_workflow/opencode/runtime.mjs finalize <itemId>

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateNamed } from './schemas.mjs';
import { flowsFor, routesFor, bandFor, reauditLenses, needsRealInfra as computeNeedsRealInfra, gateRolesFor } from './routing.mjs';
import { compose, itemsDir as itemsDirFor } from './compose.mjs';
import { runBuildTest, writeRaw, parseVerifyRaw, verdictFromParse, parseRedRaw, hasRealInfraMarker, debrisFiles, nonTestChanged, flakeSuspects, effectiveBaseline, decodeTranscript, dockerAvailable } from './buildtest.mjs';
import { changedFiles } from '../lib/worktree.mjs';
import { splitAcceptanceClauses } from '../lib/acceptance.mjs';
import { normalizePlanSteps, hasPlanCommitmentLanguage } from '../lib/plan-commitment.mjs';
// Host-policy gate (PR#9 review): the no-new-comments mechanical check runs ONLY when the HOST enables
// policies.noNewComments (config/factory.config[.local].json) — same single loader factory.js's probe
// gating (factory.js `if (codeChange && A && A.policies && A.policies.noNewComments)`) and driver
// fold's WARN backstop key off. Engine default: OFF.
import { loadPolicies } from '../lib/policy.mjs';
// Direct import of the deterministic comment detector (Windows-safe, no build-test.sh/bash seam) —
// the SAME single source of truth the comment-lint CLI and driver fold's KI-E59 backstop use.
import { findComments } from '../lib/comment-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = join(HERE, '..', '..').replace(/\\/g, '/'); // tools/ai-factory, absolute, forward-slash

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function writeJsonAtomic(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + '.tmp', JSON.stringify(obj, null, 2) + '\n');
  renameSync(p + '.tmp', p);
}

// ---- locate + load the item spec and its ledger row (same on-disk files driver.mjs owns; READ-ONLY here) ----
function loadGraph() { return readJson(join(FACTORY_ROOT, 'state', 'findings-graph.json')); }
function loadLedger() { return readJson(join(FACTORY_ROOT, 'state', 'ledger.json')); }
function findItem(id) {
  const graph = loadGraph();
  const wi = (graph.items || []).find((w) => w.id === id);
  if (!wi) throw new Error(`item "${id}" not found in findings-graph.json`);
  return wi;
}
function findLedgerRow(id) {
  const ledger = loadLedger();
  const row = ledger.items[id];
  if (!row) throw new Error(`item "${id}" not found in ledger.json — run driver.mjs group first`);
  return { ledger, row };
}

// A worktree is a linked git worktree: <path>/.git is a FILE containing "gitdir: <main>/.git/worktrees/<name>".
// Resolve the MAIN repo root generically from it (no target-specific hardcoding).
function resolveMainRepoRoot(worktreePath) {
  const gitFile = join(worktreePath, '.git');
  const txt = readFileSync(gitFile, 'utf8').trim();
  const m = /^gitdir:\s*(.+)$/.exec(txt);
  if (!m) throw new Error(`"${gitFile}" is not a linked-worktree pointer file (expected "gitdir: ...")`);
  const gitdir = m[1].replace(/\\/g, '/');
  const idx = gitdir.indexOf('/.git/worktrees/');
  if (idx < 0) throw new Error(`unexpected worktree gitdir shape: ${gitdir}`);
  return gitdir.slice(0, idx);
}

function progressPath(id) { return join(FACTORY_ROOT, 'state', 'items', id, 'opencode-progress.json'); }
function loadProgress(id) { return readJson(progressPath(id)); }
function saveProgress(id, p) { writeJsonAtomic(progressPath(id), p); }

function log(...a) { console.log(...a); }

// ---------------------------------------------------------------------------------------------
// init — build the ctx + initial `res` skeleton (mirrors factory.js runItem's pre-flight, lines
// ~370-400) and persist it. cycle defaults to ledger.cycle+1 unless --cycle overrides (matches how
// `group` stamps result.resultId's cycle suffix).
// ---------------------------------------------------------------------------------------------
// Item ids become path segments (state/items/<id>/...) — reject anything that could traverse or
// smuggle separators before it ever reaches a join(). Alphanumeric start, then [A-Za-z0-9._-].
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Parity: driver.mjs cmdSelect/cmdGroup stamp the in-flight batch with `cycle: ledger.cycle + 1`
// (fold bumps ledger.cycle afterwards), and reconstruct/resume look for checkpoints stamped
// "<id>#<ledger.cycle + 1>". Using bare ledger.cycle here minted the PREVIOUS fold's resultId on a
// re-fix, and foldResults' idempotency journal (ledger.folded) silently discarded the whole result.
export function defaultCycleFor(ledgerCycle, cycleFlag) {
  return cycleFlag ? parseInt(cycleFlag, 10) : ledgerCycle + 1;
}
function cmdInit(id, flags) {
  if (!id || !SAFE_ID_RE.test(id)) {
    throw new Error(`init: unsafe item id ${JSON.stringify(id)} — ids must match ${SAFE_ID_RE} (they become state/items/<id>/ path segments; separators and ".." are rejected so a poisoned graph cannot traverse)`);
  }
  let item, worktreePath, branch, cycle, prevState, ledgerState;
  if (flags.fixture) {
    // Self-test escape hatch (KI-O1): bypass findings-graph.json/ledger.json entirely so the state
    // machine can be exercised without touching a real item's on-disk artifacts. NEVER used for a
    // real run — `mech` steps that need an actual worktree/dotnet build will simply fail loudly if
    // pointed at a fixture whose worktreePath isn't a real checkout.
    const fx = readJson(flags.fixture);
    item = fx.item; worktreePath = fx.worktreePath.replace(/\\/g, '/'); branch = fx.branch || 'fixture/none';
    cycle = fx.cycle || 1; prevState = fx.prevState || null; ledgerState = fx.state || 'READY';
  } else {
    item = findItem(id);
    const { ledger, row } = findLedgerRow(id);
    if (!row.worktree) throw new Error(`ledger row for ${id} has no worktree — run driver.mjs group --ids ${id} --include-realinfra first`);
    worktreePath = row.worktree.replace(/\\/g, '/'); branch = row.branch;
    cycle = defaultCycleFor(ledger.cycle, flags.cycle); // parity: driver.mjs cmdSelect/cmdGroup `cycle: ledger.cycle + 1` — see defaultCycleFor
    prevState = row.prevState; ledgerState = row.state;
  }
  const repoRoot = flags.fixture ? worktreePath : resolveMainRepoRoot(worktreePath);
  const band = bandFor(item);
  const filesHaveCs = (item.files || []).some((f) => /\.cs$/i.test(f));
  const codeChange = filesHaveCs; // refined again after Test phase if the test-author's testFiles[] adds .cs
  const nri = computeNeedsRealInfra(item, filesHaveCs);
  // Parity: factory.js runItem `const pureCoverage = item.theme === 'test-coverage' && !item.realInfra`
  // (truthiness, NOT `=== false` — a coverage item with realInfra ABSENT is still pure coverage) and
  // `res.rootCauseFiles = pureCoverage ? [] : (item.files||[]).filter(non-test .cs)` — the fold's P9
  // root-cause-touch check reads exactly this shape; the planner's own files[] never feeds it.
  const pureCoverage = item.theme === 'test-coverage' && !item.realInfra;
  const rootCauseFiles = pureCoverage ? [] : (item.files || []).filter((f) => /\.cs$/i.test(f) && !/Tests?\//i.test(f) && !/Tests?\.cs$/i.test(f));
  const ctx = { repoRoot, worktreePath, branch, factoryRoot: FACTORY_ROOT, templatesDir: join(FACTORY_ROOT, 'agents').replace(/\\/g, '/') };
  const res = {
    id: item.id,
    resultId: item.id + '#' + cycle,
    attemptsDelta: 1,
    transitions: [],
    toState: 'FAILED',
    band,
    artifacts: {},
    gates: {},
    gateDetails: {},
    cost: {}, // actual model used by THIS session — see KI-O1: not the RT-intended tier
    worktree: worktreePath,
    branch: branch,
    note: '',
    codeChange,
    needsRealInfra: nri,
    rootCauseFiles,
  };
  const progress = {
    id, item, ctx, cycle, band, res,
    phase: item.fixType === 'mechanical' ? 'test' : 'plan', // planner skipped for mechanical fixType (factory.js ~455)
    verificationOnly: null,
    pending: null,
    pendingSet: null, // { phaseLabel, keys: [key,...], received: {key: result} } for pooled/concurrent phases
    edgeFinal: null,
    reFix: prevState === 'FAILED' || ledgerState === 'FAILED',
    initAtMs: Date.now(), // KI-E43 reFix fence anchor: a baseline-raw.txt (re)captured AFTER this attempt started is distrusted on a reFix (mirrors driver fold's claim-history mtime fence)
    checkpointed: false, // set by `mech checkpoint` — EVERY terminal (CLOSED and FAILED/BLOCKED/ESCALATED alike) must write result.json before `next` reports done
    history: [],
  };
  saveProgress(id, progress);
  log(`init: ${id} cycle=${cycle} band=${band} fixType=${item.fixType} verificationOnly-candidate=${pureCoverage}`);
  log(`  repoRoot=${repoRoot}`);
  log(`  worktree=${worktreePath} branch=${branch}`);
  log(`  reFix=${progress.reFix} (prior feedback.md/gate-*.md/review-*.md should already exist if true)`);
  log('next: node ' + fileURLToPath(import.meta.url) + ' next ' + id);
}

function finish(progress, toState, note) {
  progress.res.transitions.push(toState);
  progress.res.toState = toState;
  progress.res.note = note;
  progress.phase = 'done';
  return progress;
}

function ctxFor(progress) { return progress.ctx; }

// ---------------------------------------------------------------------------------------------
// next — the dispatcher. Returns a plan for the CURRENT phase without mutating state (idempotent —
// safe to call repeatedly, e.g. after a crash/resume, exactly like re-printing a Workflow({scriptPath})
// launch line is safe).
// ---------------------------------------------------------------------------------------------
function cmdNext(id) {
  const progress = loadProgress(id);
  const { item, ctx, res } = progress;
  const out = planNext(progress);
  log(JSON.stringify(out, null, 2));
  return out;
}

// Shared prompt-extra builders, ported verbatim-adapted from factory.js runItem (KI-L35 staleGuard,
// KI-L55 voGuard, the KI-E12 edgeExtra) so every gate/review dispatched by this port carries the SAME
// reFix / verification-only mandates the native band composes.
function btFor(ctx) { return 'bash ' + ctx.factoryRoot + '/verify/build-test.sh'; }
function staleGuardFor(progress) {
  // Parity: factory.js `const staleGuard = item.reFix ? ...` (KI-L35 — prior findings are hypotheses).
  return progress.reFix ? ' RE-FIX ROUND: prior-round findings may ALREADY be addressed in this diff. Re-verify EVERY prior finding against the CURRENT worktree state (grep/read the actual files) before re-asserting it — a finding copied forward without fresh verification is a FALSE CHANGES_REQUIRED. feedback.md in the artifacts dir is the prior round\'s authoritative digest; treat it as the list of things to CHECK, not to repeat.' : '';
}
function voGuardFor(progress) {
  // Parity: factory.js `const voGuard = verificationOnly ? ...` (KI-L55 — the gate's question flips).
  return progress.verificationOnly ? ' VERIFICATION-ONLY ITEM: no fixer ran — the test-author attests the acceptance criterion ALREADY holds on the current tree (stale finding), or the new tests themselves ARE the deliverable (pure test-coverage). Independently verify the ACCEPTANCE against the CURRENT worktree (read the actual wiring, not just the cited lines): if the underlying defect is STILL present, CHANGES_REQUIRED with file:line evidence; if the claim holds, judge the pinning/coverage tests on quality as usual.' : '';
}
function edgeExtraFor(progress) {
  // Parity: factory.js `edgeExtra` (KI-E12 early scan) — methodology line + staleGuard + voGuard +
  // the EARLY SCAN sentence, exactly as the native band composes it (also reused by the P8 re-gate).
  return 'Apply the bmad-review-edge-case-hunter BMAD review methodology to the WORKTREE DIFF only (git -C <worktree> diff). Verdict CHANGES_REQUIRED on any CRITICAL/HIGH you find; APPROVED only if the diff is clean by your lens.' + staleGuardFor(progress) + voGuardFor(progress) + ' EARLY SCAN (pre-band, KI-E12): you run BEFORE the full gate band so unhandled boundaries get fixed cheaply now instead of failing the whole item after the band. Findings-only discipline as usual.';
}

function planNext(progress) {
  const { item, ctx, res, phase } = progress;
  if (phase === 'done') {
    // KI-L48/KI-L40 parity: EVERY terminal outcome (FAILED/BLOCKED/ESCALATED as much as CLOSED) must
    // persist result.json — factory.js checkpoints both resolved AND crashed results the moment they
    // exist; without this an un-folded FAILED run leaves the ledger row CLAIMED forever. Keep
    // returning the mechanical checkpoint step until it has actually been written.
    if (!progress.checkpointed) {
      return { mechanical: 'checkpoint', note: 'terminal state ' + res.toState + ' — result.json not yet persisted. Run: node runtime.mjs mech ' + progress.id + ' checkpoint (then finalize + driver fold)' };
    }
    return { done: true, toState: res.toState, note: res.note, resultPath: `state/items/${progress.id}/result.json` };
  }

  if (phase === 'plan') {
    return agentStep(progress, 'plan', [{ role: 'planner', phaseLabel: 'Plan', schema: 'PLAN_SCHEMA', extra: null }]);
  }
  // KI-E134 — PLAN-DRIFT PREVENTION at the source (ported from factory.js; this runtime has no
  // KI-E69 plan-reuse concept, so every plan call here is inherently "fresh" — no extra guard
  // needed). Routed into by applyPhaseResults' 'plan' case, ONLY when the plan's own approach/
  // blastRadius used commitment language but steps came back missing/under-decomposed.
  if (phase === 'plan-steps-nudge') {
    return agentStep(progress, 'plan-steps-nudge', [{ role: 'planner', phaseLabel: 'Plan', schema: 'PLAN_STEPS_NUDGE_SCHEMA', extra: 'Your own approach/blastRadius above uses commitment language ("MUST" / "required to") describing substantive, checkable work, but you did not decompose it into `steps` (brief point 6) — or decomposed fewer than 2. Re-read that point now. Return ONLY: `steps` — 2-8 ordered, individually checkable one-sentence steps covering the commitments your own approach/blastRadius text just made; leave it empty ONLY if the work is genuinely one atomic edit despite the commitment wording. `note` (required either way) — if steps is non-empty, one sentence is fine; if empty, EXPLICITLY justify why the commitment language does not actually decompose (do not just restate the approach).' }]);
  }
  if (phase === 'test') {
    const reFixNote = progress.reFix ? ' RE-FIX: read the prior feedback (state/items/' + progress.id + '/gate-*.md + review-*.md) and write the red proof for what is STILL broken.' : '';
    // Parity: factory.js redHint's FULL-SUITE BASELINE clause (KI-E43) — the Docker-less environmental
    // baseline is capturable ONLY pre-fix; without it the deterministic fold override false-fails the
    // item against integrate's full suite (cycle 47 ITEM-H15). Incl. the reFix re-capture exception.
    const sln = item.solution || (item.target + ' solution (e.g. ' + item.target + '/' + item.target + '.sln)');
    const baselineHint = ' FULL-SUITE BASELINE (KI-E43): FIRST run `docker info >/dev/null 2>&1; echo exit=$?`. If it FAILS (non-zero — no Docker), the integrate stage\'s full suite will hit pre-existing Docker-unavailable failures that are NOT this fix\'s fault: capture the pre-fix baseline NOW, while the tree is still unfixed — run `' + btFor(ctx) + ' suite ' + sln + ' 2>&1 | tee ' + itemsDirFor(ctx, progress.id) + '/baseline-raw.txt` (ABSOLUTE path) and return baselineFailures = the FAILING test names from that run (exclude your new regression test if it appears). If `docker info` SUCCEEDS, skip the baseline run and omit baselineFailures.'
      + (progress.reFix ? ' RE-FIX EXCEPTION (KI-E43): do NOT re-capture the baseline — this worktree already carries the prior attempt\'s fix, so a capture NOW would launder that fix\'s own breakage into the allowance. The FIRST round\'s baseline-raw.txt (already on disk) stands; a re-captured one is ignored.' : '');
    return agentStep(progress, 'test', [{ role: 'test-author', phaseLabel: 'Test', schema: 'TEST_SCHEMA', extra: 'Write the regression test now, and tee its PRE-FIX run to verify-red-raw.txt via: bash ' + ctx.factoryRoot + '/verify/build-test.sh red <target> "<filter>" | tee ' + itemsDirFor(ctx, progress.id) + '/verify-red-raw.txt' + baselineHint + reFixNote }]);
  }
  if (phase === 'fix') {
    if (progress.verificationOnly) { progress.phase = 'verify'; saveProgress(progress.id, progress); return planNext(progress); }
    const reFixNote = progress.reFix ? ' RE-FIX: read EVERY state/items/' + progress.id + '/gate-*.md + review-*.md carrying a CHANGES_REQUIRED verdict and address EVERY finding.' : '';
    return agentStep(progress, 'fix', [{ role: 'fixer', phaseLabel: 'Fix', schema: 'FIX_SCHEMA', extra: 'Make the red test green now.' + reFixNote }]);
  }
  if (phase === 'verify') {
    return { mechanical: 'verify', note: 'run: node runtime.mjs mech ' + progress.id + ' verify -- <solution-or-project-path> "<dotnet --filter expression>"' };
  }
  if (phase === 'edgescan') {
    if (!progress.res.codeChange) { progress.phase = 'acceptance'; saveProgress(progress.id, progress); return planNext(progress); }
    return agentStep(progress, 'edgescan', [{ role: 'review-edgecase', phaseLabel: 'EdgeScan', schema: 'GATE_SCHEMA', extra: edgeExtraFor(progress) }]);
  }
  if (phase === 'edgescan_amend') {
    return agentStep(progress, 'edgescan_amend', [{ role: 'fixer', phaseLabel: 'EdgeScan', schema: 'FIX_SCHEMA', extra: 'EARLY EDGE-SCAN AMEND: address EVERY finding below with the minimal correct guard, then re-run the targeted build+test. FINDINGS: ' + JSON.stringify((progress.edgeFinal && progress.edgeFinal.findings || []).slice(0, 12)) }]);
  }
  if (phase === 'edgescan_rescan') {
    // Parity: factory.js's rescan call = edgeExtra + the KI-L35 RE-SCAN sentence.
    return agentStep(progress, 'edgescan_rescan', [{ role: 'review-edgecase', phaseLabel: 'EdgeScan', schema: 'GATE_SCHEMA', extra: edgeExtraFor(progress) + ' RE-SCAN: an amend just addressed your prior findings — re-walk the AMENDED diff fresh; prior findings are hypotheses to re-verify (KI-L35), never conclusions to copy forward.' }]);
  }
  if (phase === 'acceptance') {
    const clauses = splitAcceptanceClauses(progress.item.acceptance, 8);
    if (progress.verificationOnly || clauses.length < 2) { progress.phase = 'leftover'; saveProgress(progress.id, progress); return planNext(progress); }
    return agentStep(progress, 'acceptance', [{ role: 'acceptance-probe', phaseLabel: 'EdgeScan', schema: 'ACCEPT_SCHEMA', extra: 'ACCEPTANCE CLAUSE COVERAGE PROBE. Clauses (fail-open on missing verdict, fail-closed on an explicit false): ' + JSON.stringify(clauses) }]);
  }
  if (phase === 'acceptance_amend') {
    return agentStep(progress, 'acceptance_amend', [{ role: 'fixer', phaseLabel: 'EdgeScan', schema: 'FIX_SCHEMA', extra: 'ACCEPTANCE-SCAN AMEND: address EVERY gap below, then re-run the targeted build+test. GAPS: ' + JSON.stringify((progress._acceptGaps || []).slice(0, 8)) }]);
  }
  if (phase === 'acceptance_reprobe') {
    return agentStep(progress, 'acceptance_reprobe', [{ role: 'acceptance-probe', phaseLabel: 'EdgeScan', schema: 'ACCEPT_SCHEMA', extra: 'RE-PROBE the amended diff against the SAME clauses: ' + JSON.stringify(splitAcceptanceClauses(progress.item.acceptance, 8)) }]);
  }
  // KI-E112 — PLAN-COMMITMENT / PLAN-STEP SCAN (KI-E87 + KI-E101), previously UNPORTED. Same two
  // modes and the same bounded amend + one re-probe as canon, sharing one gate key. STEP mode reads
  // the planner's own `steps[]` (which this port already ACCEPTED and validated but never acted on —
  // schemas.mjs said so explicitly); PROSE mode falls back to the deterministic commitment-language
  // prefilter. `progress.plan` is null for a mechanical item (planner skipped), gating this off free.
  if (phase === 'plancommit') {
    const pl = progress.plan;
    if (progress.verificationOnly || !pl) { progress.phase = 'leftover'; saveProgress(progress.id, progress); return planNext(progress); }
    const steps = normalizePlanSteps(pl.steps, 8);
    const commitmentText = (pl.approach || '') + '\n' + (pl.blastRadius || '');
    const stepMode = steps.length >= 2;
    if (!stepMode && !hasPlanCommitmentLanguage(commitmentText)) { progress.phase = 'leftover'; saveProgress(progress.id, progress); return planNext(progress); }
    progress._planStepMode = stepMode;
    const body = stepMode
      ? 'PLAN-STEP SCAN (KI-E101). This item\'s OWN plan decomposed the work into the numbered steps below. Read ' + itemsDirFor(ctx, progress.id) + '/review-pack.md, then for EACH step decide whether the diff carries CONCRETE evidence it was carried out. Judge COVERAGE of the plan\'s own steps, not general quality. honored=true ONLY if EVERY step is evidenced; otherwise honored=false with each un-evidenced step in gaps (quote the step in `commitment`, why in `why`). Do NOT edit anything.\nPLAN STEPS:\n' + steps.map((s, i) => '  ' + (i + 1) + '. ' + s).join('\n')
      : 'PLAN-COMMITMENT SCAN (KI-E87). This item\'s OWN plan stated the commitment language below. Read ' + itemsDirFor(ctx, progress.id) + '/review-pack.md, then for each "MUST"/"required to" commitment decide whether the diff carries CONCRETE evidence it was honored. honored=true ONLY if EVERY commitment is evidenced; otherwise honored=false with each unhonored commitment in gaps. Do NOT edit anything.\nPLAN TEXT:\n' + commitmentText;
    progress._planPrompt = body;
    saveProgress(progress.id, progress);
    return agentStep(progress, 'plancommit', [{ role: 'plan-commitment-probe', phaseLabel: 'EdgeScan', schema: 'PLAN_COMMITMENT_SCHEMA', extra: body }]);
  }
  if (phase === 'plancommit_amend') {
    const axis = progress._planStepMode ? 'plan step' : 'plan commitment';
    return agentStep(progress, 'plancommit_amend', [{ role: 'fixer', phaseLabel: 'EdgeScan', schema: 'FIX_SCHEMA', extra: 'PLAN-COMMITMENT AMEND: a pre-band probe found ' + axis + '(s) your OWN plan made with NO evidence in your diff. Address EVERY gap below with the minimal correct change (or state in note precisely why that ' + axis + ' is already satisfied or no longer applicable), then re-run the targeted build+test and REGENERATE the review pack. GAPS: ' + JSON.stringify((progress._planGaps || []).slice(0, 8)) }]);
  }
  if (phase === 'plancommit_reprobe') {
    return agentStep(progress, 'plancommit_reprobe', [{ role: 'plan-commitment-probe', phaseLabel: 'EdgeScan', schema: 'PLAN_COMMITMENT_SCHEMA', extra: (progress._planPrompt || '') + '\nRE-SCAN: an amend just addressed the prior gaps — judge the AMENDED diff fresh; prior gaps are hypotheses to re-verify, never conclusions to copy forward.' }]);
  }
  // KI-E112 — LEDGER-ANCHOR classify (KI-E91), previously UNPORTED. The mechanical half runs in
  // `mech leftover` (build-test.sh ledger-anchor, engine-owned); this is the STEP-2 classify, exactly
  // mirroring the leftover_classify shape.
  if (phase === 'ledger_anchor_classify') {
    return agentStep(progress, 'ledger_anchor_classify', [{ role: 'ledger-anchor-probe', phaseLabel: 'EdgeScan', schema: 'LEDGER_ANCHOR_SCHEMA', extra: 'Judge each candidate for MATERIAL disagreement (a duplicate anchor whose entries genuinely contradict, or a claimed `standards-evolution:` call-site tag the file does not carry). clean=false only for a real defect. CANDIDATES: ' + JSON.stringify(progress._ledgerAnchorHits || []) }]);
  }
  if (phase === 'leftover') {
    if (!progress.res.codeChange) { progress.phase = 'editorial'; saveProgress(progress.id, progress); return planNext(progress); }
    return { mechanical: 'leftover', note: 'run: node runtime.mjs mech ' + progress.id + ' leftover' };
  }
  if (phase === 'leftover_classify') {
    return agentStep(progress, 'leftover_classify', [{ role: 'leftover-probe', phaseLabel: 'EdgeScan', schema: 'LEFTOVER_SCHEMA', extra: 'Classify each candidate as genuine PUNT vs LEGIT: ' + JSON.stringify(progress._leftoverHits || []) }]);
  }
  if (phase === 'editorial') {
    const flows = flowsFor(progress.item).filter((f) => f.band === 'editorial');
    if (!flows.length) { progress.phase = 'gates'; saveProgress(progress.id, progress); return planNext(progress); }
    // Parity: factory.js's editorial call extra — advisory + don't-break-the-delivered-test +
    // KI-E11 claims lint + KI-L34 pack regeneration, verbatim-adapted to this ctx.
    const wtPath = ctx.worktreePath;
    const packCmd = btFor(ctx) + ' pack ' + wtPath + ' ' + itemsDirFor(ctx, progress.id) + '/review-pack.md';
    const editorialExtra = 'Advisory editorial pass; apply doc fixes in the worktree but NEVER block the item. Do NOT break the delivered regression test (re-run it if you change anything it asserts on). If you changed ANY .md prose, run the claims lint `' + btFor(ctx) + ' claims ' + wtPath + '` and fix any FACTORY::CLAIMS-MISS your edits introduced (KI-E11). If you changed ANY file, REGENERATE the review pack as your LAST Bash action so the gate band reviews the FINAL diff (KI-L34): `' + packCmd + '`.';
    return agentStep(progress, 'editorial', flows.map((f) => ({ role: routingRoleFor(f), phaseLabel: 'Verify', schema: 'GATE_SCHEMA', extra: editorialExtra, routeKey: f.routeKey })));
  }
  if (phase === 'gates') {
    const gateRoles = gateRolesFor(progress.item, progress.band, configuredGateSet()).filter((g) => g !== 'po');
    const methodFlows = flowsFor(progress.item).filter((f) => f.band === 'method' && f.blocking && !(progress.edgeFinal && f.routeKey === 'review.edgecase'));
    // Parity: factory.js's gate band extras — tech gates carry (staleGuard + voGuard) || null; method
    // review flows carry the methodology line + both guards.
    const guards = staleGuardFor(progress) + voGuardFor(progress);
    const calls = gateRoles.map((g) => ({ role: 'gate-' + g, phaseLabel: 'Gates', schema: 'GATE_SCHEMA', extra: guards || null }))
      .concat(methodFlows.map((f) => ({ role: routingRoleFor(f), phaseLabel: 'Gates', schema: 'GATE_SCHEMA', extra: 'Apply the ' + f.skill + ' BMAD review methodology to the WORKTREE DIFF only (git -C <worktree> diff). Verdict CHANGES_REQUIRED on any CRITICAL/HIGH you find; APPROVED only if the diff is clean by your lens.' + guards, routeKey: f.routeKey })));
    return agentStep(progress, 'gates', calls);
  }
  if (phase === 'gates_adjudicate') {
    return agentStep(progress, 'gates_adjudicate', [{ role: 'adjudicator', phaseLabel: 'Gates', schema: 'ADJUDICATE_SCHEMA', extra: progress._adjudicateExtra }]);
  }
  if (phase === 'gates_regate') {
    return agentStep(progress, 'gates_regate', progress._regateCalls);
  }
  if (phase === 'po') {
    return agentStep(progress, 'po', [{ role: 'gate-po', phaseLabel: 'Gates', schema: 'GATE_SCHEMA', extra: null }]);
  }
  if (phase === 'escalatecheck') {
    // Deterministic — no agent call, just a branch. Parity: factory.js runs this check AFTER the
    // refute + re-audit pass (`// 8. escalate-tier stops here for human sign-off`, factory.js ~958-961,
    // between REAUDITED and the Integrate phase) — so a parked ESCALATED item genuinely carries
    // REFUTE_OK + REAUDITED and its "auto-drafted + fully verified" note is true. This port previously
    // parked BEFORE refute/re-audit, which shipped un-refuted escalations under a "fully verified" note.
    if (progress.item.autonomyTier === 'escalate' || progress._escalate) {
      finish(progress, 'ESCALATED', 'auto-drafted + fully verified; awaiting human sign-off before integrate (blast-radius)');
      saveProgress(progress.id, progress);
      return planNext(progress);
    }
    progress.phase = 'integrate';
    saveProgress(progress.id, progress);
    return planNext(progress);
  }
  if (phase === 'refute_reaudit') {
    const flows = flowsFor(progress.item);
    const refuteCovered = progress.band === 'LIGHT' && !progress.res.needsRealInfra && flows.some((f) => f.routeKey === 'review.adversarial' || f.routeKey === 'review.edgecase');
    const calls = [];
    if (!refuteCovered) calls.push({ role: 'refuter', phaseLabel: 'Refute+Re-audit', schema: 'REFUTE_SCHEMA', extra: null });
    const lenses = progress.band === 'LIGHT' ? ['code'] : reauditLenses(progress.item);
    // Parity: factory.js's re-auditor call extra (scoped lens mandate), not a bare "LENS:" tag.
    for (const lens of lenses) calls.push({ role: 're-auditor', phaseLabel: 'Refute+Re-audit', schema: 'REAUDIT_SCHEMA', extra: 'Apply the ' + lens + ' audit lens ONLY, scoped to the worktree diff + its immediate blast radius. Confirm the ORIGINAL finding is gone (cite the now-correct file:line, not the test) AND that THIS lens finds no new CRITICAL/HIGH in the change.', lens });
    return agentStep(progress, 'refute_reaudit', calls);
  }
  if (phase === 'integrate') {
    return { mechanical: 'integrate', note: 'run: node runtime.mjs mech ' + progress.id + ' integrate' };
  }
  if (phase === 'integrate_judge') {
    return agentStep(progress, 'integrate_judge', [{ role: 'integrator', phaseLabel: 'Integrate', schema: 'INTEG_SCHEMA', extra: null }]);
  }
  if (phase === 'checkpoint') {
    return { mechanical: 'checkpoint', note: 'run: node runtime.mjs mech ' + progress.id + ' checkpoint' };
  }
  if (phase === 'decision_frame') {
    return agentStep(progress, 'decision_frame', [{ role: 'decision-framer', phaseLabel: 'Plan', schema: 'DECISION_SCHEMA', extra: 'This item is BLOCKED (cannot be auto-resolved without an owner ruling): ' + progress._blockReason + '. Frame the decision for the human queue: the specific question, 2-4 options each with its consequence, and a recommendation.' }]);
  }
  throw new Error('unknown phase: ' + phase);
}

function routingRoleFor(flow) {
  const map = { 'bmad-code-review': 'review-code', 'bmad-review-adversarial-general': 'review-adversarial', 'bmad-review-edge-case-hunter': 'review-edgecase', 'bmad-testarch-test-review': 'review-testreview', 'bmad-editorial-review-structure': 'review-editorial-structure', 'bmad-editorial-review-prose': 'review-editorial-prose' };
  return map[flow.skill] || flow.routeKey;
}

// Build the agent-step response: composes each call's prompt, records a pendingSet the controller
// must fully satisfy (via `submit --role <key>`) before `next` advances past this phase.
//
// `key` (NOT `role`) is the unique identity submit tracks — most phases have one call per role so
// key===role, but refute_reaudit dispatches MULTIPLE `re-auditor` calls (one per lens); without a
// distinct key they'd collide on the same `received['re-auditor']` slot and the phase would
// (incorrectly) look complete after the FIRST lens landed. `key = lens ? role:lens : role`.
function agentStep(progress, phaseKey, calls) {
  for (const c of calls) c.key = c.lens ? c.role + ':' + c.lens : c.role;
  const keys = calls.map((c) => c.key);
  // `next` is documented idempotent (safe to re-run after a crash/resume). Install a FRESH pendingSet
  // ONLY when none exists for the CURRENT phase — re-printing the prompts must never reset `received`
  // (previously every `next` at a pooled phase overwrote received:{} and destroyed already-submitted
  // verdicts). A pendingSet from a PRIOR phase never survives here: submit/mech clear it on advance.
  if (!progress.pendingSet || progress.pendingSet.phaseKey !== phaseKey) {
    progress.pendingSet = { phaseKey, keys, received: {}, calls };
    saveProgress(progress.id, progress);
  }
  const received = progress.pendingSet.received || {};
  const outstanding = keys.filter((k) => !(k in received));
  return {
    agents: calls.map((c) => ({
      role: c.role,
      key: c.key,
      phase: c.phaseLabel,
      schema: c.schema,
      prompt: compose(c.role, progress.item, c.extra, progress.ctx),
    })),
    pendingKeys: outstanding, // keys still awaiting a submit (already-received ones survive a re-printed next)
    note: calls.length > 1
      ? `Dispatch ALL ${calls.length} of these via your Task tool in a SINGLE message (they are independent — this mirrors factory.js's Promise.all pooling), then submit each with: node runtime.mjs submit ${progress.id} --role <key> --json <file>  (use the "key" field, NOT "role" — they differ when multiple calls share a role, e.g. re-auditor lenses)${outstanding.length < keys.length ? ` — ${keys.length - outstanding.length} already submitted; still pending: ${outstanding.join(', ') || '(none)'}` : ''}`
      : `Dispatch this via your Task tool, then: node runtime.mjs submit ${progress.id} --role ${keys[0]} --json <file>`,
  };
}

// ---------------------------------------------------------------------------------------------
// submit — ingest one agent's structured JSON result for the currently pending phase/role.
// ---------------------------------------------------------------------------------------------
function cmdSubmit(id, flags) {
  const progress = loadProgress(id);
  const key = flags.role; // see agentStep doc-comment: this is the CALL KEY, not always the bare role name
  if (!key) throw new Error('submit requires --role <key> (the "key" field next printed, e.g. "re-auditor:code")');
  // Stale-replay guard: once a phase completes, its pendingSet is CLEARED (see the applyPhaseResults
  // call below) — a duplicate `submit --role <old key>` therefore lands here and is REJECTED loudly
  // with NO state change, instead of re-running the old phase's side effects (a live probe drove an
  // accepted item to FAILED by re-submitting the fixer at the verify step).
  if (!progress.pendingSet || !progress.pendingSet.keys.includes(key)) {
    throw new Error(`no pending call for key "${key}" in phase "${progress.phase}" (pending: ${progress.pendingSet ? progress.pendingSet.keys.join(', ') : 'none — this phase has no open agent calls; a stale re-submit of a completed phase is rejected'}) — call next first`);
  }
  const call = progress.pendingSet.calls.find((c) => c.key === key);
  const raw = flags.json === '-' ? readAllStdin() : readFileSync(flags.json, 'utf8');
  let parsed;
  try { parsed = extractJson(raw); } catch (e) { throw new Error('could not parse JSON from --json input: ' + e.message); }
  const v = validateNamed(call.schema, parsed);
  if (!v.ok) {
    console.error('VALIDATION FAILED for ' + key + ' against ' + call.schema + ':');
    for (const e of v.errors) console.error('  - ' + e);
    process.exitCode = 1;
    return;
  }
  progress.pendingSet.received[key] = parsed;
  // Record actual-model-used cost tally under a clearly-labeled bucket (KI-O1: not the RT-intended tier).
  progress.res.cost['opencode-session-model'] = (progress.res.cost['opencode-session-model'] || 0) + 1;
  const allIn = progress.pendingSet.keys.every((k) => k in progress.pendingSet.received);
  log(`submit: ${key} recorded for phase ${progress.phase} (${Object.keys(progress.pendingSet.received).length}/${progress.pendingSet.keys.length})`);
  if (!allIn) { saveProgress(id, progress); return; }
  // All pending keys in — write artifacts + apply phase-specific side effects, then advance.
  applyPhaseResults(progress);
  // Phase advanced (or finished): CLEAR the satisfied pendingSet so it can never be replayed. The
  // chained cmdNext below re-arms a fresh pendingSet for the NEW phase when it is an agent step.
  progress.pendingSet = null;
  saveProgress(id, progress);
  log('phase complete -> advancing. next:');
  cmdNext(id);
}

function readAllStdin() {
  try { return readFileSync(0, 'utf8'); } catch { throw new Error('no stdin available; pass a file path to --json instead of -'); }
}
// Agents are asked to end with a fenced ```json block (compose.mjs's FINAL ANSWER FORMAT line) —
// accept either a bare JSON document or one wrapped in a fence / surrounding prose. The prompt
// contract is "END your response with a single fence", and agents routinely QUOTE example JSON in
// their reasoning before the real final answer (a live probe recorded a quoted example as the
// verdict and set `_escalate` from it) — so take the LAST fenced block that parses as JSON, never
// the first. A fenced block that does not parse is skipped in favour of an earlier parseable one;
// if no fence parses, fall back to parsing the whole payload as bare JSON.
export function extractJson(raw) {
  const fences = [...String(raw).matchAll(/```(?:json)?[^\S\n]*\n?([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try { return JSON.parse(fences[i][1].trim()); } catch { /* not this fence — try the previous one */ }
  }
  return JSON.parse(String(raw).trim());
}

function writeArtifact(progress, key, filename, content) {
  const dir = itemsDirFor(progress.ctx, progress.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  progress.res.artifacts[key] = `state/items/${progress.id}/${filename}`;
}

function detail(role, r) {
  return { verdict: r.verdict, headline: r.headline, findings: (r.findings || []).slice(0, 12), acceptanceMet: r.acceptanceMet, redGreenConfirmed: r.redGreenConfirmed };
}

// KI-E103 — byte-parity with factory.js's acceptance-scan gateDetails shape (factory.js: the
// `res.gateDetails['probe:acceptance-scan'] = {verdict, headline, findings}` literal). This port used
// to store the probe's RAW `{covered, gaps}` return instead, which is not the shape ANY consumer
// reads: `lib/feedback.mjs` renders `d.verdict` (-> the reFix digest printed
// "## probe:acceptance-scan - undefined") and iterates `d.findings` (-> every un-evidenced clause was
// silently DROPPED from feedback.md, the KI-L31 authoritative channel a reFix reads FIRST). So the
// port detected acceptance gaps correctly and then threw the actionable detail away.
function acceptanceDetail(ac) {
  const covered = ac.covered !== false;
  const gaps = ac.gaps || [];
  return {
    verdict: covered ? 'APPROVED' : 'CHANGES_REQUIRED',
    headline: covered ? 'every acceptance clause evidenced in the diff' : (gaps.length + ' acceptance clause(s) with NO evidence in the diff'),
    findings: gaps.slice(0, 12).map((g) => ({ severity: 'HIGH', title: 'un-evidenced acceptance clause: ' + String(g.clause || '').slice(0, 140), fix: String(g.why || '') })),
  };
}

// Phase-specific side effects once ALL pending roles for the current phase are in. Mirrors the
// relevant slice of factory.js's runItem for each phase, then sets progress.phase to the next step.
function applyPhaseResults(progress) {
  const id = progress.id;
  const recv = progress.pendingSet.received;
  const phaseKey = progress.pendingSet.phaseKey;

  if (phaseKey === 'plan') {
    const plan = recv['planner'];
    writeArtifact(progress, 'plan', 'plan.md', '# Plan\n\n' + JSON.stringify(plan, null, 2));
    if (plan.recommendScopeStop) return frameAndBlock(progress, 'planner recommended scope-stop: ' + plan.rootCause);
    if (plan.recommendEscalate) progress._escalate = true;
    // KI-E112: retain the plan so the pre-band plan-commitment/plan-step scan can read its own
    // approach/blastRadius/steps against the FINAL diff — the same reason factory.js hoists `plan`
    // to function scope (KI-E87). Without this the scan has nothing to check and silently no-ops.
    progress.plan = plan;
    // KI-E103: this used to `progress.res.rootCauseFiles = plan.files` — a divergence from factory.js
    // (which NEVER reassigns it) that also contradicted this file's own cmdInit comment. rootCauseFiles
    // is computed once at claim time from the item's DECLARED files[] (see cmdInit) because the fold's
    // P9 check asserts the fixer actually touched a declared root-cause file; letting the planner's
    // self-reported `files` overwrite it means the port graded the diff against the planner's own
    // opinion of scope rather than the work item's, which is exactly the self-certification P9 exists
    // to prevent. plan.files stays informational (it is written into plan.md above).
    // KI-E134 — PLAN-DRIFT PREVENTION at the source (ported from factory.js). A plan whose OWN
    // approach/blastRadius uses commitment language ("MUST"/"required to") describes substantive,
    // checkable work — but if `steps` is missing/under-decomposed, that work never gets machine-
    // checked against the diff (PROSE mode's hasPlanCommitmentLanguage prefilter is a coarser
    // keyword heuristic than STEP mode's per-step evidence check). Route to ONE cheap bounded
    // follow-up instead of advancing straight to 'test'; skipped entirely for the common case (no
    // commitment language, or steps already present) — zero extra cost there.
    if (normalizePlanSteps(plan.steps).length < 2 && hasPlanCommitmentLanguage((plan.approach || '') + ' ' + (plan.blastRadius || ''))) {
      progress.phase = 'plan-steps-nudge';
      return;
    }
    progress.phase = 'test';
    return;
  }
  if (phaseKey === 'plan-steps-nudge') {
    const nudge = recv['planner'];
    if (nudge && Array.isArray(nudge.steps) && normalizePlanSteps(nudge.steps).length >= 2) {
      progress.plan = Object.assign({}, progress.plan, { steps: nudge.steps });
      writeArtifact(progress, 'plan', 'plan.md', '# Plan\n\n' + JSON.stringify(progress.plan, null, 2) + '\n\n## Steps nudge (KI-E134)\n\n' + (nudge.note || ''));
    }
    progress.phase = 'test';
    return;
  }
  if (phaseKey === 'test') {
    const test = recv['test-author'];
    writeArtifact(progress, 'test', 'test.json', test);
    progress.verificationOnly = !!(test.verificationOnly === true && !test.red);
    progress.res.verificationOnly = progress.verificationOnly;
    if (Array.isArray(test.baselineFailures)) progress.res.baselineFailures = test.baselineFailures;
    // P10 parity (factory.js `const codeChange = filesHaveCs || test.testFiles.some(.cs)`): a
    // doc/config item whose test-author shipped a real .cs regression test MUST still build+run it —
    // widen codeChange so the later mech gates (verify build+filter, edgescan, comment/leftover
    // scans, integrate build+suite) treat it as a code item. needsRealInfra deliberately stays keyed
    // on filesHaveCs only (KI-L45 — a .cs TEST on a doc fix must not drag in a container demand).
    if (Array.isArray(test.testFiles) && test.testFiles.some((f) => /\.cs$/i.test(f))) progress.res.codeChange = true;
    if (!test.red && !progress.verificationOnly) { finish(progress, 'FAILED', 'no red proof (verify-red-raw.txt) — test-author must prove the regression test fails on old code'); return; }
    progress.res.transitions.push('RED');
    progress.phase = 'fix';
    return;
  }
  if (phaseKey === 'fix') {
    const fix = recv['fixer'];
    writeArtifact(progress, 'fix', 'fix.json', fix);
    if (fix.scopeStop) return frameAndBlock(progress, 'fixer scope-stop: ' + fix.summary);
    if (!fix.applied) { finish(progress, 'FAILED', 'fixer did not apply a fix: ' + fix.summary); return; }
    progress.phase = 'verify';
    return;
  }
  if (phaseKey === 'edgescan') {
    const scan = recv['review-edgecase'];
    writeArtifact(progress, 'review:review-edge-case-hunter', 'review-edgecase.md', '# EdgeScan\n\n' + JSON.stringify(scan, null, 2));
    progress.res.gates['review:review-edge-case-hunter'] = scan.verdict;
    progress.res.gateDetails['review:review-edge-case-hunter'] = detail('review-edgecase', scan);
    progress.edgeFinal = scan;
    if (scan.verdict === 'CHANGES_REQUIRED' && (scan.findings || []).length && !progress.verificationOnly) { progress.phase = 'edgescan_amend'; return; }
    progress.phase = 'acceptance';
    return;
  }
  if (phaseKey === 'edgescan_amend') {
    const amend = recv['fixer'];
    writeArtifact(progress, 'edgescan-amend', 'edgescan-amend.json', amend);
    if (amend.scopeStop) return frameAndBlock(progress, 'edge-scan amend scope-stop: ' + amend.summary);
    if (amend.applied) { progress.phase = 'edgescan_rescan'; return; }
    progress.phase = 'acceptance'; // amend not applied -> keep the original edgeFinal, proceed (factory.js: amend&&applied gate)
    return;
  }
  if (phaseKey === 'edgescan_rescan') {
    const rescan = recv['review-edgecase'];
    writeArtifact(progress, 'review:review-edge-case-hunter', 'review-edgecase.md', '# EdgeScan (re-scan)\n\n' + JSON.stringify(rescan, null, 2));
    progress.edgeFinal = rescan; // final, spliced into the gate band as-is (factory.js: whatever it is now is final)
    progress.res.gates['review:review-edge-case-hunter'] = rescan.verdict;
    progress.res.gateDetails['review:review-edge-case-hunter'] = detail('review-edgecase', rescan);
    progress.phase = 'acceptance';
    return;
  }
  if (phaseKey === 'acceptance') {
    const ac = recv['acceptance-probe'];
    // KI-E103: record the gate on BOTH outcomes. factory.js writes res.gates unconditionally
    // (factory.js: `res.gates['probe:acceptance-scan'] = ac.covered ? 'APPROVED' : 'CHANGES_REQUIRED'`);
    // this port only wrote it on the reprobe path, so a first-pass covered:true recorded NO gate at
    // all — the probe ran, passed, and left no evidence it had ever run in the folded result.
    progress.res.gates['probe:acceptance-scan'] = ac.covered === false ? 'CHANGES_REQUIRED' : 'APPROVED';
    progress.res.gateDetails['probe:acceptance-scan'] = acceptanceDetail(ac);
    if (ac.covered === false) {
      progress._acceptGaps = ac.gaps || [];
      progress.phase = 'acceptance_amend';
      return;
    }
    progress.phase = 'plancommit';
    return;
  }
  if (phaseKey === 'acceptance_amend') {
    const amend = recv['fixer'];
    writeArtifact(progress, 'acceptance-amend', 'acceptance-amend.json', amend);
    if (amend.scopeStop) return frameAndBlock(progress, 'acceptance-scan amend scope-stop: ' + amend.summary);
    progress.phase = 'acceptance_reprobe';
    return;
  }
  if (phaseKey === 'acceptance_reprobe') {
    const re = recv['acceptance-probe'];
    progress.res.gates['probe:acceptance-scan'] = re.covered === false ? 'CHANGES_REQUIRED' : 'APPROVED';
    progress.res.gateDetails['probe:acceptance-scan'] = acceptanceDetail(re);
    if (typeof re.covered === 'boolean' && re.covered === false) {
      const gapNote = (re.gaps || []).map((g) => g.clause).join('; ');
      finish(progress, 'FAILED', 'acceptance-scan: acceptance clause(s) with NO evidence in the diff after one bounded amend — ' + gapNote);
      return;
    }
    progress.phase = 'plancommit';
    return;
  }
  // KI-E112 — plan-commitment / plan-step trio (KI-E87 + KI-E101), mirroring the acceptance trio
  // above: one probe, ONE bounded amend, one re-probe whose verdict is final. Both modes share the
  // `probe:plan-commitment-scan` gate key (canon does too — a second key would orphan the
  // telemetry/recover/feedback consumers already reading it), with the mode stamped in the headline.
  const planAxis = () => (progress._planStepMode ? 'plan step' : 'plan commitment');
  const planDetail = (pc) => {
    const honored = pc.honored !== false;
    const gaps = pc.gaps || [];
    return {
      verdict: honored ? 'APPROVED' : 'CHANGES_REQUIRED',
      headline: (honored ? 'every ' + planAxis() + ' evidenced in the diff' : gaps.length + ' ' + planAxis() + '(s) with NO evidence in the diff') + ' [' + (progress._planStepMode ? 'STEP' : 'PROSE') + ' mode]',
      findings: gaps.slice(0, 12).map((g) => ({ severity: 'HIGH', title: 'unhonored ' + planAxis() + ': ' + String(g.commitment || '').slice(0, 140), fix: String(g.why || '') })),
    };
  };
  if (phaseKey === 'plancommit') {
    const pc = recv['plan-commitment-probe'];
    progress.res.gates['probe:plan-commitment-scan'] = pc.honored === false ? 'CHANGES_REQUIRED' : 'APPROVED';
    progress.res.gateDetails['probe:plan-commitment-scan'] = planDetail(pc);
    if (pc.honored === false && (pc.gaps || []).length) { progress._planGaps = pc.gaps; progress.phase = 'plancommit_amend'; return; }
    progress.phase = 'leftover';
    return;
  }
  if (phaseKey === 'plancommit_amend') {
    const amend = recv['fixer'];
    writeArtifact(progress, 'plancommit-amend', 'plancommit-amend.json', amend);
    if (amend.scopeStop) return frameAndBlock(progress, 'fixer scope-stop during plan-commitment amend: ' + amend.summary);
    progress.phase = 'plancommit_reprobe';
    return;
  }
  if (phaseKey === 'plancommit_reprobe') {
    const re = recv['plan-commitment-probe'];
    progress.res.gates['probe:plan-commitment-scan'] = re.honored === false ? 'CHANGES_REQUIRED' : 'APPROVED';
    progress.res.gateDetails['probe:plan-commitment-scan'] = planDetail(re);
    if (re.honored === false) {
      const gapNote = (re.gaps || []).slice(0, 6).map((g) => String(g.commitment || '').slice(0, 90)).join(' | ');
      finish(progress, 'FAILED', 'plan-commitment-scan (' + (progress._planStepMode ? 'KI-E101 STEP mode' : 'KI-E87 PROSE mode') + '): the plan\'s own ' + planAxis() + '(s) have NO evidence in the diff after one bounded amend — ' + (gapNote || 'see gateDetails') + '. Pre-band fail; the fix must cover every ' + planAxis() + ' the plan itself laid out.');
      return;
    }
    progress.phase = 'leftover';
    return;
  }
  // KI-E112 — ledger-anchor classify (KI-E91). Mechanical candidates come from `mech leftover`.
  if (phaseKey === 'ledger_anchor_classify') {
    const la = recv['ledger-anchor-probe'];
    writeArtifact(progress, 'probe:ledger-anchor', 'ledger-anchor-classify.json', la);
    if (la.clean === false) {
      progress.res.gates['probe:ledger-anchor'] = 'CHANGES_REQUIRED';
      const f = (la.findings || []).slice(0, 5).map((x) => `${x.anchor} (${x.file}): ${x.why}`);
      finish(progress, 'FAILED', 'ledger-anchor scan (KI-E91): ' + f.join(' | '));
      return;
    }
    progress.res.gates['probe:ledger-anchor'] = 'APPROVED';
    progress.phase = 'editorial';
    return;
  }
  if (phaseKey === 'leftover_classify') {
    const cls = recv['leftover-probe'];
    writeArtifact(progress, 'probe:leftover-scan', 'leftover-classify.json', cls);
    if (cls.clean === false) {
      const punts = (cls.punts || []).map((p) => `${p.file}:${p.line} ${p.why}`).join('; ');
      finish(progress, 'FAILED', 'leftover-scan: fixer-introduced deferral(s)/tech-debt not ledgered — ' + punts);
      return;
    }
    progress.res.gates['probe:leftover-scan'] = 'APPROVED';
    // KI-E112: the ledger-anchor scan (KI-E91) runs AFTER the leftover scan, mirroring canon's order.
    progress.phase = ledgerAnchorNext(progress, itemsDirFor(progress.ctx, progress.id));
    return;
  }
  if (phaseKey === 'editorial') {
    for (const [role, r] of Object.entries(recv)) {
      const call = progress.pendingSet.calls.find((c) => c.role === role);
      const key = 'editorial:' + role.replace(/^review-editorial-/, '');
      writeArtifact(progress, key, role + '.md', '# ' + role + ' (ADVISORY)\n\n' + JSON.stringify(r, null, 2));
      progress.res.gates[key] = r.verdict;
      progress.res.gateDetails[key] = { ...detail(role, r), advisory: true };
    }
    progress.phase = 'gates';
    return;
  }
  if (phaseKey === 'gates' || phaseKey === 'gates_regate') {
    const failed = [];
    let bandSize = Object.keys(recv).length;
    for (const [role, r] of Object.entries(recv)) {
      const isGate = role.startsWith('gate-');
      const key = isGate ? 'gate:' + role.slice(5) : 'review:' + reverseRoleKey(role);
      const fname = role + '.md';
      writeArtifact(progress, key, fname, '# ' + role + (phaseKey === 'gates_regate' ? ' (RE-GATE)' : '') + '\n\n' + JSON.stringify(r, null, 2));
      const scopeViolationIgnored = r.scopeViolation === true && r.verdict === 'APPROVED';
      if (r.scopeViolation === true && r.verdict !== 'APPROVED') { return frameAndBlock(progress, `${role} scopeViolation: ${r.headline}`); }
      progress.res.gates[key] = r.verdict;
      // KI-E103: a P8 re-gate must NOT destroy the original dissent's structured detail. factory.js
      // records the re-gate under a DISTINCT `<key>:re-gate` entry and leaves the original standing;
      // `lib/recover.mjs` filters `:re-gate` rows precisely because it expects BOTH to exist (the
      // original is what `dissentersFrom` reads to scaffold a delta re-gate prompt). This port
      // overwrote the original key on the second pass, so after an OVERRULED adjudication the reason
      // the gate ever dissented was gone from the folded result.
      progress.res.gateDetails[phaseKey === 'gates_regate' ? key + ':re-gate' : key] = { ...detail(role, r), ...(scopeViolationIgnored ? { scopeViolationIgnored: true } : {}) };
      // Keep the ORIGINAL call extra so a P8 re-gate re-runs the dissenting reviewer with the same
      // brief factory.js re-composes (its `b.extra` rides into the re-gate call).
      const srcCall = (progress.pendingSet.calls || []).find((c) => c.key === role);
      if (r.verdict !== 'APPROVED') failed.push({ role, key, r, extra: (srcCall && srcCall.extra) || null });
    }
    if (phaseKey === 'gates_regate') {
      if (failed.length) { finish(progress, 'FAILED', 'adjudicator OVERRULED but the re-gate still not APPROVED: ' + failed.map((f) => f.key).join(', ')); return; }
      return nextAfterGateBand(progress);
    }
    // KI-E12 parity (factory.js: `if (edgeFinal) { blocking.push({key:'review:review-edge-case-hunter',...}); brRes.push(edgeFinal) }`):
    // the early edge-scan's FINAL verdict JOINS the band's blocking verdict set — a standing
    // CHANGES_REQUIRED edge verdict feeds the same failed/adjudication/re-gate path as a failed
    // gate, and an edge scopeViolation gets the same hard-stop treatment as an in-band one.
    // (This port previously recorded edgeFinal in res.gates but computed `failed` from the gates
    // phase's own received verdicts only, so a standing CR edge verdict could reach CLOSED.)
    if (progress.edgeFinal) {
      const ef = progress.edgeFinal;
      bandSize += 1;
      if (ef.scopeViolation === true && ef.verdict !== 'APPROVED') { return frameAndBlock(progress, `review-edgecase scopeViolation: ${ef.headline}`); }
      if (ef.verdict !== 'APPROVED') failed.push({ role: 'review-edgecase', key: 'review:review-edge-case-hunter', r: ef, extra: edgeExtraFor(progress) });
    }
    if (!failed.length) { return nextAfterGateBand(progress); }
    const heavy = progress.item.severity === 'CRITICAL' || progress.item.severity === 'HIGH';
    const disputed = heavy && failed.length < bandSize; // factory.js also requires failed > nullBlk — this port has no null verdicts (every key needs a real submit)
    if (!disputed) { finish(progress, 'FAILED', 'review(s) not APPROVED: ' + failed.map((f) => f.key).join(', ')); return; }
    const securityDissent = failed.some((f) => f.key === 'gate:security' || f.key === 'review:review-security');
    const securityCrit = progress.item.severity === 'CRITICAL' && (progress.item.theme === 'security-multitenancy' || /crypto|secret|token|auth|tls|pii/i.test(progress.item.theme + ' ' + (progress.item.title || '')));
    if (securityDissent && securityCrit) { finish(progress, 'FAILED', 'security gate dissented on a security/crypto CRITICAL — non-adjudicable'); return; }
    progress._adjudicateExtra = 'DISPUTED ' + progress.item.severity + ': review(s) [' + failed.map((f) => f.key).join(', ') + '] returned CHANGES_REQUIRED while ' + (bandSize - failed.length) + ' other(s) APPROVED the SAME diff. Adjudicate on the merits of the worktree diff: is the fix genuinely defective (UPHELD -> back to the fixer) or were the dissenting review(s) wrong (OVERRULED -> the fix proceeds)? WRITE state/items/' + id + '/adjudication.md.';
    progress._failedForRegate = failed.map((f) => ({ role: f.role, key: f.key, extra: f.extra }));
    progress.phase = 'gates_adjudicate';
    return;
  }
  if (phaseKey === 'gates_adjudicate') {
    const adj = recv['adjudicator'];
    writeArtifact(progress, 'adjudication', 'adjudication.md', '# Adjudication\n\n' + JSON.stringify(adj, null, 2));
    progress.res.gates['adjudicator'] = adj.verdict;
    // KI-E103: factory.js also records the adjudicator's structured detail. Without it the
    // adjudicator's headline + reasons — the ONLY narrative explaining why a disputed CRITICAL/HIGH
    // was overruled or upheld — never reached feedback.md (`lib/feedback.mjs` renders both
    // `d.headline` and `d.reasons`), so a reFix read "adjudicator: UPHELD" with no stated grounds.
    progress.res.gateDetails['adjudicator'] = { verdict: adj.verdict, headline: adj.headline, reasons: Array.isArray(adj.reasons) ? adj.reasons : [] };
    if (adj.verdict !== 'OVERRULED') { finish(progress, 'FAILED', 'review(s) not APPROVED + adjudicator ' + adj.verdict + ': ' + progress._failedForRegate.map((f) => f.key).join(', ')); return; }
    // P8: re-run the dissenting gate(s) once against the unchanged diff. Parity: factory.js composes
    // `(b.extra || 'Re-gate this worktree diff.') + ' RE-GATE: ...'` — original brief + the mandate.
    const calls = progress._failedForRegate.map((f) => ({ role: f.role, phaseLabel: 'Gates', schema: 'GATE_SCHEMA', extra: (f.extra || 'Re-gate this worktree diff.') + ' RE-GATE: adjudication OVERRULED the prior dissent as wrong-on-the-merits; judge the SAME diff strictly and independently. APPROVED only if it is genuinely clean by your lens.' }));
    progress._regateCalls = calls;
    progress.phase = 'gates_regate';
    return;
  }
  if (phaseKey === 'po') {
    const po = recv['gate-po'];
    writeArtifact(progress, 'gate:po', 'gate-po.md', '# PO Gate\n\n' + JSON.stringify(po, null, 2));
    progress.res.gates['gate:po'] = po.verdict;
    progress.res.gateDetails['gate:po'] = detail('gate-po', po);
    if (po.verdict !== 'APPROVED') { finish(progress, 'FAILED', 'PO gate not APPROVED: ' + po.headline); return; }
    progress.res.transitions.push('GATED');
    progress.phase = 'refute_reaudit'; // escalate check runs AFTER refute+re-audit pass (factory.js ~958) — see planNext 'escalatecheck'
    return;
  }
  if (phaseKey === 'refute_reaudit') {
    let refuted = false;
    for (const [role, r] of Object.entries(recv)) {
      if (role === 'refuter') {
        writeArtifact(progress, 'refute', 'refute.md', '# Refute\n\n' + JSON.stringify(r, null, 2));
        if (r.refuted === true) refuted = true;
      }
    }
    if (refuted) { finish(progress, 'FAILED', 'refuted: ' + (recv['refuter'] && recv['refuter'].headline)); return; }
    // KI-E103: REFUTE_OK is pushed HERE — the moment the refuter passes — matching factory.js, which
    // pushes it before the lens-convergence check. This port used to push it only alongside REAUDITED
    // after ALL lenses converged, so a refuter-passed/lens-failed item ended its transitions at GATED.
    // `lib/recover.mjs missingStageFrom()` keys the "only the re-auditor is missing" recovery scaffold
    // on `last === 'REFUTE_OK'`, so that shape could never be auto-scaffolded from a port result.
    progress.res.transitions.push('REFUTE_OK');
    const reauditEntries = progress.pendingSet.calls.filter((c) => c.role === 're-auditor');
    // recv is keyed by the unique call `key` (see agentStep) — each lens's key is `re-auditor:<lens>`,
    // never bare `re-auditor`, so lookups below never collide across lenses.
    let allConverged = true;
    const lensNotes = [];
    for (const c of reauditEntries) {
      const key = 're-auditor:' + c.lens;
      const r = recv[key];
      if (!r) { allConverged = false; lensNotes.push(c.lens + ': NULL'); continue; }
      writeArtifact(progress, 'reaudit:' + c.lens, 'reaudit-' + c.lens + '.md', '# Re-audit (' + c.lens + ')\n\n' + JSON.stringify(r, null, 2));
      if (!r.converged) { allConverged = false; lensNotes.push(c.lens + ': not converged — ' + r.headline); }
    }
    // KI-E103: the per-lens roll-up gate factory.js records as `res.gates['reaudit'] = 'code=ok
    // edge-case=no …'`. Absent here entirely, which broke two independent consumers: `lib/recover.mjs
    // missingStageFrom()` reads the recorded string to derive WHICH lens set a recovery must re-run
    // (it parses e.g. "code=NULL" rather than re-deriving reauditLenses), and KI-E40's telemetry
    // verdict classifier counts the all-`key=ok` family as an ok verdict — a missing key read as 0%.
    progress.res.gates['reaudit'] = reauditEntries.map((c) => c.lens + '=' + (recv['re-auditor:' + c.lens] ? (recv['re-auditor:' + c.lens].converged ? 'ok' : 'no') : 'NULL')).join(' ');
    if (!allConverged) { finish(progress, 'FAILED', 're-audit lens(es) did not converge: ' + lensNotes.join('; ')); return; }
    progress.res.transitions.push('REAUDITED');
    progress.phase = 'escalatecheck'; // factory.js ~958: the escalate-tier park happens ONLY after refute + re-audit pass
    return;
  }
  if (phaseKey === 'integrate_judge') {
    const integ = recv['integrator'];
    writeArtifact(progress, 'integrate', 'integrate.md', '# Integrate\n\n' + JSON.stringify(integ, null, 2));
    if (!integ.globalGreen || (typeof integ.regressionDelta === 'number' && integ.regressionDelta > 0)) {
      finish(progress, 'FAILED', 'integrate not globalGreen or regressionDelta>0: ' + integ.handoff);
      return;
    }
    progress.res.transitions.push('INTEGRATED', 'CLOSED');
    // KI-E112: canon propagates the integrator's reported branch onto the result (factory.js:
    // `if (integ.branch) res.branch = integ.branch`); this port dropped it, so the folded row lost
    // the branch the human is meant to review and commit — the one hand-off the factory exists to
    // produce (KI-E1: the human authors every commit).
    if (integ.branch) progress.res.branch = integ.branch;
    progress.res.toState = 'CLOSED';
    progress.res.note = 'red\u2192green; ' + Object.keys(progress.res.gates).length + ' gates APPROVED; refute OK; re-audit converged; global green';
    progress.res.integrateRaw = progress.res.codeChange;
    progress.phase = 'checkpoint';
    return;
  }
  if (phaseKey === 'decision_frame') {
    const fr = recv['decision-framer'];
    writeArtifact(progress, 'decision', 'decision.md', '# Decision\n\n' + JSON.stringify(fr, null, 2));
    const note = fr && fr.headline ? (String(fr.headline) + ' [' + progress._blockReason + ']') : progress._blockReason;
    finish(progress, 'BLOCKED', note);
    return;
  }
  throw new Error('applyPhaseResults: unhandled phaseKey ' + phaseKey);
}

function reverseRoleKey(role) {
  const map = { 'review-code': 'code-review', 'review-adversarial': 'review-adversarial-general', 'review-edgecase': 'review-edge-case-hunter', 'review-testreview': 'testarch-test-review' };
  return map[role] || role;
}

// After the blocking band passes (clean, or adjudicated + re-gated clean): PO parity with factory.js
// `if (gateRoles.includes('po')) { ... }` — the PO gate runs ONLY when the band's gateRoles include
// 'po' (LIGHT = developer+qa only, so LIGHT items skip PO entirely); either way 'GATED' lands on the
// transitions (factory.js pushes it after the po block unconditionally).
// KI-E112 — the host's configured gateSet, read once. `gateRolesFor(item, band, cfgGateSet)` has
// always accepted this third argument, but both call sites passed `null`, so a host that customised
// `config/factory.config.json`'s `gateSet` was silently ignored by this port while canon honoured it
// (factory.js: `item.gateSet?.length ? item.gateSet : (CFG.gateSet || [...])`). Harmless while the
// config happens to equal the hardcoded default — which is exactly what made it a latent trap rather
// than a visible bug. Best-effort: an unreadable/absent config yields null, i.e. the prior behaviour.
function configuredGateSet() {
  try {
    const cfg = readJson(join(FACTORY_ROOT, 'config', 'factory.config.json'));
    return Array.isArray(cfg && cfg.gateSet) && cfg.gateSet.length ? cfg.gateSet : null;
  } catch { return null; }
}

function nextAfterGateBand(progress) {
  const gateRoles = gateRolesFor(progress.item, progress.band, configuredGateSet());
  if (gateRoles.includes('po')) { progress.phase = 'po'; return; }
  progress.res.transitions.push('GATED');
  progress.phase = 'refute_reaudit';
}

function frameAndBlock(progress, reason) {
  // KI-O1 fix: previously skipped the dedicated decision-framer agent call (an advisory-only stub).
  // Now dispatches a REAL decision-framer phase, exactly matching factory.js's frameAndBlock — the
  // item does not reach BLOCKED until the framer's DECISION_SCHEMA response is submitted (see the
  // 'decision_frame' phase in planNext/applyPhaseResults below). `finish('BLOCKED', ...)` always
  // fires once that response lands, even if the framer's own text is thin — the framer only
  // enriches the note, it never determines *whether* the item blocks (matches upstream exactly).
  progress._blockReason = reason;
  progress.phase = 'decision_frame';
}

// ---------------------------------------------------------------------------------------------
// mech — deterministic (no-LLM) steps: verify/leftover/integrate/checkpoint, run via build-test.sh
// or direct fs/marker checks, exactly mirroring the machine-evidence contract driver.mjs's fold
// re-derives independently at fold time (P1/P2/P3/P9 etc. — see KNOWN-ISSUES.md research notes).
// ---------------------------------------------------------------------------------------------

// Anchored multiline LAST-match count parse for the lint CLIs' `FACTORY::<NAME>::<n>` trailer.
// Anchored (^...$) so a HIT line whose quoted text contains the literal cannot satisfy it (proven
// live: an unanchored first-match read a quoted `FACTORY::LEFTOVER::0` inside a hit's text as the
// count); LAST match because the real trailer is "always last" by the lint CLIs' output contract.
// Returns the integer, or null when NO anchored marker line exists (spawn/script failure — the
// caller must treat that as scan-unavailable, never as clean).
export function lastMarkerCount(output, name) {
  const re = new RegExp('^FACTORY::' + name + '::(\\d+)\\r?$', 'gm');
  let m, last = null;
  while ((m = re.exec(String(output || ''))) !== null) last = m;
  return last ? parseInt(last[1], 10) : null;
}

// The policy-gated mechanical comment gate (KI-E59 + PR#9 policy universalization). Pure decision
// wrapper around lib/comment-scan.mjs findComments (injectable for the selftest):
//   policy off   -> { skipped: true }                    (no scan at all — leftover scan unaffected)
//   scan throws  -> { unavailable: true, error }         (GATE-UNAVAILABLE — caller records NO gate)
//   completed    -> { count, hits, scanSkippedFiles }    (count>0 fails the item; 0 -> APPROVED)
export function runCommentGate(worktree, policies, scanFn = findComments) {
  if (!policies || !policies.noNewComments) return { skipped: true };
  try {
    const hits = scanFn(worktree, 50) || [];
    return { skipped: false, unavailable: false, count: hits.length, hits: [...hits], scanSkippedFiles: hits.skipped || 0 };
  } catch (e) {
    return { skipped: false, unavailable: true, error: (e && e.message) || String(e) };
  }
}

// KI-E43 baseline parity with driver fold's deterministicVerifyOverride: the effective baseline is
// effectiveBaseline(run-reported array, parse of the RED-stage pre-fix baseline-raw.txt) — the disk
// transcript is trusted on a reFix ONLY when it predates this attempt (a re-capture would launder
// the prior fix's own breakage into the allowance; driver fences on the ledger claim timestamp, this
// port on progress.initAtMs). Returns { baseline, fromDisk, ignoredReFixRecapture }.
export function effectiveBaselineFor(progress, dir) {
  const reported = progress.res.baselineFailures || [];
  const p = join(dir, 'baseline-raw.txt');
  if (!existsSync(p)) return { baseline: effectiveBaseline(reported, null), fromDisk: false, ignoredReFixRecapture: false };
  if (progress.reFix && progress.initAtMs) {
    let mtime = Infinity; try { mtime = statSync(p).mtimeMs; } catch { /* unreadable -> distrust */ }
    if (mtime >= progress.initAtMs) {
      log(`  KI-E43 reFix fence ${progress.id}: baseline-raw.txt was (re)captured DURING this reFix attempt — the tree already carries the prior fix, so the transcript is IGNORED (the run-reported baseline stands)`);
      return { baseline: effectiveBaseline(reported, null), fromDisk: false, ignoredReFixRecapture: true };
    }
  }
  const baselineParse = parseVerifyRaw(decodeTranscript(readFileSync(p)));
  return { baseline: effectiveBaseline(reported, baselineParse), fromDisk: true, ignoredReFixRecapture: false };
}

function cmdMech(id, step, rest, flags) {
  const progress = loadProgress(id);
  const dir = itemsDirFor(progress.ctx, id);
  mkdirSync(dir, { recursive: true });

  // KI-O1 fix: a bare/relative target path (e.g. "src/App.sln") used to be passed straight
  // to dotnet as-is, which silently resolves relative to the CALLER's cwd — NOT the item's worktree
  // — and an operator who instead passes an ABSOLUTE path pointing at the wrong repo (e.g. the
  // host's MAIN repo instead of its linked worktree copy) gets no warning at all: the
  // main repo builds and tests fine on its own, so verify reports a false green having tested the
  // WRONG (unfixed) tree entirely. Caught live against a real production item, 2026-07-28. Two
  // mitigations: (1) a bare relative target now resolves against ctx.worktreePath automatically
  // (removing the #1 way to get this wrong by hand); (2) an absolute target is checked for a
  // worktreePath prefix and WARNS loudly (not blocked — a deliberate cross-tree check is
  // occasionally legitimate) if it points somewhere else entirely.
  function resolveTarget(t) {
    if (!t) return t;
    // UNC (\\server\share or //server/share) is absolute too — joining it onto the worktree would
    // silently build a nonsense path (PR#9 review LOW). Case-folding applies only on win32: on a
    // case-sensitive filesystem two paths differing by case ARE different trees, and folding them
    // would wrongly suppress the outside-worktree warning.
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('\\\\');
    if (!isAbsolute) {
      const resolved = join(progress.ctx.worktreePath, t).replace(/\\/g, '/');
      log(`[mech] relative target "${t}" -> resolved against the worktree: ${resolved}`);
      return resolved;
    }
    const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const wt = fold(progress.ctx.worktreePath.replace(/\\/g, '/'));
    const abs = fold(t.replace(/\\/g, '/'));
    if (!abs.startsWith(wt)) {
      log(`[mech] WARNING: target "${t}" is OUTSIDE this item's worktree (${progress.ctx.worktreePath}) — verifying it would test whatever tree that path actually is, not this item's fix. Double-check this is intentional.`);
    }
    return t;
  }

  if (step === 'verify') {
    // Doc-only path (P10/parity): factory.js's runner brief for a !codeChange item says "the fix
    // touches NO .cs files, so do NOT run dotnet build/test. Run the regression-test check from the
    // spec (the grep/script assertion) + confirm the acceptance." — the mechanical equivalent is a
    // NO-BUILD step that records honest evidence instead of failing on an unbuildable doc target.
    // The doc grep/script assertion itself is the red-proof transcript's job (verify-red-raw.txt);
    // fold's P3 requires machine build evidence only for codeChange items.
    if (!progress.res.codeChange) {
      const note = 'doc-only item: no build required (codeChange=false — the fix touches no .cs files and the test-author shipped no .cs test). Acceptance is verified by the spec\'s grep/script assertion (see verify-red-raw.txt) + the review band.';
      writeRaw(join(dir, 'verify-raw.txt'), note + '\n');
      // Review pack still matters — reviewers read it first. Best-effort (a doc worktree is still a git tree).
      runBuildTest(progress.ctx.factoryRoot, 'pack', [progress.ctx.worktreePath, join(dir, 'review-pack.md')]);
      progress.res.transitions.push('GREEN', 'BUILT', 'TESTED');
      progress.phase = 'edgescan'; // planNext then skips edgescan/leftover for !codeChange
      saveProgress(id, progress);
      log('verify (doc-only, no build): recorded honest no-build evidence -> advancing. next:');
      return cmdNext(id);
    }
    const [rawTarget, filter] = rest;
    if (!rawTarget) throw new Error('usage: mech <id> verify -- <target.sln-or-csproj> ["<filter>"]');
    const target = resolveTarget(rawTarget);
    const band = progress.band;
    // KI-O1 fix: a codeChange item with NO filter previously fell through to a build-only (or, for
    // FULL band, suite-only) run, yet verdictFromParse still reports "machine evidence: build
    // clean, tests green" (there is no way to distinguish "no targeted test ran" from "it ran and
    // passed" from build/suite data alone). Also: dotnet test's DEFAULT verbosity suppresses test
    // stdout (KI-L22) — only `filter`'s `--logger console;verbosity=detailed` can ever surface a
    // test's `Console.WriteLine("FACTORY::REALINFRA::...")` marker. `suite` alone can NEVER carry
    // that marker, no matter how many times re-run — a FULL-band realInfra item verified via
    // suite-only would be STRUCTURALLY unable to ever close (caught live against a real production
    // item, 2026-07-28: build clean, suite fully green, marker-probe correctly but unfixably FAILED).
    // Refuse loudly for ANY codeChange item, any band, instead of ever silently under-verifying.
    if (progress.res.codeChange && !filter) {
      throw new Error(`mech verify: codeChange=true (band=${band}) but no filter was given — a code item MUST run its targeted test with detailed-verbosity logging (build/suite-only evidence would silently read as "tests green" downstream, AND can never carry a realInfra Console marker regardless of band). Pass the dotnet --filter expression as the second arg.`);
    }
    let combined = '';
    const b = runBuildTest(progress.ctx.factoryRoot, 'build', [target]);
    combined += b.output;
    if (b.code !== 0) { writeRaw(join(dir, 'verify-raw.txt'), combined); return afterVerify(progress, combined); }
    if (progress.res.codeChange) {
      // KI-O1 fix: FULL band runs BOTH filter (detailed-verbosity targeted proof, the only path a
      // realInfra marker can travel) AND suite (whole-solution regression proof) — matches the real
      // pipeline's "FULL = build+filter+full suite" contract; this port previously ran suite ONLY.
      const f = runBuildTest(progress.ctx.factoryRoot, 'filter', [target, filter]);
      combined += '\n' + f.output;
      if (band === 'FULL') {
        const s = runBuildTest(progress.ctx.factoryRoot, 'suite', [target]);
        combined += '\n' + s.output;
      }
    }
    writeRaw(join(dir, 'verify-raw.txt'), combined);
    // Review pack - cache-strategic snapshot every reviewer reads first.
    runBuildTest(progress.ctx.factoryRoot, 'pack', [progress.ctx.worktreePath, join(dir, 'review-pack.md')]);
    return afterVerify(progress, combined);
  }
  if (step === 'leftover') {
    // KI-E59 mechanical "no new comments" gate — HOST-POLICY-GATED (PR#9 review): runs ONLY when the
    // host enables policies.noNewComments (mirrors factory.js's `if (codeChange && A.policies.
    // noNewComments)` comment-probe gating; the shipped engine default is OFF). When it runs, it
    // calls lib/comment-scan.mjs's findComments DIRECTLY (Windows-safe — no bash/build-test.sh
    // spawn seam) and, unlike leftover-scan, has NO classify step: with the policy on, every hit is
    // an immediate FAILED, short-circuiting before the leftover scan (no point spending a
    // leftover-classify LLM call on an item that is going to FAIL regardless).
    const policies = loadPolicies(FACTORY_ROOT);
    const cg = runCommentGate(progress.ctx.worktreePath, policies);
    if (cg.skipped) {
      log('comment-scan: host policy noNewComments=off — comment check skipped entirely (leftover scan unchanged)');
    } else if (cg.unavailable) {
      // GATE-UNAVAILABLE: findComments THREW (git itself failed — the scan could not run). Do NOT
      // record any gate verdict: factory.js's comment-probe posture is fail-open-without-a-verdict
      // ("A recorded APPROVED requires a real count 0" — a malformed/unavailable probe sets NO
      // gate), and while fold merges gate VALUES as data (lib/ledger.mjs `row.gates = {...merge}`,
      // no value-based blocking), a recorded key would still claim scan evidence that does not
      // exist (last-failure.md's reachedGate wording + the item_folded telemetry read key
      // presence). OMITTING the key is the variant that cannot change fold semantics; the fold's
      // deterministic KI-E59 WARN backstop re-scans the worktree itself.
      writeRaw(join(dir, 'comment-raw.txt'), 'FACTORY::COMMENT-SCAN-ERROR::' + String(cg.error).split('\n')[0].slice(0, 200) + '\n');
      log('⚠ comment-scan GATE-UNAVAILABLE (KI-E59): the deterministic scanner could not run (' + String(cg.error).split('\n')[0].slice(0, 160) + ') — NO mech:comment-scan gate recorded (never a silent APPROVED, AP#19); the driver fold\'s KI-E59 backstop re-checks the worktree. Proceeding to the leftover scan.');
    } else {
      // Completed scan — write comment-raw.txt in the comment-lint CLI's exact marker format so the
      // on-disk artifact matches what the native pipeline's probe tees.
      const lines = cg.hits.map((h) => 'FACTORY::COMMENT-HIT::' + h.file + '::' + h.kind + '::' + h.line);
      if (cg.scanSkippedFiles) lines.push('FACTORY::COMMENT-SCAN-SKIPPED::' + cg.scanSkippedFiles);
      lines.push('FACTORY::COMMENT::' + cg.count);
      writeRaw(join(dir, 'comment-raw.txt'), lines.join('\n') + '\n');
      if (cg.scanSkippedFiles) log('⚠ comment-scan: ' + cg.scanSkippedFiles + ' untracked file(s) unreadable — partial scan (surfaced, never silent)');
      if (cg.count > 0) {
        progress.res.gates['mech:comment-scan'] = 'CHANGES_REQUIRED';
        const cHits = cg.hits.slice(0, 5).map((h) => `${h.file} [${h.kind}]: ${h.line}`);
        finish(progress, 'FAILED', `comment-scan (KI-E59): ${cg.count} new/reworded comment(s) added, zero tolerated by this host's policy - ${cHits.join(' | ')}${cg.count > 5 ? ` | ...(${cg.count - 5} more, see comment-raw.txt)` : ''}`);
        saveProgress(id, progress);
        log('FAILED (comment-scan). next:');
        return cmdNext(id);
      }
      progress.res.gates['mech:comment-scan'] = 'APPROVED';
    }
    const r = runBuildTest(progress.ctx.factoryRoot, 'leftovers', [progress.ctx.worktreePath]);
    writeRaw(join(dir, 'leftover-raw.txt'), r.output);
    // Anchored LAST-match marker parse (see lastMarkerCount): a hit line QUOTING the literal
    // `FACTORY::LEFTOVER::0` no longer defeats the count, and a spawn/script failure (no marker at
    // all — leftover-lint always prints one on a completed run, even its own internal-error path)
    // is a LOUD error instead of parsing as clean.
    const n = lastMarkerCount(r.output, 'LEFTOVER');
    if (n === null) {
      throw new Error('mech leftover: build-test.sh leftovers produced NO final FACTORY::LEFTOVER::<n> marker (spawn exit=' + r.code + ') — the scan did not run; refusing to treat a failed scan as clean. Output tail: ' + r.output.slice(-300));
    }
    if (n === 0) {
      progress.res.gates['probe:leftover-scan'] = 'APPROVED';
      progress.phase = ledgerAnchorNext(progress, dir);
      saveProgress(id, progress);
      log('leftover-scan: 0 candidates -> APPROVED, advancing. next:');
      return cmdNext(id);
    }
    const hits = [...r.output.matchAll(/FACTORY::LEFTOVER-HIT::([^:]+)::([^:]+)::(\d+)/g)].map((m) => ({ file: m[1], lexeme: m[2], line: parseInt(m[3], 10) }));
    progress._leftoverHits = hits;
    progress.phase = 'leftover_classify';
    saveProgress(id, progress);
    log(`leftover-scan: ${n} candidate(s) -> needs haiku classification. next:`);
    return cmdNext(id);
  }
  if (step === 'integrate') {
    // Doc-only path (parity: factory.js's integrator brief for !codeChange — "no .cs changed;
    // confirm the doc/config acceptance, report globalGreen=true, regressionDelta=0", no build).
    // Fold's P6 requires an integrate transcript only for codeChange items.
    if (!progress.res.codeChange) {
      writeRaw(join(dir, 'integrate-raw.txt'), 'doc-only item: no global build/suite required (codeChange=false)\n');
      progress.phase = 'integrate_judge';
      saveProgress(id, progress);
      log('integrate (doc-only, no build) -> dispatch the integrator agent. next:');
      return cmdNext(id);
    }
    const [rawTarget] = rest.length ? rest : [flags.target];
    if (!rawTarget) throw new Error('usage: mech <id> integrate -- <target.sln>');
    const target = resolveTarget(rawTarget);
    let combined = '';
    const b = runBuildTest(progress.ctx.factoryRoot, 'build', [target]);
    combined += b.output;
    const s = runBuildTest(progress.ctx.factoryRoot, 'suite', [target]);
    combined += '\n' + s.output;
    writeRaw(join(dir, 'integrate-raw.txt'), combined);
    const parsed = parseVerifyRaw(combined);
    // KI-E43 parity (driver fold's deterministicVerifyOverride): the baseline comes from the
    // RECORDED pre-fix baseline (the RED-stage baseline-raw.txt transcript when present + trusted,
    // else the run-reported baselineFailures array) — NEVER from this integrate run's OWN parse.
    // Feeding the integrate parse back in as its own baseline made a suite regression structurally
    // unreportable (every new failure counted as "pre-existing").
    const { baseline, fromDisk } = effectiveBaselineFor(progress, dir);
    const verdict = verdictFromParse(parsed, baseline);
    log('integrate machine verdict: ' + JSON.stringify(verdict) + ' (baseline=' + baseline + (fromDisk ? ', incl. pre-fix baseline-raw.txt' : ', run-reported only') + ')');
    if (!verdict.pass) {
      // Honest failure — same treatment as afterVerify's failing verify, and the same outcome
      // factory.js produces at this stage (a regressing integrate fails the item: `if
      // (!integ.globalGreen || regressionDelta > 0) return finish('FAILED', ...)`) — the fold's
      // deterministic iVerdict re-check would rewrite a forward claim to FAILED on this transcript
      // anyway. Never print "green" (or advance to the integrator) over a machine-visible regression.
      finish(progress, 'FAILED', 'integrate: ' + verdict.reason);
      saveProgress(id, progress);
      log('FAILED (integrate regression). next:');
      return cmdNext(id);
    }
    progress.phase = 'integrate_judge';
    saveProgress(id, progress);
    log('mechanical build+suite done -> dispatch the integrator agent. next:');
    return cmdNext(id);
  }
  if (step === 'checkpoint') {
    const resultPath = join(dir, 'result.json');
    writeJsonAtomic(resultPath, progress.res);
    try { JSON.parse(readFileSync(resultPath, 'utf8')); } catch (e) { throw new Error('checkpoint write failed self-verification: ' + e.message); }
    // Terminal persistence complete: mark it and land the phase on 'done' so `next` stops returning
    // the checkpoint step (the CLOSED path previously looped {mechanical:'checkpoint'} forever, and
    // FAILED/BLOCKED/ESCALATED terminals never reached a result.json at all).
    progress.checkpointed = true;
    progress.phase = 'done';
    saveProgress(id, progress);
    log('CHECKPOINT-OK -> ' + resultPath);
    log(JSON.stringify(progress.res, null, 2));
    log('');
    // KI-O1 fix: `driver.mjs fold` requires an ARRAY (or {results:[...]}) — a bare per-item
    // result.json folds as "ZERO results" (a real stumble hit while validating this port; the
    // native pipeline never hits it because factory.js's own return value is already batch-shaped).
    // `finalize` does this wrapping automatically so the operator never has to hand-build it.
    log('next: node ' + FACTORY_ROOT + '/_workflow/opencode/runtime.mjs finalize ' + id);
    return;
  }
  throw new Error('unknown mech step: ' + step);
}

// finalize — wraps state/items/<id>/result.json into a fold-ready results-cycle-<N>.json array
// (mirrors what `driver.mjs reconstruct` produces from checkpoints). Read-only w.r.t. the ledger;
// writes only the new results file. The caller still runs `driver.mjs fold` on the printed path.
function cmdFinalize(id) {
  const progress = loadProgress(id);
  const p = join(FACTORY_ROOT, 'state', 'items', id, 'result.json');
  if (!existsSync(p)) throw new Error('no result.json for ' + id + ' at ' + p + ' — run `mech ' + id + ' checkpoint` first');
  const res = readJson(p);
  const cycle = progress.cycle;
  const outPath = join(FACTORY_ROOT, 'state', 'results-cycle-' + cycle + '-' + id + '.json');
  writeJsonAtomic(outPath, { mode: 'opencode-adapter', cycle, results: [res] });
  log('finalize: wrote ' + outPath);
  log('next: node ' + FACTORY_ROOT + '/_workflow/driver.mjs fold ' + 'state/results-cycle-' + cycle + '-' + id + '.json' + ' --controller <token>');
}

// KI-E112 — LEDGER-ANCHOR (KI-E91) STEP-1: run the engine-owned deterministic lint and decide the
// next phase. Gated exactly as canon gates it — only when the item's declared files[] name a
// *STANDARDS-DIVERGENCE-LEDGER.md path — so it is a free no-op for every host that keeps no such
// ledger. Best-effort by the same posture as its siblings: a lint that cannot run announces itself
// and advances rather than blocking a fix that may be perfectly correct.
function ledgerAnchorNext(progress, dir) {
  const touches = ((progress.item && progress.item.files) || []).some((f) => /STANDARDS-DIVERGENCE-LEDGER\.md$/i.test(String(f)));
  if (!touches) return 'editorial';
  let out = '';
  try { out = runBuildTest(progress.ctx.factoryRoot, 'ledger-anchor', [progress.ctx.worktreePath]).output || ''; } catch (e) { out = ''; }
  if (!out) { log('⚠ ledger-anchor (KI-E91): lint produced no output — check SKIPPED (announced, never silently clean).'); return 'editorial'; }
  try { writeRaw(join(dir, 'ledger-anchor-raw.txt'), out); } catch { /* artifact only */ }
  const n = lastMarkerCount(out, 'LEDGER-ANCHOR');
  if (n === null) { log('⚠ ledger-anchor (KI-E91): no FACTORY::LEDGER-ANCHOR::<n> marker — check SKIPPED (announced).'); return 'editorial'; }
  if (n === 0) { progress.res.gates['probe:ledger-anchor'] = 'APPROVED'; log('ledger-anchor: 0 candidates -> APPROVED.'); return 'editorial'; }
  progress._ledgerAnchorHits = [...out.matchAll(/FACTORY::LEDGER-ANCHOR-HIT::([^\n]+)/g)].map((m) => m[1]);
  log(`ledger-anchor: ${n} candidate(s) -> needs classification.`);
  return 'ledger_anchor_classify';
}

function afterVerify(progress, combined) {
  const parsed = parseVerifyRaw(combined);
  // Same KI-E43 effective baseline the driver fold applies to the verify transcript (vVerdict) —
  // run-reported array + the pre-fix baseline-raw.txt when present/trusted, never this run's parse.
  const { baseline } = effectiveBaselineFor(progress, itemsDirFor(progress.ctx, progress.id));
  const verdict = verdictFromParse(parsed, baseline);
  log('verify machine verdict: ' + JSON.stringify(verdict) + ' parsed=' + JSON.stringify(parsed));
  if (!verdict.pass) { finish(progress, 'FAILED', 'verify: ' + verdict.reason); saveProgress(progress.id, progress); log('FAILED. next:'); return cmdNext(progress.id); }
  progress.res.transitions.push('GREEN', 'BUILT', 'TESTED');
  if (progress.res.needsRealInfra) {
    const marker = hasRealInfraMarker(combined);
    if (!marker) {
      log('needsRealInfra=true but no FACTORY::REALINFRA:: marker in verify-raw.txt yet.');
      if (!dockerAvailable()) { finish(progress, 'BLOCKED', 'realInfra item needs Docker/Testcontainers — Docker absent on this runner; parked, NOT closed on an in-memory green'); saveProgress(progress.id, progress); log('BLOCKED. next:'); return cmdNext(progress.id); }
      finish(progress, 'FAILED', 'realInfra marker probe: verify-raw.txt has NO FACTORY::REALINFRA:: marker on disk — the regression test never bound a real container');
      saveProgress(progress.id, progress);
      log('FAILED (no realinfra marker). next:');
      return cmdNext(progress.id);
    }
    log('FACTORY::REALINFRA:: marker present — real-infra proof OK.');
  }
  // KI-E112 — three canonical guards ported here, all DETERMINISTIC (no agent), closing gaps this
  // port had disclosed in stage-parity.mjs. Positioned exactly where factory.js puts them: after the
  // GREEN/BUILT/TESTED transitions and strictly BEFORE the edge-scan and the gate band, so a failure
  // costs one mech step instead of a full band.
  const wtP112 = progress.ctx.worktreePath;
  const itemFiles112 = (progress.item && progress.item.files) || [];
  let changed112 = null;
  try { changed112 = changedFiles(wtP112); } catch { changed112 = null; }

  // (a) RED-PROOF (KI-E83). factory.js re-greps verify-red-raw.txt on DISK because a test-author's
  // self-reported `test.red` can diverge from what its own artifact shows — ITEM-H24/ITEM-H26 each
  // burned a FULL band with 9 and 8 gates APPROVED before the fold caught FACTORY::RED::0. This port
  // trusted the self-report until fold time. `parseRedRaw` was already imported here and unused.
  // Contract is INVERTED for verificationOnly (KI-L55): the pinning/coverage test must PASS (exit 0).
  {
    const redPath = join(itemsDirFor(progress.ctx, progress.id), 'verify-red-raw.txt');
    const redParse = existsSync(redPath) ? parseRedRaw(decodeTranscript(readFileSync(redPath))) : null;
    if (redParse && typeof redParse.exit === 'number') {
      const exitIsZero = redParse.exit === 0;
      const probeFail = progress.verificationOnly ? !exitIsZero : exitIsZero;
      if (probeFail) {
        finish(progress, 'FAILED', 'RED-proof marker (KI-E83): verify-red-raw.txt shows exit=' + redParse.exit + ' — ' + (progress.verificationOnly ? 'the pinning/coverage test did NOT pass on the current tree (verificationOnly requires exit=0)' : 'the regression test PASSED on old code (vacuous test — passes on both old and new code)') + '. Failing BEFORE the gate band; the fold-time P1 remains the close authority.');
        saveProgress(progress.id, progress);
        log('FAILED (red-proof). next:');
        return cmdNext(progress.id);
      }
      log('RED-proof marker OK (exit=' + redParse.exit + ').');
    } else {
      // Fail-open, ANNOUNCED — same posture as factory.js's null-probe path and KI-E20/KI-E41.
      log('⚠ RED-proof marker (KI-E83): no readable FACTORY::RED:: marker in verify-red-raw.txt — check SKIPPED (the fold-time P1 remains the authority).');
    }
  }

  // (b) DEBRIS (KI-D1). factory.js fails on obvious factory-artifact/scratch files in the diff; this
  // port never imported debrisFiles at all, so a teed artifact or scratch file reached the band.
  if (changed112) {
    const debris112 = debrisFiles(changed112, itemFiles112);
    if (debris112.length) {
      finish(progress, 'FAILED', 'worktree debris (scratch/temp/artifact files): ' + debris112.join(', '));
      saveProgress(progress.id, progress);
      log('FAILED (debris). next:');
      return cmdNext(progress.id);
    }
  }

  // (c) ROOT-CAUSE TOUCH (KI-E104, the pre-band half of the fold's P9). Same predicate + same gating
  // as canon: code items only, never verificationOnly (KI-L55 — no fixer ran by design there), and
  // only when the item predicted a non-test touch-set. Uses the SAME lib/verify.mjs derivation the
  // fold applies, so the two cannot disagree.
  if (progress.res.codeChange && !progress.verificationOnly && (progress.res.rootCauseFiles || []).length) {
    if (!changed112) {
      progress.res.gates['mech:rootcause-touch'] = 'SKIPPED';
      log('⚠ rootcause-touch (KI-E104): worktree unreadable — check SKIPPED (announced, never silently clean).');
    } else if (!nonTestChanged(changed112).length) {
      progress.res.gates['mech:rootcause-touch'] = 'CHANGES_REQUIRED';
      progress.res.gateDetails['mech:rootcause-touch'] = { verdict: 'CHANGES_REQUIRED', headline: 'the diff changes NO non-test file — the test was greened, the root cause was not fixed', findings: [{ severity: 'HIGH', title: 'tests-only diff on a code item that declared a non-test touch-set', fix: 'change the real source/config file that carries the defect; the regression test alone is not a fix' }] };
      finish(progress, 'FAILED', 'rootcause-touch (KI-E104): the fix changed NO non-test source file (diff touched only tests) — the test was greened but the root cause was not fixed. Pre-band fail; the fold-time P9 remains the close authority.');
      saveProgress(progress.id, progress);
      log('FAILED (rootcause-touch). next:');
      return cmdNext(progress.id);
    } else {
      progress.res.gates['mech:rootcause-touch'] = 'APPROVED';
    }
  }
  // KI-E112 — WIRE the KI-E74B verify-note channel, which compose.mjs has rendered since KI-E74B but
  // which nothing ever populated (a dead render, self-disclosed there). Canon fills it from the
  // runner AGENT's honest self-caveat; this port has no runner agent, so the honest analogue is the
  // set of caveats the DETERMINISTIC pass itself produced — a check that could not run, or a test
  // class that behaved non-deterministically. Those are exactly what a reviewer must not approve
  // past unverified, and unlike an agent's prose they cannot be self-serving.
  const caveats112 = [];
  if (progress.res.gates['mech:rootcause-touch'] === 'SKIPPED') caveats112.push('the root-cause touch check could not run (worktree unreadable) — the tests-only-diff class is UNVERIFIED here.');
  if (!existsSync(join(itemsDirFor(progress.ctx, progress.id), 'verify-red-raw.txt'))) caveats112.push('no verify-red-raw.txt on disk — the RED proof (that the regression test fails on OLD code) is UNVERIFIED here; the fold re-checks it.');
  try {
    const flaky112 = flakeSuspects(combined);
    if (flaky112.length) caveats112.push('FLAKE SUSPECT — test class(es) both PASSED and FAILED in this run: ' + flaky112.join(', ') + '. If that was not a fix-then-retry, the test is unstable and its green is not trustworthy.');
  } catch { /* advisory only */ }
  if (caveats112.length) {
    progress.item.verifyNote = caveats112.join(' ');
    log('⚠ verify caveats recorded for the review band: ' + progress.item.verifyNote);
  }
  saveProgress(progress.id, progress);
  progress.phase = 'edgescan';
  saveProgress(progress.id, progress);
  log('verify OK -> advancing. next:');
  return cmdNext(progress.id);
}

function cmdStatus(id) {
  const progress = loadProgress(id);
  log(JSON.stringify({ id: progress.id, phase: progress.phase, band: progress.band, verificationOnly: progress.verificationOnly, toState: progress.res.toState, transitions: progress.res.transitions, gates: progress.res.gates, pendingSet: progress.pendingSet && { phaseKey: progress.pendingSet.phaseKey, keys: progress.pendingSet.keys, received: Object.keys(progress.pendingSet.received) } }, null, 2));
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function parseFlags(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; flags[k] = v; }
    else rest.push(a);
  }
  return { flags, rest };
}

function main() {
  const [, , cmd, id, ...argv] = process.argv;
  const { flags, rest } = parseFlags(argv);
  try {
    if (cmd === 'init') return cmdInit(id, flags);
    if (cmd === 'next') return cmdNext(id);
    if (cmd === 'submit') return cmdSubmit(id, flags);
    if (cmd === 'mech') return cmdMech(id, rest[0], rest.slice(1), flags);
    if (cmd === 'status') return cmdStatus(id);
    if (cmd === 'finalize') return cmdFinalize(id);
    console.log('commands: init <id> | next <id> | submit <id> --role <r> --json <f|-> | mech <id> <verify|leftover|integrate|checkpoint> -- <args> | status <id> | finalize <id>');
  } catch (e) {
    console.error('ERROR: ' + (e && e.message || e));
    process.exitCode = 1;
  }
}
// Entry-point guard: run the CLI only when this file IS the invoked script — importing the module
// (the selftest pins the pure helpers in-process) must never execute a command.
const invoked = (() => {
  try {
    if (!process.argv[1]) return false;
    const self = fileURLToPath(import.meta.url), arg = resolve(process.argv[1]);
    return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
  } catch { return false; }
})();
if (invoked) main();

// In-process seams for _selftest.mjs (lifecycle pins that cannot pass a real dotnet build run the
// state functions directly). Everything here is the SAME code the CLI paths execute — no test forks.
export { applyPhaseResults, planNext, progressPath, loadProgress, saveProgress };
