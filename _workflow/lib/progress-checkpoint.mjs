// KI-E137 (ported from a host-mount session) — INCREMENTAL PROGRESS CHECKPOINTING (read side).
// factory.js's checkpointProgress() writes state/items/<id>/progress.json at 4 phase boundaries
// mid-pipeline (post-verify, post-preband, post-gates, post-reaudit) — this module is the pure
// read/validate/summarize half, shared by cmdResume (per-item inflight line) and cmdReconstruct
// (missing-checkpoint diagnostics), so a killed run's LATEST reached stage is visible instead of a
// bare "no checkpoint — must re-run".
//
// Deliberately read-only / advisory: this module does NOT feed loadPriorAttempt or any relaunch
// reuse decision (that is KI-E138, a separate, larger change — see prior-attempt.mjs's own comment
// on why "verify onward always re-runs fresh" was drawn as a trust boundary, not an oversight). A
// progress.json existing changes what a human/controller SEES, never what a relaunch SKIPS.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Canonical pipeline order — presentation-only (phrases "what's left"), not authoritative over
// factory.js's own control flow. Kept here, alongside the stage-literal list the selftest greps
// factory.js for, so the two cannot silently drift apart without a visible assertion failure.
export const PROGRESS_STAGES = ['post-verify', 'post-preband', 'post-gates', 'post-reaudit'];

const REMAINING_AFTER = {
  'post-verify': 'the pre-band scan chain, the gate band, refute+re-audit, integrate',
  'post-preband': 'the gate band, refute+re-audit, integrate',
  'post-gates': 'refute+re-audit, integrate',
  'post-reaudit': 'integrate only',
};

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// Read + validate state/items/<id>/progress.json. `cyc`, when a number, fences it against the SAME
// resultId convention (id#cycle) result.json uses (KI-B4 fold idempotency) — for cmdResume/
// cmdReconstruct's DIAGNOSTIC display (KI-E137), where "which incident is this describing" matters
// and the item is being relaunched under the SAME cycle number. `cyc` is DELIBERATELY optional: a
// fresh `cmdGroup` re-claim (KI-E121's "CONTINUING" path — the documented, PREFERRED recovery route,
// "re-group — never Workflow-resume") stamps a NEW cycle number, so a strict fence would make
// gate-band reuse (KI-E139) permanently unreachable from that path — exactly the clock/generation
// trap KI-E121's own comment already diagnosed for plan/test/fix reuse ("a fresh claim stamps a NEW
// transition NOW, so every artifact on disk reads as stale even though nothing touched the
// worktree"). KI-E139 doesn't need the cycle fence for safety anyway: the content-hash check inside
// runItem() is strictly stronger proof than a cycle number ever was — id-only matching here is safe
// BECAUSE the real trust decision happens downstream, on a freshly-recomputed hash, never on this
// read alone. Never throws.
export function readProgressCheckpoint(itemDir, id, cyc) {
  const p = join(itemDir, 'progress.json');
  if (!existsSync(p)) return null;
  const pr = readJsonSafe(p);
  if (!pr || pr.id !== id) return null;
  if (typeof cyc === 'number' && pr.resultId !== id + '#' + cyc) return null;
  if (!PROGRESS_STAGES.includes(pr.progressStage)) return null; // unrecognized/corrupt stage tag — treat as absent, never guess
  return pr;
}

// One human-readable line: stage reached + a compact gate tally + what's still outstanding. Pure
// (no fs) — takes the object readProgressCheckpoint already validated.
export function summarizeProgress(pr) {
  if (!pr) return null;
  const gates = pr.gates || {};
  const gateKeys = Object.keys(gates);
  const tally = gateKeys.length ? gateKeys.map((k) => `${k}=${gates[k]}`).join(', ') : '(no gate/scan verdicts recorded yet)';
  const remaining = REMAINING_AFTER[pr.progressStage] || '(unknown remaining scope)';
  return `progress.json (KI-E137): stage '${pr.progressStage}' reached — ${tally} — remaining: ${remaining} (not yet reusable on relaunch, KI-E138; re-runs fresh from \`fix\` onward per SKILL.md § Recovery)`;
}
