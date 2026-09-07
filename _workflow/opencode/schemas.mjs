// tools/ai-factory/_workflow/opencode/schemas.mjs
//
// OPENCODE ADAPTER (KI-O1 — see KNOWN-ISSUES.md). This directory is an ALTERNATE runtime binding
// for the factory: it re-implements the parts of `_workflow/factory.js` that are pure/deterministic
// logic (schemas, routing, prompt composition, build/test execution) so a session WITHOUT Claude
// Code's native `Workflow` tool (e.g. an OpenCode session) can still drive one item through the
// SAME lifecycle and hand `driver.mjs fold` a contract-compatible result.json.
//
// This file: the structured-output schemas every phase's subagent call must satisfy, copied
// VERBATIM (field-for-field) from `_workflow/factory.js` (search that file for the same CONST
// names to diff them — keep both copies in sync, exactly like factory.js's own inlined-helper
// convention for lib/acceptance.mjs / lib/pool.mjs). Plus a minimal zero-dependency validator
// covering exactly the JSON-Schema subset these schemas use (type/required/additionalProperties/
// properties/items/enum/pattern) — NOT a general JSON-Schema implementation.

export const FINDING = { type: 'object', additionalProperties: false, required: ['severity', 'title'], properties: { severity: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' }, fix: { type: 'string' } } };

// KI-E101: `steps` is the OPTIONAL structured decomposition of `approach` (2-8 individually
// checkable units of work) that the pre-band plan-scan probes one-by-one against the final diff.
// KI-E112: this port now DISPATCHES that scan (planNext's plancommit trio) and reads this field via
// normalizePlanSteps, so it is live input rather than — as this comment previously said — a field
// the port "accepts and validates but never acts on". Optional by design: a planner that omits it,
// and a plan authored before the field existed, both validate exactly as before.
export const PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['rootCause', 'approach', 'recommendScopeStop', 'recommendEscalate'], properties: { rootCause: { type: 'string' }, approach: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } }, testStrategy: { type: 'string' }, blastRadius: { type: 'string' }, ruleRisks: { type: 'string' }, recommendEscalate: { type: 'boolean' }, recommendScopeStop: { type: 'boolean' } } };
// KI-E134 — the narrow follow-up ask fired when a plan's own approach/blastRadius carries commitment
// language ("MUST"/"required to") but `steps` came back missing/under-decomposed: a SINGLE cheap
// bounded call (never a second full plan). Byte-identical to factory.js's copy (schema-parity gate).
export const PLAN_STEPS_NUDGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['steps', 'note'], properties: { steps: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } };

export const TEST_SCHEMA = { type: 'object', additionalProperties: false, required: ['red', 'note'], properties: { red: { type: 'boolean' }, verificationOnly: { type: 'boolean' }, testFiles: { type: 'array', items: { type: 'string' } }, runCmd: { type: 'string' }, baselineFailures: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' }, note: { type: 'string' } } };

// KI-O2: `divergence` is typed `['string','null','object']` — factory.js's FIX_SCHEMA in this PR
// already carries the same widened type (the upstream fix landed; both copies are in sync, and the
// schema-parity selftest pins them equal). The object arm exists because `agents/fixer.md`'s brief
// asks for "divergence (null or {rule, ledgerAnchor})" — an object shape the original
// `['string','null']` typing rejected on a real, brief-conforming fixer response (live 2026-07-28).
// Nothing downstream (driver.mjs, lib/*.mjs, factory.js itself) reads `.divergence`
// programmatically — it is purely informational for human fold review.
export const FIX_SCHEMA = { type: 'object', additionalProperties: false, required: ['applied', 'scopeStop', 'summary'], properties: { applied: { type: 'boolean' }, filesChanged: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, scopeStop: { type: 'boolean' }, divergence: { type: ['string', 'null', 'object'] }, note: { type: 'string' } } };

const STRARR = { type: 'array', items: { type: 'string' } };

export const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['build', 'targetedTest', 'suite'], properties: { build: { type: 'string', pattern: '^(pass|fail)' }, targetedTest: { type: 'string', pattern: '^(pass|fail)' }, suite: { type: 'object', additionalProperties: true }, realInfraExercised: {}, realInfraKind: { type: 'string' }, dockerAbsent: { type: 'boolean' }, failingTests: STRARR, newFailures: STRARR, baselineFailures: STRARR, debris: STRARR, evidence: { type: 'string' }, note: { type: 'string' }, mainDriftOwnFiles: { type: 'boolean' } } }; // KI-E144B (ported): kept byte-identical to canon's VERIFY_SCHEMA — this port has no main-check equivalent to wire the field into (schema-parity only, per the established KI-E139/E141 convention).

export const GATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['gate', 'verdict', 'headline'], properties: { gate: { type: 'string' }, verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUIRED'] }, findings: { type: 'array', items: FINDING }, scopeViolation: { type: 'boolean' }, acceptanceMet: { type: 'boolean' }, redGreenConfirmed: { type: 'boolean' }, headline: { type: 'string' } } };

export const REFUTE_SCHEMA = { type: 'object', additionalProperties: false, required: ['refuted', 'headline'], properties: { refuted: { type: 'boolean' }, severity: { type: 'string' }, attack: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } }, headline: { type: 'string' } } };

export const REAUDIT_SCHEMA = { type: 'object', additionalProperties: false, required: ['converged', 'findingGone', 'headline'], properties: { converged: { type: 'boolean' }, findingGone: { type: 'boolean' }, newFindings: { type: 'array', items: FINDING }, headline: { type: 'string' } } };

export const INTEG_SCHEMA = { type: 'object', additionalProperties: false, required: ['globalGreen', 'handoff'], properties: { globalGreen: { type: 'boolean' }, branch: { type: 'string' }, changedFiles: { type: 'array', items: { type: 'string' } }, regressionDelta: { type: 'number' }, handoff: { type: 'string' }, note: { type: 'string' } } };

export const ADJUDICATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict', 'headline'], properties: { verdict: { type: 'string', enum: ['UPHELD', 'OVERRULED'] }, reasons: { type: 'array', items: { type: 'string' } }, headline: { type: 'string' } } };

export const DECISION_SCHEMA = { type: 'object', additionalProperties: false, required: ['decision', 'recommendation', 'headline'], properties: { decision: { type: 'string' }, options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { option: { type: 'string' }, consequence: { type: 'string' } } } }, recommendation: { type: 'string' }, headline: { type: 'string' } } };

export const ACCEPT_SCHEMA = { type: 'object', additionalProperties: false, required: ['covered'], properties: { covered: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['clause', 'why'], properties: { clause: { type: 'string' }, why: { type: 'string' } } } } } };

// KI-O1 fix: `line` is a STRING in the real schema (not a number as this port originally had it —
// a real subagent returning e.g. "42" was being wrongly rejected). `file`/`why` are required on each
// punt, and the punt object itself is additionalProperties:false, matching factory.js exactly.
export const LEFTOVER_SCHEMA = { type: 'object', additionalProperties: false, required: ['clean'], properties: { clean: { type: 'boolean' }, punts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'why'], properties: { file: { type: 'string' }, line: { type: 'string' }, why: { type: 'string' } } } } } };

export const PROBE_SCHEMA = { type: 'object', additionalProperties: false, required: ['markerFound'], properties: { markerFound: { type: 'boolean' }, line: { type: 'string' } } };

// KI-E83 — the RED-proof contract. KI-E112: the port now enforces this guard MECHANICALLY in
// afterVerify (parseRedRaw over verify-red-raw.txt on disk, incl. KI-L55's inverted verificationOnly
// polarity), so this schema is kept for parity with canon's agent-relay shape rather than because the
// check is missing. See opencode/stage-parity.mjs, which the selftest enforces against both files.
export const RED_PROOF_SCHEMA = { type: 'object', additionalProperties: false, required: ['markerFound', 'exitCode'], properties: { markerFound: { type: 'boolean' }, exitCode: { type: 'number' }, line: { type: 'string' } } };

// KI-E87 + KI-E101 — the plan-commitment/plan-step contract. KI-E112: this stage IS dispatched by the
// port (the plancommit/plancommit_amend/plancommit_reprobe trio in planNext), so this schema is live,
// not documentation.
export const PLAN_COMMITMENT_SCHEMA = { type: 'object', additionalProperties: false, required: ['honored'], properties: { honored: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['commitment', 'why'], properties: { commitment: { type: 'string' }, why: { type: 'string' } } } } } };

// KI-E91 — the ledger-anchor contract. KI-E112: this stage IS dispatched by the port (mechanical
// STEP-1 via build-test.sh ledger-anchor in `mech leftover`, then the ledger_anchor_classify agent
// step), so this schema is live, not documentation.
export const LEDGER_ANCHOR_SCHEMA = { type: 'object', additionalProperties: false, required: ['clean'], properties: { clean: { type: 'boolean' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['anchor', 'file', 'why'], properties: { anchor: { type: 'string' }, file: { type: 'string' }, why: { type: 'string' } } } } } };

// KI-E104 — the root-cause-touch contract. KI-E112: the port enforces this guard MECHANICALLY in
// afterVerify (nonTestChanged over the worktree diff), so this schema is kept for parity with canon's
// agent-relay shape rather than because the check is missing. Field is `nonTestCount`, not `count`,
// because zero here means FAILURE while COMMENT_SCHEMA's `count` zero means success.
export const ROOTCAUSE_SCHEMA = { type: 'object', additionalProperties: false, required: ['nonTestCount'], properties: { nonTestCount: { type: 'number' }, files: { type: 'array', items: { type: 'string' } }, skipped: { type: 'boolean' } } };

export const SWEEP_DESIGN_SCHEMA = { type: 'object', additionalProperties: false, required: ['pattern', 'headline'], properties: { pattern: { type: 'string' }, applicationNotes: { type: 'string' }, conformanceCheck: { type: 'string' }, headline: { type: 'string' } } };

export const CHECKPOINT_SCHEMA = { type: 'object', additionalProperties: false, required: ['written'], properties: { written: { type: 'boolean' }, note: { type: 'string' } } };

// Registry keyed by the same schema-name string the runtime.mjs CLI accepts on `submit --schema <name>`.
export const SCHEMAS = {
  PLAN_SCHEMA, PLAN_STEPS_NUDGE_SCHEMA, TEST_SCHEMA, FIX_SCHEMA, VERIFY_SCHEMA, GATE_SCHEMA, REFUTE_SCHEMA, REAUDIT_SCHEMA,
  INTEG_SCHEMA, ADJUDICATE_SCHEMA, DECISION_SCHEMA, ACCEPT_SCHEMA, LEFTOVER_SCHEMA, PROBE_SCHEMA,
  SWEEP_DESIGN_SCHEMA, CHECKPOINT_SCHEMA,
};

function typeOk(val, t) {
  if (Array.isArray(t)) return t.some((tt) => typeOk(val, tt));
  if (t === 'null') return val === null;
  if (t === 'array') return Array.isArray(val);
  if (t === 'object') return val !== null && typeof val === 'object' && !Array.isArray(val);
  if (t === 'string') return typeof val === 'string';
  if (t === 'boolean') return typeof val === 'boolean';
  if (t === 'number') return typeof val === 'number' && Number.isFinite(val);
  return true; // unknown declared type -> permissive
}

// Minimal recursive validator for the JSON-Schema SUBSET the schemas above actually use.
// Returns { ok:true } or { ok:false, errors:[string,...] } — never throws.
export function validate(schema, value, path) {
  const p = path || '$';
  const errors = [];
  if (!schema || typeof schema !== 'object') return { ok: true };
  if (schema.type && !typeOk(value, schema.type)) {
    errors.push(`${p}: expected type ${JSON.stringify(schema.type)}, got ${value === null ? 'null' : typeof value}`);
    return { ok: false, errors }; // type mismatch makes deeper checks meaningless
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${p}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${p}: "${value}" does not match pattern ${schema.pattern}`);
  if (schema.type === 'object' || (!schema.type && schema.properties)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const req of schema.required || []) {
        if (!(req in value)) errors.push(`${p}: missing required field "${req}"`);
      }
      if (schema.additionalProperties === false && schema.properties) {
        for (const k of Object.keys(value)) {
          if (!(k in schema.properties)) errors.push(`${p}: unexpected additional property "${k}"`);
        }
      }
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (k in value) {
          const r = validate(sub, value[k], `${p}.${k}`);
          if (!r.ok) errors.push(...r.errors);
        }
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((v, i) => {
      const r = validate(schema.items, v, `${p}[${i}]`);
      if (!r.ok) errors.push(...r.errors);
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateNamed(schemaName, value) {
  const schema = SCHEMAS[schemaName];
  if (!schema) return { ok: false, errors: [`unknown schema "${schemaName}"`] };
  return validate(schema, value);
}
