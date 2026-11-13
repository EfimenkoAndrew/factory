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

export const FINDING = { type: 'object', additionalProperties: false, required: ['severity', 'title'], properties: { severity: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' }, fix: { type: 'string' }, cosmetic: { type: 'boolean' } } };

// KI-E358 — CosmeticValidate probe: a haiku agent answers the critical question before firing the
// cosmetic-patcher: "Are ALL of these findings truly cosmetic — only comment text or doc-string
// wording, zero impact on logic, signatures, or tests?" The patcher fires only when the haiku agrees
// with confidence >= 0.85; otherwise the block falls through to normal failedBlk handling.
export const COSMETIC_VALIDATE_SCHEMA = { type: 'object', additionalProperties: false, required: ['all_cosmetic', 'confidence'], properties: { all_cosmetic: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 } } };

// KI-E101: `steps` is the OPTIONAL structured decomposition of `approach` (2-8 individually
// checkable units of work) that the pre-band plan-scan probes one-by-one against the final diff.
// KI-E112: this port now DISPATCHES that scan (planNext's plancommit trio) and reads this field via
// normalizePlanSteps, so it is live input rather than — as this comment previously said — a field
// the port "accepts and validates but never acts on". Optional by design: a planner that omits it,
// and a plan authored before the field existed, both validate exactly as before.
// KI-E460 (host-local) — the archaeologist role's output contract. Dispatched by runtime.mjs's
// 'research' phase when the host's archaeology policy is on for a non-mechanical, doc-map-less item.
export const ARCHAEOLOGY_SCHEMA = { type: 'object', additionalProperties: false, required: ['validated', 'findings'], properties: { validated: { type: 'boolean' }, findings: { type: 'string' }, openQuestions: { type: 'string' }, docsUpdated: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' }, note: { type: 'string' } } };

export const PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['rootCause', 'approach', 'recommendScopeStop', 'recommendEscalate'], properties: { rootCause: { type: 'string' }, approach: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } }, testStrategy: { type: 'string' }, blastRadius: { type: 'string' }, ruleRisks: { type: 'string' }, recommendEscalate: { type: 'boolean' }, recommendScopeStop: { type: 'boolean' } } };
// KI-E134 — the narrow follow-up ask fired when a plan's own approach/blastRadius carries commitment
// language ("MUST"/"required to") but `steps` came back missing/under-decomposed: a SINGLE cheap
// bounded call (never a second full plan). Byte-identical to factory.js's copy (schema-parity gate).
export const PLAN_STEPS_NUDGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['steps', 'note'], properties: { steps: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } };

// KI-E143C (ported from a host-mount session): `realInfraOverride` added for schema-parity with
// factory.js's TEST_SCHEMA — structurally inert here (this runtime has no adjudication routing for
// it, see stage-parity.mjs), same posture as FIX_SCHEMA's `deviations` field above.
export const TEST_SCHEMA = { type: 'object', additionalProperties: false, required: ['red', 'note'], properties: { red: { type: 'boolean' }, verificationOnly: { type: 'boolean' }, testFiles: { type: 'array', items: { type: 'string' } }, runCmd: { type: 'string' }, baselineFailures: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' }, note: { type: 'string' }, realInfraOverride: { type: ['string', 'null'] } } };

// KI-O2: `divergence` is typed `['string','null','object']` — factory.js's FIX_SCHEMA in this PR
// already carries the same widened type (the upstream fix landed; both copies are in sync, and the
// schema-parity selftest pins them equal). The object arm exists because `agents/fixer.md`'s brief
// asks for "divergence (null or {rule, ledgerAnchor})" — an object shape the original
// `['string','null']` typing rejected on a real, brief-conforming fixer response (live 2026-07-28).
// Nothing downstream (driver.mjs, lib/*.mjs, factory.js itself) reads `.divergence`
// programmatically — it is purely informational for human fold review.
export const FIX_SCHEMA = { type: 'object', additionalProperties: false, required: ['applied', 'scopeStop', 'summary'], properties: { applied: { type: 'boolean' }, filesChanged: { type: 'array', items: { type: 'string' }, description: 'ONLY files THIS step itself created or modified via a tool call this turn. Never include a file you merely read, referenced, relied on, or re-verified — including one an earlier step or the test-author already wrote correctly. A step that changed nothing this turn returns an empty array, not someone else\'s file (KI-E181).' }, summary: { type: 'string' }, scopeStop: { type: 'boolean' }, divergence: { type: ['string', 'null', 'object'] }, note: { type: 'string' }, deviations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['commitment', 'reason'], properties: { commitment: { type: 'string' }, reason: { type: 'string' } } } } } };

const STRARR = { type: 'array', items: { type: 'string' } };

export const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['build', 'targetedTest', 'suite'], properties: { build: { type: 'string', pattern: '^(pass|fail)' }, targetedTest: { type: 'string', pattern: '^(pass|fail)' }, suite: { type: 'object', additionalProperties: true }, realInfraExercised: {}, realInfraKind: { type: 'string' }, dockerAbsent: { type: 'boolean' }, failingTests: STRARR, newFailures: STRARR, baselineFailures: STRARR, debris: STRARR, evidence: { type: 'string' }, note: { type: 'string' } } }; // KI-E145 (ported from a host-mount session): kept byte-identical to canon's VERIFY_SCHEMA. `mainDriftOwnFiles` briefly lived here (KI-E144B) as the runner's own closed boolean answer — an improvement on free-text regex-matching, but still a self-report. Now superseded there: an INDEPENDENT probe (main-drift-probe, PROBE_SCHEMA) re-derives the fact directly from the teed evidence file, matching this pipeline's own established posture (KI-E10/E83/E104) of never trusting an agent's claim about its own evidence. Removed from here rather than left as a dead field nothing reads.

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
// Schema-parity only: canon-only in behavior (this port's post-amend-verify equivalent is entirely
// UNPORTED — see stage-parity.mjs `postamend-probe`), kept byte-identical to factory.js's copy.
// KI-E408 added suiteExitZero (2026-10-30).
export const POSTAMEND_SCHEMA = { type: 'object', additionalProperties: false, required: ['buildExitZero', 'filterExitZero'], properties: { buildExitZero: { type: 'boolean' }, filterExitZero: { type: 'boolean' }, suiteExitZero: { type: 'boolean' }, guardRefusedSeen: { type: 'boolean' } } };
// Schema-parity only: canon dispatches this in a class-exist-probe stage (KI-E409, 2026-10-30 —
// UNPORTED in this port, see stage-parity.mjs `class-exist-probe`), kept byte-identical.
export const CLASS_EXIST_SCHEMA = { type: 'object', additionalProperties: false, required: ['found', 'className'], properties: { found: { type: 'boolean' }, className: { type: 'string' }, notes: { type: 'string' } } };

// Schema-parity only: canon dispatches this in a post-fix-class-sync-probe stage (KI-E418, 2026-10-30 —
// UNPORTED in this port, see stage-parity.mjs `post-fix-class-sync-probe`), kept byte-identical.
export const CLASS_SYNC_SCHEMA = { type: 'object', additionalProperties: false, required: ['mismatchFound'], properties: { mismatchFound: { type: 'boolean' }, runCmdClass: { type: 'string' }, newClasses: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } };

// KI-E83 — the RED-proof contract. KI-E112: the port now enforces this guard MECHANICALLY in
// afterVerify (parseRedRaw over verify-red-raw.txt on disk, incl. KI-L55's inverted verificationOnly
// polarity), so this schema is kept for parity with canon's agent-relay shape rather than because the
// check is missing. See opencode/stage-parity.mjs, which the selftest enforces against both files.
export const RED_PROOF_SCHEMA = { type: 'object', additionalProperties: false, required: ['markerFound', 'exitCode'], properties: { markerFound: { type: 'boolean' }, exitCode: { type: 'number' }, line: { type: 'string' } } };
export const RED_COVERAGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['covered'], properties: { covered: { type: 'boolean' }, gap: { type: ['string', 'null'] } } };

// KI-E87 + KI-E101 — the plan-commitment/plan-step contract. KI-E112: this stage IS dispatched by the
// port (the plancommit/plancommit_amend/plancommit_reprobe trio in planNext), so this schema is live,
// not documentation.
// KI-E372: confidence field added — gate plan revision on confidence ≥ 0.80.
export const PLAN_COMMITMENT_SCHEMA = { type: 'object', additionalProperties: false, required: ['honored'], properties: { honored: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['commitment', 'why'], properties: { commitment: { type: 'string' }, why: { type: 'string' } } } } } };

// KI-E373: Tree of Thought plan-branching schemas. PLAN_SKETCH_SCHEMA captures a 1-3 sentence
// structural approach + key files (brief, NOT a full plan). PLAN_SKETCH_JUDGE_SCHEMA selects the better
// of two sketches (A or B) with a one-sentence reason.
export const PLAN_SKETCH_SCHEMA = { type: 'object', additionalProperties: false, required: ['approach'], properties: { approach: { type: 'string' }, keyFiles: { type: 'array', items: { type: 'string' } } } };
export const PLAN_SKETCH_JUDGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['winner', 'reason'], properties: { winner: { type: 'string', enum: ['A', 'B'] }, reason: { type: 'string' } } };

// KI-E91 — the ledger-anchor contract. KI-E112: this stage IS dispatched by the port (mechanical
// STEP-1 via build-test.sh ledger-anchor in `mech leftover`, then the ledger_anchor_classify agent
// step), so this schema is live, not documentation.
export const LEDGER_ANCHOR_SCHEMA = { type: 'object', additionalProperties: false, required: ['clean'], properties: { clean: { type: 'boolean' }, findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['anchor', 'file', 'why'], properties: { anchor: { type: 'string' }, file: { type: 'string' }, why: { type: 'string' } } } } } };

// KI-E104 — the root-cause-touch contract. KI-E112: the port enforces this guard MECHANICALLY in
// afterVerify (nonTestChanged over the worktree diff), so this schema is kept for parity with canon's
// agent-relay shape rather than because the check is missing. Field is `nonTestCount`, not `count`,
// because zero here means FAILURE while COMMENT_SCHEMA's `count` zero means success.
export const ROOTCAUSE_SCHEMA = { type: 'object', additionalProperties: false, required: ['nonTestCount'], properties: { nonTestCount: { type: 'number' }, files: { type: 'array', items: { type: 'string' } }, skipped: { type: 'boolean' } } };

// KI-E486 — the phantom-manifest contract, its sibling. Enforced MECHANICALLY in afterVerify
// (phantomManifest over the worktree diff + progress.res.filesChanged, no agent call at all) — kept
// here for the SAME schema-parity reason ROOTCAUSE_SCHEMA is (byte-identical to canon's copy, even
// though this runtime never dispatches the agent-relay shape it describes).
// KI-E371: confidence field added — only fail hard on phantom detections when confidence ≥ 0.90.
export const PHANTOM_SCHEMA = { type: 'object', additionalProperties: false, required: ['phantomCount'], properties: { phantomCount: { type: 'number' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, files: { type: 'array', items: { type: 'string' } }, skipped: { type: 'boolean' } } };

export const EFMIGRATION_SCHEMA = { type: 'object', additionalProperties: false, required: ['results'], properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['service', 'verdict'], properties: { service: { type: 'string' }, verdict: { type: 'string' } } } } } };

// KI-E241: ShellcheckScan probe — copied VERBATIM from factory.js's SHELLCHECK_SCAN_SCHEMA.
// Schema-parity-only (see stage-parity.mjs's UNPORTED['shellcheck-probe']) — this runtime never
// dispatches the agent-relay shape it describes, same posture as CONCURRENCY_SCAN_SCHEMA/
// VACUOUS_TEST_SCAN_SCHEMA above (unlike EFMIGRATION_SCHEMA, which IS ported — see stage-parity.mjs's
// MECHANICAL set).
export const SHELLCHECK_SCAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['results'], properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'verdict', 'notableCount'], properties: { file: { type: 'string' }, verdict: { type: 'string' }, notableCount: { type: 'number' } } } } } };

// KI-E237: ConcurrencyScan probe — copied VERBATIM from factory.js's CONCURRENCY_SCAN_SCHEMA. Schema-
// parity-only (see stage-parity.mjs's UNPORTED['concurrency-scan-probe']) — this runtime never
// dispatches the agent-relay shape it describes, same posture as PHANTOM_SCHEMA above.
export const CONCURRENCY_SCAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['touchesConcurrency'], properties: { touchesConcurrency: { type: 'boolean' }, hits: { type: 'array', items: { type: 'string' } } } };

// KI-E238: VacuousTestScan probe — copied VERBATIM from factory.js's VACUOUS_TEST_SCAN_SCHEMA.
// Schema-parity-only (see stage-parity.mjs's UNPORTED['vacuous-test-scan-probe']) — this runtime
// never dispatches the agent-relay shape it describes, same posture as CONCURRENCY_SCAN_SCHEMA above.
export const VACUOUS_TEST_SCAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['clean'], properties: { clean: { type: 'boolean' }, hits: { type: 'array', items: { type: 'string' } } } };

export const SWEEP_DESIGN_SCHEMA = { type: 'object', additionalProperties: false, required: ['pattern', 'headline'], properties: { pattern: { type: 'string' }, applicationNotes: { type: 'string' }, conformanceCheck: { type: 'string' }, headline: { type: 'string' } } };

export const CHECKPOINT_SCHEMA = { type: 'object', additionalProperties: false, required: ['written'], properties: { written: { type: 'boolean' }, note: { type: 'string' } } };

export const PACK_HASH_SCHEMA = { type: 'object', additionalProperties: false, required: ['hash'], properties: { hash: { type: 'string' } } };

export const SHADOW_SCAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['acceptanceCovered', 'planHonored', 'findingHonored'], properties: { acceptanceCovered: { type: 'boolean' }, planHonored: { type: 'boolean' }, findingHonored: { type: 'boolean' } } };

// KI-E462: RegistrationDriftScan probe — copied VERBATIM from factory.js's REGISTRATION_DRIFT_SCHEMA
// (schema-parity selftest pins the two byte/structure-identical). Same clean+classify shape as
// LEFTOVER_SCHEMA (a judgment call — is the divergence ledgered? — not a zero-tolerance rule like
// COMMENT_SCHEMA), so unlike COMMENT_SCHEMA it is NOT grandfathered onto the disclosed-gap allowlist:
// it gets a real deterministic-scan + LLM-classify-on-hit port in runtime.mjs (mech step
// 'registration_drift' + phase 'registration_drift_classify').
export const REGISTRATION_DRIFT_SCHEMA = { type: 'object', additionalProperties: false, required: ['clean'], properties: { clean: { type: 'boolean' }, unresolved: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'method', 'why'], properties: { file: { type: 'string' }, method: { type: 'string' }, why: { type: 'string' } } } } } };

// KI-E479: DocSyncScan probe — copied VERBATIM from factory.js's DOCSYNC_SCHEMA (the schema-parity
// selftest deep-equals the two, so a drift here is a build-time failure, not a silent fork).
export const DOCSYNC_SCHEMA = { type: 'object', additionalProperties: false, required: ['clean'], properties: { clean: { type: 'boolean' }, unresolved: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['service', 'doc', 'why'], properties: { service: { type: 'string' }, doc: { type: 'string' }, why: { type: 'string' } } } } } };

// KI-E434 — baseline compile pre-flight schema. Copied VERBATIM from factory.js's BASELINE_COMPILE_SCHEMA.
// Schema-parity-only (see stage-parity.mjs's UNPORTED['baseline-compile-probe']) — this runtime never
// dispatches the haiku baseline-compile-probe call, same posture as CONCURRENCY_SCAN_SCHEMA/VACUOUS_TEST_SCAN_SCHEMA
// above. The probe aborts an item early when the test suite doesn't compile due to pre-existing errors
// outside the item's claimed files, saving the full Opus pipeline cost. This port has no equivalent
// pre-pipeline compile check.
export const BASELINE_COMPILE_SCHEMA = { type: 'object', additionalProperties: false, required: ['compiles'], properties: { compiles: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } } } };

// Schema-parity mirrors for factory.js probes that have no opencode-runtime equivalent (the probe is
// dispatched only in the main-loop path; the opencode port has no equivalent call site).
// CONFIDENCE_SCHEMA (KI-E83 confidence-probe, haiku/low pre-band sanity check) and
// PRE_ARCH_SCHEMA (KI-E405 pre-architect-probe, haiku/low gate:architect-rejection pre-filter).
export const CONFIDENCE_SCHEMA ={ type: 'object', additionalProperties: false, required: ['confidence', 'concerns'], properties: { confidence: { type: 'number', minimum: 1, maximum: 5 }, concerns: { type: 'array', items: { type: 'string' } } } };
export const PRE_ARCH_SCHEMA = { type: 'object', required: ['clean'], properties: { clean: { type: 'boolean' }, violations: { type: 'array', items: { type: 'object', required: ['file', 'kind', 'fix'], properties: { file: { type: 'string' }, kind: { type: 'string' }, fix: { type: 'string' } } } } } };
// PRE_DEV_SCHEMA (KI-E442 pre-developer-probe, haiku/low code-quality pre-filter: unused using directives, misleading test names, wrong assertions).
export const PRE_DEV_SCHEMA = { type: 'object', required: ['clean'], properties: { clean: { type: 'boolean' }, findings: { type: 'array', items: { type: 'object', required: ['file', 'kind', 'fix'], properties: { file: { type: 'string' }, kind: { type: 'string' }, line: { type: 'number' }, fix: { type: 'string' } } } } } };
// SE_SCHEMA (KI-E447 standards-evolution tag preservation probe: catches stripped `// standards-evolution:` comments whose ledger entries are still Open/Migrating).
export const SE_SCHEMA = { type: 'object', required: ['clean'], properties: { clean: { type: 'boolean' }, violations: { type: 'array', items: { type: 'object', required: ['file', 'removedTag', 'anchor'], properties: { file: { type: 'string' }, line: { type: 'number' }, removedTag: { type: 'string' }, anchor: { type: 'string' }, ledgerStatus: { type: 'string' } } } } } };
// PREFLIGHT_SCHEMA (KI-E459 preflight-review-probe, haiku/low cheap mirror of the expensive qa/code-review/review-adversarial-general gates' broadest judgment calls, for non-mechanical code items before the full gate band).
export const PREFLIGHT_SCHEMA = { type: 'object', required: ['clean'], properties: { clean: { type: 'boolean' }, findings: { type: 'array', items: { type: 'object', required: ['title', 'file', 'severity', 'scenario'], properties: { title: { type: 'string' }, file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string', enum: ['CRITICAL', 'HIGH'] }, scenario: { type: 'string' } } } } } };

// Registry keyed by the same schema-name string the runtime.mjs CLI accepts on `submit --schema <name>`.
// This host's local additions (ARCHAEOLOGY_SCHEMA / REGISTRATION_DRIFT_SCHEMA / DOCSYNC_SCHEMA) are
// genuinely load-bearing here (runtime.mjs dispatches all three); PHANTOM_SCHEMA/POSTAMEND_SCHEMA
// stay schema-parity-only, matching canon's own registry composition.
export const SCHEMAS = {
  ARCHAEOLOGY_SCHEMA, REGISTRATION_DRIFT_SCHEMA, DOCSYNC_SCHEMA,
  PLAN_SCHEMA, PLAN_STEPS_NUDGE_SCHEMA, TEST_SCHEMA, FIX_SCHEMA, VERIFY_SCHEMA, GATE_SCHEMA, REFUTE_SCHEMA, REAUDIT_SCHEMA,
  INTEG_SCHEMA, ADJUDICATE_SCHEMA, DECISION_SCHEMA, ACCEPT_SCHEMA, LEFTOVER_SCHEMA, PROBE_SCHEMA, POSTAMEND_SCHEMA,
  SWEEP_DESIGN_SCHEMA, CHECKPOINT_SCHEMA, PLAN_COMMITMENT_SCHEMA, PLAN_SKETCH_SCHEMA, PLAN_SKETCH_JUDGE_SCHEMA, LEDGER_ANCHOR_SCHEMA, COSMETIC_VALIDATE_SCHEMA,
  RED_COVERAGE_SCHEMA, RED_PROOF_SCHEMA, ROOTCAUSE_SCHEMA, PHANTOM_SCHEMA, EFMIGRATION_SCHEMA, CONCURRENCY_SCAN_SCHEMA, VACUOUS_TEST_SCAN_SCHEMA, SHELLCHECK_SCAN_SCHEMA, PACK_HASH_SCHEMA, SHADOW_SCAN_SCHEMA,
  CLASS_EXIST_SCHEMA,
  CLASS_SYNC_SCHEMA,
  SE_SCHEMA,
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
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const req of schema.required || []) {
        if (!Object.hasOwn(value, req)) errors.push(`${p}: missing required field "${req}"`);
      }
      for (const k of Object.keys(value)) {
        if (Object.hasOwn(schema.properties || {}, k)) continue;
        if (schema.additionalProperties === false) errors.push(`${p}: unexpected additional property "${k}"`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          const r = validate(schema.additionalProperties, value[k], `${p}.${k}`);
          if (!r.ok) errors.push(...r.errors);
        }
      }
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (Object.hasOwn(value, k)) {
          const r = validate(sub, value[k], `${p}.${k}`);
          if (!r.ok) errors.push(...r.errors);
        }
      }
  }
  if (Array.isArray(value) && schema.items) {
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
