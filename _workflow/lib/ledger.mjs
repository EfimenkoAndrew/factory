// Ledger — atomic, resumable state for every work item. The filesystem checkpoint.
// Single writer (the driver). Agents never touch this file; they write
// state/items/<id>/<stage>.json and the driver folds those results in here.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---- state machine ------------------------------------------------------------
// Forward happy path, in order:
export const FORWARD = [
  'READY', 'CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED',
  'GATED', 'REFUTE_OK', 'REAUDITED', 'INTEGRATED', 'CLOSED',
];
// Off-ramps (also persisted):
export const OFFRAMPS = ['BLOCKED', 'ESCALATED', 'FAILED', 'CONFLICT'];
export const ACTIVE = ['CLAIMED', 'RED', 'GREEN', 'BUILT', 'TESTED', 'GATED', 'REFUTE_OK', 'REAUDITED'];
export const TERMINAL = ['CLOSED'];
// States foldResults may auto-CLAIM from when a verified result path starts at RED — READY (the
// select+fold footgun) plus FAILED/CONFLICT (the direct-recovery shape, KI-L62). Mirrors the
// (re-)claim edge canTransition legalizes from exactly these three states.
export const AUTO_CLAIM_FROM = ['READY', 'FAILED', 'CONFLICT'];

const FWD_INDEX = Object.fromEntries(FORWARD.map((s, i) => [s, i]));

// Is a transition from->to allowed? Forward by one step, any forward step that is a
// re-entry after an off-ramp, an active->off-ramp, an off-ramp->READY re-queue/retry,
// or a same-state no-op. Kept permissive on the off-ramp edges by design (a fix can
// fail or get escalated from anywhere), strict on forward progress.
export function canTransition(from, to) {
  if (from === to) return true;
  if (from == null) return to === 'READY';
  // any active or ready -> off-ramp
  if (OFFRAMPS.includes(to) && (ACTIVE.includes(from) || from === 'READY')) return true;
  // off-ramp recovery: FAILED/CONFLICT re-queue to READY OR re-claim directly for a fresh attempt;
  // BLOCKED (owner decision) only re-opens to READY once resolved.
  // FAILED also re-queues to READY/CLAIMED for a fresh attempt, OR escalates to the human queue when
  // the retry bound is exhausted (KI-C6 — a permanently-stuck item must surface, not sit FAILED unseen).
  if (from === 'FAILED') return ['READY', 'CLAIMED', 'ESCALATED'].includes(to);
  if (from === 'CONFLICT') return ['READY', 'CLAIMED'].includes(to);
  if (from === 'BLOCKED') return to === 'READY';
  // ESCALATED -> INTEGRATED (human signed off) or -> CLOSED, or back to READY
  if (from === 'ESCALATED') return ['INTEGRATED', 'CLOSED', 'READY'].includes(to);
  // forward progress: exactly one step, or from READY/post-offramp re-entry into the chain
  const fi = FWD_INDEX[from], ti = FWD_INDEX[to];
  if (fi != null && ti != null && ti === fi + 1) return true;
  // re-queue ANY active or stranded mid-active item back to READY: un-claim for re-batching,
  // OR recover an item stranded in a mid-state (RED/GREEN/.../TESTED) after a kill or a partial
  // run so `reset`/`resume` can actually move it (ITEM-M8 was stuck unrecoverable in TESTED).
  if (ACTIVE.includes(from) && to === 'READY') return true;
  // allow (re-)claim from READY / FAILED / CONFLICT directly (claim for a fresh attempt)
  if (['READY', 'FAILED', 'CONFLICT'].includes(from) && to === 'CLAIMED') return true;
  return false;
}

// ---- atomic JSON I/O ----------------------------------------------------------
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
// KI-E31: unwrap the Workflow harness envelope so `fold <task-output>` works without hand-extraction.
// The runtime wraps the factory's return as {summary, agentCount, logs, result:{mode,cycle,results}}, so a
// raw task-output file carries the fold payload under .result. Unwrap ONLY that shape (a .result that is a
// results-object) — a direct results file (array, or an object already carrying .results) passes through.
export function unwrapResultEnvelope(obj) {
  if (obj && !Array.isArray(obj) && !obj.results && obj.result &&
      (Array.isArray(obj.result.results) || obj.result.mode || obj.result.cycle)) return obj.result;
  return obj;
}
// KI-E36 (review fix): the PARK baseline — when the row last ENTERED its current state, from the row
// history (`updatedAt` moves on ANY later write: note merges, sweeps — it is only >= the park time).
// Falls back to updatedAt; null when no usable timestamp exists (callers suppress the hint).
export function parkedAtMs(row) {
  const h = (row && Array.isArray(row.history)) ? row.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i] && h[i].to === row.state && h[i].at) { const t = Date.parse(h[i].at); if (!Number.isNaN(t)) return t; }
  }
  const t = Date.parse((row && row.updatedAt) || '');
  return Number.isNaN(t) ? null : t;
}
// KI-E29 (review fix): the pure core of the group-time WARN — picked items depending on a CLOSED item
// whose LEDGER-RECORDED worktree still exists (proxy: its fix is not yet committed to HEAD). Reading
// row.worktree (not an assumed state/worktrees/<id> path) covers sweep-closed deps and dies correctly
// at gc, which nulls the field. hasWorktree is the injected fs probe (KI-E2 split).
export function closedDepsWithLiveWorktree(picked, rows, hasWorktree) {
  const out = [];
  for (const wi of picked || []) {
    for (const d of (wi.dependsOn || [])) {
      const dep = rows && rows[d];
      if (dep && dep.state === 'CLOSED' && dep.worktree && hasWorktree(dep.worktree)) out.push({ id: wi.id, dep: d, worktree: dep.worktree });
    }
  }
  return out;
}
// KI-E36 (review fix): TRUE when EVERY file has a commit strictly newer than sinceMs. lastCommitIso is
// an injected lookup (file -> ISO committer date, '' when never committed) so the git edge stays in
// the driver (KI-E2) while this date logic is pure + selftest-pinned. Empty/unknown inputs -> false.
export function allCommittedAfter(files, sinceMs, lastCommitIso) {
  if (!Array.isArray(files) || !files.length || sinceMs == null) return false;
  return files.every((f) => { const iso = lastCommitIso(f); const t = iso ? Date.parse(iso) : NaN; return !Number.isNaN(t) && t > sinceMs; });
}
export function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  // KI-B3 (closed 2026-07-12): pid-unique temp name — two processes writing the same target no longer
  // collide on one shared "<path>.tmp" (the single-writer rule KI-B2 still holds for the ledger; this
  // just removes the residual footgun for every OTHER writeJsonAtomic target, e.g. reports/args).
  const tmp = path + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, path); // atomic on POSIX
}

// ---- ledger ops ---------------------------------------------------------------
const now = () => new Date().toISOString();

export function emptyLedger(graphSource) {
  return { version: 1, createdAt: now(), updatedAt: now(), cycle: 0, graphSource: graphSource || null, items: {} };
}

export function loadLedger(path) {
  if (!existsSync(path)) return null;
  return readJson(path);
}

// Build/refresh ledger rows from a findings-graph. Preserves the state of items that
// already exist (resume); adds new items as READY (or BLOCKED if they carry an
// ownerDecision). Never regresses a CLOSED item.
// KI-L59: `ownerDecision` is overloaded — it can be a PENDING owner question (blocks) or the
// RECORD of an already-made ruling that CREATED the item as a mandate (must NOT block).
// The explicit `ownerDecisionResolved: true` graph flag marks the latter; absent flag keeps
// the legacy pending-decision behavior. An explicit `autonomyTier: 'blocked'` still wins.
export function syncFromGraph(ledger, graph) {
  const items = (graph && graph.items) || [];
  for (const wi of items) {
    if (ledger.items[wi.id]) continue; // preserve existing state on resume
    const blocked = (wi.ownerDecision != null && wi.ownerDecisionResolved !== true) || wi.autonomyTier === 'blocked' || wi.fixType === 'owner-decision';
    const state = blocked ? 'BLOCKED' : 'READY';
    ledger.items[wi.id] = {
      id: wi.id,
      state,
      attempts: 0,
      worktree: null,
      branch: null,
      artifacts: {},
      gates: {},
      cost: {},
      note: blocked ? (wi.ownerDecision || 'owner decision required') : (wi.ownerDecisionResolved === true && wi.ownerDecision != null ? 'owner-ruled: ' + wi.ownerDecision : null),
      history: [{ from: null, to: state, at: now(), note: 'sync-from-graph' }],
      updatedAt: now(),
    };
  }
  ledger.updatedAt = now();
  return ledger;
}

// Apply a single transition with validation. Returns true on success, false if the
// transition is not allowed (the caller logs + decides). Mutates the row.
export function transition(ledger, id, to, note) {
  const row = ledger.items[id];
  if (!row) return false;
  if (!canTransition(row.state, to)) return false;
  const from = row.state;
  row.state = to;
  row.history.push({ from, to, at: now(), note: note || null });
  row.updatedAt = now();
  ledger.updatedAt = now();
  return true;
}

// KI-E53 (PR#9 review — extracted from cmdEscalationsSync for a behavioral pin): the last real
// reason on a ledger row. `row.note` is a dead field nothing assigns — only per-transition
// history[].note entries carry reasons, so the human decision queue walks history from the tail.
export function lastHistoryNote(r) {
  const h = ((r && r.history) || []).filter((x) => x.note);
  return h.length ? h[h.length - 1].note : '(no note)';
}

// KI-E65 — a fold result's `toState` and the LAST element of its `transitions` array are two
// independent fields with no structural link at the schema level. `foldResults` below walks
// `transitions` as the primary source of truth and only falls back to `[toState]` when
// `transitions` is empty/absent — so a result that sets toState:'FAILED' while leaving
// transitions ending in the skeleton's default success path ('...,CLOSED') silently CLOSES the
// item instead of failing it. Live-caught 2026-08-03: a recovery-fold.json's fold-prep step
// correctly wrote toState:'FAILED' (and a gates map with a CHANGES_REQUIRED entry) but left the
// inherited transitions array ending in CLOSED; folding it landed the row on CLOSED with a
// still-broken item (ITEM-30, cycle 57r) silently marked done. Reconcile the two fields BEFORE
// anything else reads them: if they already agree, no-op. If they disagree and `toState`
// appears earlier in `transitions`, truncate there (the array over-ran its own stated ending).
// If `toState` does not appear in `transitions` at all (the live case above), walk backwards
// from the end of `transitions` for the last state that is a legal jumping-off point for
// `toState` per `canTransition`, truncate there, and append `toState`. Never silently keeps a
// transitions array that disagrees with an explicit toState — always returns a correction
// record when it changes anything, so the caller can report it loudly (never a silent fix-up).
export function reconcileToStateAndTransitions(r) {
  if (!r || !r.toState || !Array.isArray(r.transitions) || !r.transitions.length) return null;
  const before = r.transitions.slice();
  if (before[before.length - 1] === r.toState) return null; // already consistent
  const idx = before.indexOf(r.toState);
  if (idx !== -1) {
    r.transitions = before.slice(0, idx + 1);
  } else {
    let cut = before.length;
    while (cut > 0 && !canTransition(before[cut - 1], r.toState)) cut--;
    r.transitions = [...before.slice(0, cut), r.toState];
  }
  return { id: r.id, before, after: r.transitions.slice() };
}

// Fold a batch of per-item Workflow results into the ledger atomically (single writer).
// Each result: { id, toState, artifacts?, gates?, cost?, worktree?, branch?, note?, attemptsDelta? }.
// Unknown ids and disallowed transitions are collected into `rejected` (never silently lost).
export function foldResults(ledger, results) {
  const applied = [], rejected = [], skipped = [];
  ledger.folded = ledger.folded || {}; // resultId -> foldedAt (idempotency journal)
  for (const r of results || []) {
    const row = ledger.items[r.id];
    if (!row) { rejected.push({ id: r.id, reason: 'unknown-id' }); continue; }
    // Idempotency (KI-B4): a result carries resultId = "<id>#<cycle>". If it was already folded,
    // skip it ENTIRELY — re-applying would double-count cost AND attemptsDelta (the latter could
    // wrongly park an item early now that attempts gate scheduling). Guards an accidental re-fold.
    if (r.resultId && ledger.folded[r.resultId]) { skipped.push({ id: r.id, resultId: r.resultId }); continue; }
    // KI-L47 — reject-atomic on an illegal ENTRY hop: if the result's first transition is not legal
    // from the row's current state (e.g. a direct-recovery fold written as RED... against a FAILED
    // row, missing the CLAIMED re-entry), reject the WHOLE result BEFORE any side effect. The old
    // behaviour merged cost/attemptsDelta AND consumed the resultId even when every transition was
    // rejected — so the corrected retry double-counted or needed a bumped id. Mid-path rejections
    // (state genuinely moved) keep today's partial-apply semantics and still consume the id.
    {
      const raw0 = Array.isArray(r.transitions) && r.transitions.length ? r.transitions : (r.toState ? [r.toState] : []);
      const states0 = (AUTO_CLAIM_FROM.includes(row.state) && raw0[0] === 'RED') ? ['CLAIMED', ...raw0] : raw0;
      if (states0.length && !canTransition(row.state, states0[0])) {
        for (const st of states0) rejected.push({ id: r.id, reason: 'bad-transition', from: row.state, to: st });
        continue;
      }
    }
    if (r.artifacts) row.artifacts = { ...row.artifacts, ...r.artifacts };
    if (r.gates) row.gates = { ...row.gates, ...r.gates };
    if (r.cost) for (const [m, t] of Object.entries(r.cost)) row.cost[m] = (row.cost[m] || 0) + t;
    if (r.worktree !== undefined) row.worktree = r.worktree;
    if (r.branch !== undefined) row.branch = r.branch;
    if (typeof r.attemptsDelta === 'number') row.attempts += r.attemptsDelta;
    // A result carries the ORDERED path it walked (e.g. ['RED','GREEN',...,'CLOSED']); apply each
    // transition in sequence so the state machine is honoured and history records the full path.
    const rawStates = Array.isArray(r.transitions) && r.transitions.length ? r.transitions : (r.toState ? [r.toState] : []);
    // Defensive: a verified run starts at RED. If the driver folded WITHOUT a prior `claim`
    // (select+fold footgun), the row is still READY and every transition would be rejected —
    // silently discarding a real, costly run. Auto-insert CLAIMED so the fold can't lose work.
    // KI-L62: the same auto-insert applies to FAILED/CONFLICT rows — the direct-recovery shape
    // (the run protocol §4: transitions:[RED,…,CLOSED] folded onto a FAILED row) was fully rejected
    // otherwise (live: ITEM-CR-5#34r). canTransition already legalizes CLAIMED from all three.
    const states = (AUTO_CLAIM_FROM.includes(row.state) && rawStates[0] === 'RED') ? ['CLAIMED', ...rawStates] : rawStates;
    if (states.length) {
      for (let i = 0; i < states.length; i++) {
        const st = states[i], isLast = i === states.length - 1;
        // Per-stage history (KI-B7): the descriptive note lands on the FINAL state; intermediate
        // steps record just the path (note=null) instead of duplicating one note on every row.
        if (transition(ledger, r.id, st, isLast ? r.note : null)) applied.push({ id: r.id, to: st });
        else rejected.push({ id: r.id, reason: 'bad-transition', from: row.state, to: st });
      }
    } else if (r.note) {
      row.note = r.note; row.updatedAt = now();
    }
    if (r.resultId) ledger.folded[r.resultId] = now();
  }
  ledger.updatedAt = now();
  return { applied, rejected, skipped };
}

// Count rows by state (for status / burndown).
export function countByState(ledger) {
  const c = {};
  for (const row of Object.values(ledger.items)) c[row.state] = (c[row.state] || 0) + 1;
  return c;
}
