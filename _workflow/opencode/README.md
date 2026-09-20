# OpenCode runtime

Zero-dependency Node control plane for claimed factory items. It preserves the driver’s
single-writer ledger and emits ordinary fold-ready result envelopes. Agents receive independent
fresh sessions; implementation conversation history is never forked into a reviewer.
Persistence, admission, settlement and shared evidence contracts are specified in
[`RUNTIME-CONTRACT.md`](./RUNTIME-CONTRACT.md).

## Launch and dispatch

Initialize each driver-claimed item from its **claim-matched enriched launch**:

```text
node _workflow/opencode/runtime.mjs init ITEM --launch state/run-args-batch.json
node _workflow/opencode/dispatch.mjs --url http://127.0.0.1:4096 --ids ITEM,OTHER-ITEM
```

`--version v1|v2` and `--config <host-local-json>` are optional. Without a version, the entrypoint
discovers the documented v1 health or v2 info surface. Without a config path, it reads
`config/opencode-dispatch.local.json` if present. The older positional
`dispatcher.mjs <config.json> ITEM [OTHER-ITEM]` entrypoint remains supported.

Detection probes both identities in parallel, rejects ambiguous/authentication failures,
and validates explicit versions too. `OPENCODE_PASSWORD` (v2) or
`OPENCODE_SERVER_PASSWORD` supplies Basic auth; explicit dispatcher authorization headers
take precedence. V2 uses username `opencode`; v1 honors `OPENCODE_SERVER_USERNAME`.
Before new admission, the dispatcher waits for the selected effective worker profile:
`profileReadyTimeoutMs` defaults to 30000 and `profileReadyPollMs` to 250.
Health alone does not establish profile readiness. `apiDetectionTimeoutMs` defaults to 10000.

Without `--launch`, init locates the run-args counterpart of the ledger row’s `runScript`.
Cycle, claim timestamp, worktree and branch must agree. The attempt snapshots enriched item
fields, config, policies, role briefs, profiles and routes. Repeated init on the same claim is
refused; resume with `next` or the same dispatcher command. A new driver claim archives the
previous progress before initializing a new attempt. Existing progress is never silently erased.

Example **factory dispatcher config** (not OpenCode’s own config):

```json
{
  "url": "http://127.0.0.1:4096",
  "version": "v1",
  "agentConcurrency": 4,
  "buildConcurrency": 1,
  "agentTimeoutMs": 1200000,
  "pollMs": 1000,
  "models": {
    "claude-sonnet-4-6": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6", "agent": "build" }
  },
  "roles": {
    "gate-qa": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6", "agent": "build" }
  },
  "items": {
    "ITEM": { "target": "src/App.sln", "filter": "FullyQualifiedName~RegressionTests" }
  }
}
```

By default routes select the installed
`factory-{writer|reviewer|probe}-{mechanical|standard|strong|planning|cheap}` profiles, then query
the server's effective definitions in the worktree. Host model overrides are preserved. Explicit
model/role mappings override that selection, but the named agent must actually exist. Missing
profiles or models fail closed; there is no silent generic-worker/model fallback.
Actual returned models, unknown-or-reported token usage,
cost, attempt/dispatch/session IDs, input/prompt hashes and outcomes are persisted in
`state/items/<id>/dispatch/*-session.json`. These contain schema-validated physical dispatch
observations (`lib/observations.mjs`) and emit immutable `attempt_observation` events. Driver claimId
is the lifecycle attemptId; runId and attemptNumber are validated against the launch and ledger.
Only the driver emits lifecycle start/completion events and decides the final folded outcome.
Tokens/cost aggregate all assistant turns
for the one submitted input, including tool turns; unknown usage stays null. Replayed observations
deduplicate by run/dispatch identity. V2 routes may include `variant` or an
effort-to-variant `variants` map. The documented v1 request surface used here has no effort
field; configure worker agents as needed rather than sending invented request properties.
Confirmed server admission also persists an invocation receipt independently of model/usage data.
The receipt and physical observations travel in final result envelopes, including failed attempts.

One dispatcher owns the global batch. Its persisted batch membership/config identity prevents
a crashed batch being resumed as a smaller batch while old server workers remain active.
Agent concurrency is globally bounded across those items. Mechanical builds and worker-issued
build commands use `build-lease.mjs` filesystem slots, shared across processes. Worker prompts
replace the build-test entrypoint with this wrapper; it executes the same verify script.
Agents must follow the wrapper contract and must not spawn nested workers. Arbitrary direct
shell commands issued outside this runtime are not intercepted by a Node semaphore.
Unacknowledged server interruption stops new batch admission. Dead build-lease owners and build
timeouts retain their slots pending process-tree inspection, since child dotnet processes may
outlive a shell/controller. They are never automatically recycled merely because the owner died.

The dispatcher finalizes each terminal result, but **does not fold or mutate git**. The owner’s
controller folds the emitted envelopes with its controller token.

## Manual Task fallback

```text
node _workflow/opencode/runtime.mjs next ITEM
node _workflow/opencode/runtime.mjs submit ITEM --role KEY --dispatch DISPATCH-ID --json answer.json
node _workflow/opencode/runtime.mjs mech ITEM verify -- src/App.sln "FullyQualifiedName~RegressionTests"
node _workflow/opencode/runtime.mjs mech ITEM checkpoint
node _workflow/opencode/runtime.mjs finalize ITEM
```

`next` emits only pending compact descriptors: role/key, route, dispatch ID, prompt/schema file
reference and hashes. Read `promptRef` for the worker prompt. Submission advances exactly once;
call `next` afterwards. A repeated identical dispatch response is a no-op; a conflicting or
stale response is rejected. Mechanical commands are phase-guarded. `status` is compact.

`init --legacy` explicitly enables the historical role-only submission protocol and full prompt
output. Per-command `next --legacy` / `submit --legacy` are also available. Manual sessions
cannot honestly claim server-selected routing; their model is recorded as unknown unless supplied.

`fail ITEM --dispatch ID --reason "..." --retryable` records a failed physical attempt and creates
a new dispatch ID, at most three attempts by default (`config.dispatch.maxAttempts`). Omitting
`--retryable` fails the lane after every already-dispatched sibling has settled; the complete
pending set survives restart while draining. Timeouts in server dispatch are interrupted before retry.
An uncertain admission is recovered by durable message queries, never blindly re-posted. Potentially
live failures remain fenced until cancellation is proven. V2 shutdown cancels the durable inbox ID,
interrupts execution with `resume=false`, then rechecks inbox, active execution and tool state.
An `interrupted:false` response alone cannot prove termination.

## Evidence and recovery

- Required subprocesses must complete with matching target/filter START and keyed SUMMARY,
  consistent exit codes, and nonzero executed tests. Targeted failures cannot use suite baseline
  allowances. Missing/timeout/malformed evidence fails before reviewers.
  Suite exceptions require a pre-fix `captureBaseline` record matching both target and failed-test
  identities; count-only/name-only reports cannot authorize failures. Re-fix recaptures remain fenced.
- RED proof is required, including its inverted verification-only polarity. Positive leftover
  and ledger-anchor candidates preserve producer payloads and enforce count agreement.
- Editorial writers run serially. After amendments, one independent final barrier refreshes the
  pack, evidence, claims/count-claims lint, main drift and EF/cross-target checks. Prose-only
  changes reuse complete code evidence; source changes rerun verification. Later writers force
  another barrier and final scans, with a bounded mutation loop.
- Shared `lib/evidence-identity.mjs` uses version 3 and collects HEAD, full tracked/nonignored untracked contents and modes,
  acceptance and attempt contracts to determine
  identity—not timestamps or the truncated review pack. Unchanged pending results survive resume;
  changed content invalidates reviews/evidence while preserving implementation and human signoff.
  Initialized product gitlinks are recursively bound; unprovable nested repositories fail closed.
  Driver-owned `engineMount` binds trusted live engine revision/source bytes and effective briefs
  separately from the product tree. Default discovery includes ignored build/config/env inputs;
  `config.evidenceInputs` declares additional inputs through the shared collector.
  The runtime additionally binds build reuse to the frozen contract hash; ordinary `.md` and `.rst`
  are prose-only, but declared/discovered build-input documents affect `codeHash` too.
  Differential fixtures pin these choices; point-in-time hashes are not filesystem snapshots.
- Main drift is detected without repair; `failLaneOnMainDrift` controls failure. Cross-service
  changes require each solution’s build/suite (`config.solutions[serviceRoot]` overrides the
  conventional `<root>/<service>.sln`). EF dirty or unavailable execution fails before gates.
  Re-fix prior-finding coverage requires feedback, and RED coverage runs for every code item even
  when the optional reported runCmd is absent.
- Plan feasibility/quality review, prior findings, RED coverage and breadth probes are native
  stages. Realinfra overrides and declared plan deviations require independent adjudication.
- `policies.shadowConsolidatedScan` enables a blinded frozen-input comparison before amendments,
  including mixed/rejected originals and all three output axes. It adds one consolidated call
  alongside the three original probes. Unchanged original results are reused by normal scan
  phases; mutations or changed pack/feedback invalidate reuse. Unavailable shadow output is SKIPPED. Details and
  the native-compatible generic build-lease CLI are in `RUNTIME-CONTRACT.md`.
- Integration reuses complete unchanged FULL evidence when available; otherwise mechanics run
  build/suite once. The integrator receives the handoff-only contract and cannot certify absent
  or stale machine evidence.

## Official API surfaces checked (2026-09-19)

- V1: <https://opencode.ai/docs/server/>,
  <https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/sdk/js/src/gen/types.gen.ts>
- V2: <https://opencode.ai/v2/docs/api/> and its linked <https://opencode.ai/v2/openapi.json>.

Adapters are deliberately separate. V1 uses `/global/health`, `/session`,
`/session/{id}/prompt_async`, durable `/session/{id}/message`, and `/session/{id}/abort`.
V2 uses `/api/info`, `/api/session`, `/api/session/{id}/prompt`, paginated durable
`/api/session/{id}/message`, and `/api/session/{id}/interrupt`. V2 admission is not completion;
only a completed assistant stop response with settled tools, idle execution and an empty v2 inbox
can submit a verdict. Neither SSE nor idle alone is evidence of success. V1 `/session/status`
omits idle entries; a missing entry is accepted only alongside durable completed message/tool
evidence. Server versions are checked; unsupported major versions fail explicitly.
Use `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` for v1 basic auth, or configured
HTTP `headers` for the server’s documented authentication setup. Keep credentials host-local.

## Verification

`node _workflow/opencode/_selftest.mjs` runs schema, lifecycle, positive lint, mutation identity,
final-barrier and local HTTP-fake v1/v2 tests with no paid calls or git mutation.
`node _workflow/opencode/_runtime-tests.mjs` runs the focused behavioral suite.
`_phase-catalog-tests.mjs` exercises every result-consuming agent phase through the real CLI:
compose, registered schema, dispatch-ID submission, advancement and persisted per-role JSON.
`stage-parity.mjs` declares deterministic equivalents; the shadow is a dispatched stage and
`UNPORTED` is empty. Source-parity tests detect undeclared or stale stage entries.

The recorded local capability smoke passed against **OpenCode 1.18.31** on 2026-09-19
without a prompt, model request or tool execution, including empty-session lifecycle and
cleanup. See [`../LIVE-CHECK.md`](../LIVE-CHECK.md). Official portable **v2.0.10** also
passed effective worker routing, session lifecycle and durable queued-input cancellation
with `resume:false`; see [`COMPATIBILITY.md`](./COMPATIBILITY.md) for distribution proof,
repeatable tests and credential handoff. These no-model checks do not establish provider
execution, active-tool cancellation races, production usage or measured savings.
# Host worker command hints

Trusted host configuration may set `workerCommandHint` (string) and
`workerRoleCommandHints` (role-name → string). The runtime snapshots these with the
rest of its config and appends them after generic build-lease examples, with the
role-specific hint last. Use this for an installed host helper's exact command,
shell `workdir`, and transcript-persistence contract. The helper must still execute
the real verification producer under the shared build lease; hints never waive
evidence requirements or alter reviewer verdicts. Keep pre-fix RED commands confined
to test authors and give reviewers fresh suite commands plus historical RED paths.

Actual v2 FULL .NET lifecycle evidence and reproduction:
[`../LIVE-OPENCODE-CODE.md`](../LIVE-OPENCODE-CODE.md).
