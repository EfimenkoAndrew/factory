// Model router — resolves a task-type route key to {model, effort} from
// config/model-routing.json. Used by the driver to stamp each work item / agent
// call with its model + effort, and surfaced to factory.js via args so the
// Workflow does not need to read the file itself.
import { readFileSync } from 'node:fs';

export function loadRouting(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Resolve a route key (e.g. "fixer.critical", "gate.security", "reporter") to
// { model, effort }. Honours the route's escalate_effort when escalate=true.
// Unknown keys fall back to routing.defaults. Returns a plain object; never throws
// on an unknown key (the factory must keep running).
export function resolve(routing, key, opts) {
  const o = opts || {};
  const routes = routing.routes || {};
  const def = routing.defaults || { model: 'claude-sonnet-5', effort: 'medium' };
  const r = routes[key];
  if (!r) return { model: def.model, effort: def.effort, key: key, fallback: true, skill: null };
  let effort = r.effort === 'inherit' ? def.effort : r.effort || def.effort;
  if (o.escalate && r.escalate_effort) effort = r.escalate_effort;
  const model = r.model === 'inherit-audit-wave' ? null : r.model; // null => inherit session model (re-auditor reuses audit-wave routing)
  return { model: model, effort: effort, key: key, budgetGated: !!r.budget_gated, when: r.when || null, skill: r.skill || null };
}

// Concurrency for the current throttle posture: 'throttled' | 'normal' | 'max'.
export function concurrencyFor(routing, posture) {
  const c = routing.concurrency || {};
  return c[posture] || c.default || 3;
}
