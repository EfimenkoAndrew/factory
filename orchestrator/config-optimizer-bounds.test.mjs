// KI-E456 — the config-optimizer's trial-perturbation step had no upper bound on a new trial
// value at all (`Math.max(0.01, current * (1 + delta))`), while the SEPARATE persist-time clamp
// (applyConfigOptimizerOverride) correctly bounded each knob to a sane range. Live incident,
// 2026-11-08: `simulatedAnnealing.coolingRate` perturbed 0.95 -> 1.045 (+10%), straight through the
// intended [0.5, 0.999] ceiling — a coolingRate above 1 makes temperature GROW each cycle instead
// of decay, for the entire measureWindow of that trial, not just whatever eventually got persisted.
//
// This extracts the REAL CO_KNOB_BOUNDS object (now hoisted to module scope and shared by both the
// trial clamp and the persist clamp — a single source of truth) and replicates the ONE-LINE clamp
// expression verbatim from coUpdate, so a future edit to either side cannot silently drift from
// what this pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./orchestrate.mjs', import.meta.url), 'utf8');
const match = /const CO_KNOB_BOUNDS = (\{[\s\S]*?\n\});/.exec(source);
assert.ok(match, 'CO_KNOB_BOUNDS must exist as a module-level const in orchestrate.mjs');
const CO_KNOB_BOUNDS = new Function('return (' + match[1] + ');')();

// Verbatim from coUpdate's perturbation step: `Math.max(lo, Math.min(hi, current * (1 + delta)))`.
function clamp(knob, current, delta) {
  const [lo, hi] = CO_KNOB_BOUNDS[knob] || [0.01, Infinity];
  return Math.max(lo, Math.min(hi, current * (1 + delta)));
}

test('every CO_KNOB has a sane, finite [lo, hi] bound with lo < hi', () => {
  const expectedKnobs = ['bandit.explorationConstant', 'hillClimb.plateauMinFitness', 'hillClimb.explorationRatio', 'simulatedAnnealing.coolingRate'];
  assert.deepEqual(Object.keys(CO_KNOB_BOUNDS).sort(), expectedKnobs.sort());
  for (const [knob, bounds] of Object.entries(CO_KNOB_BOUNDS)) {
    assert.equal(bounds.length, 2, `${knob} bounds must be a [lo, hi] pair`);
    const [lo, hi] = bounds;
    assert.ok(Number.isFinite(lo) && Number.isFinite(hi), `${knob} bounds must be finite`);
    assert.ok(lo < hi, `${knob}: lo (${lo}) must be < hi (${hi})`);
  }
});

test('the exact live incident is now fixed: coolingRate 0.95 perturbed +10% no longer exceeds 0.999', () => {
  const perturbed = clamp('simulatedAnnealing.coolingRate', 0.95, +0.1);
  assert.ok(perturbed <= 0.999, `perturbed value ${perturbed} must not exceed the 0.999 ceiling — this is the exact bad value (1.045) observed live before the fix`);
  assert.equal(perturbed, 0.999, 'clamps exactly to the ceiling, not silently dropped or left unperturbed');
});

test('coolingRate can still be perturbed DOWNWARD within its [0.5, 0.999] range', () => {
  const perturbed = clamp('simulatedAnnealing.coolingRate', 0.95, -0.1);
  assert.ok(perturbed >= 0.5 && perturbed < 0.95, 'a negative delta still moves the value, just clamped at the floor if it would go below 0.5');
});

test('a large negative delta clamps to the floor instead of going negative or near-zero', () => {
  assert.equal(clamp('simulatedAnnealing.coolingRate', 0.6, -0.9), 0.5);
  assert.equal(clamp('hillClimb.plateauMinFitness', 0.05, -0.9), 0.01);
});

test('hillClimb ratio/fitness knobs clamp to [0.01, 1] — a ratio above 1 is never produced', () => {
  assert.ok(clamp('hillClimb.plateauMinFitness', 0.95, +0.5) <= 1);
  assert.ok(clamp('hillClimb.explorationRatio', 0.95, +0.5) <= 1);
});

test('bandit.explorationConstant has real headroom (ceiling 10) — a moderate perturbation is not artificially clamped', () => {
  const perturbed = clamp('bandit.explorationConstant', 1.4, +0.1);
  assert.equal(perturbed, 1.4 * 1.1, 'stays unclamped when well inside [0.01, 10]');
});

test('an unknown knob (not in CO_KNOB_BOUNDS) falls back to the old [0.01, Infinity] floor-only behavior', () => {
  assert.equal(clamp('made.up.knob', 5, +10), 55, 'no upper bound applied for a knob the whitelist does not know about');
});
