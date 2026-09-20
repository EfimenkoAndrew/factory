# Live Claude Workflow validation

> **2026-09-20 latest: native production lifecycle and exact replay PASS.**
> Stable product fixture `E1QjaY` reached terminal **CLOSED** and actual driver-fold
> **CLOSED**, 9 applied / 0 rejected / 0 skipped / 0 overrides. Same-session replay
> cached **22/22** workers, with zero runtime task tokens/tool calls and unchanged
> journal/ledger/artifacts. Fresh run plus replay reported **$2.7208677** list price.
> The original harness report's false FAIL is retained: its parser required an
> optional zero-override suffix. Independent audit establishes closure without a
> second fold or lifecycle run. Details below. Historical failures remain retained.

## Historical status — 2026-09-19 (superseded by E1QjaY above)

- **CLI primitives and saved-session replay: proven live.** The separate injected
  code/doc fixture also passed; neither runs the complete production lifecycle.
- **Actual `factory.js`: no CLOSED result.** The earlier `kQtTof` continuation
  folded FAILED. The latest retained `rZOITE` run ended on subscription **429 /
  five_hour**, leaving its driver item CLAIMED with no terminal checkpoint.
  Existing Claude authentication worked; quota was the observed inference blocker.
- **Request fidelity: fixed and covered offline after that run.** Current code
  binds the complete metadata and paths to a request digest, rejects mismatches and
  missing attempt proof before reviews, and saves collector metadata/results. This
  changed contract has not completed a live production lifecycle or replay.
- **Next validation requires available quota and a fresh latest-source launcher.**
  Saved artifacts/session/run identify the pending historical attempt. Exact replay
  of its frozen old launcher cannot validate the new contract. A quota reset time
  in the old error is not proof that quota is available now.

## Primitive and injected-fixture harness

```powershell
node _workflow/live-claude.mjs --live --fixture
node --test _workflow/live-claude.test.mjs
```

The first command uses the installed `claude` executable and its **existing login**.
It makes real subscription/API model calls. No credentials file is read by the
harness. Auth status is reduced to login/provider/subscription fields. The default
Windows temporary parent is `C:\Users\AYEFYM~1\AppData\Local\Temp\opencode`;
`--temp-parent` and `--executable` override these locations. Parent must exist.

## What runs

1. Two parallel native Workflow `agent()` calls: schema-only and Read/Write relay.
2. A second CLI invocation resumes the saved session and exact Workflow run.
   Machine TaskOutput must report both agents cached, matching structured values,
   unchanged file mtime, and zero shared output-token delta. Controller prose alone
   cannot establish success.
3. With `--fixture`, two parallel code/doc fixers followed by independent parallel
   reviewers use the factory's actual `FIX_SCHEMA` and `GATE_SCHEMA`. A Node
   subprocess records assertion RED before edits and eight-case GREEN afterward.
   Each dissent permits at most one amend/re-review. Scope stops remain failures;
   reviewers cannot attest executed RED/GREEN from source inspection.

The fixture uses an **injected no-git adapter**, not the full `factory.js` lifecycle
or driver claim/fold E2E. It does not establish native admission persistence,
evidence identity, verification leases, or production delivered-change cost.
The bounded amend branch is present but was not reached in the passing live run.

Each CLI invocation has `$1.50`, 12-controller-turn and 180-second limits. Workflow
agents are capped by the script (two primitive agents, four fixture agents plus at
most four amend/review agents), with concurrency two and two structured-output
retries. Three invocations mean a nominal `$4.50` CLI cap; subscription list-price
cost metadata is **not an invoice**. Controller turn limits do not individually
limit subagent turns; the wall deadline applies to the CLI process tree on Windows.
POSIX timeout kills the CLI only; child termination is not independently proven.

The CLI receives `dontAsk`, explicit Workflow permission, scoped Read/Edit rules,
and only Workflow/TaskOutput/Read/Write/Skill tools. `Edit(path)` is the correct
permission rule for Write; `Write(path)` rules are not consulted by the CLI.
No bypass mode, host settings edit, shell tool, git command, worktree creation,
ledger write, or owner stop-marker deletion is used. Existing managed/host deny
rules still apply. The CLI itself persists its normal session data under `.claude`.

Evidence stays in a generated `factory-live-claude-*` directory: scripts, raw CLI
JSONL/stderr, per-invocation summaries, machine Workflow outputs, RED/GREEN results,
and report JSON. Paths and fixture prompts appear in these local artifacts. They
are not copied into the repository. No automatic paid retry loop exists.

## Actual installed-runtime evidence — 2026-09-19

Claude Code **2.1.273**, existing `claude.ai` team login. Actual controller model
was `claude-sonnet-5`; Workflow workers were `claude-haiku-4-5-20251001`.

### Final primitive/fixture combined command: PASS

`node _workflow/live-claude.mjs --live --fixture` exited **0**, with all seven
checks passing and no blockers or permission denials. Authoritative report:
`%LOCALAPPDATA%\Temp\opencode\factory-live-claude-hlaqBo\report.json`.

| Invocation | Session | Workflow run | CLI list-price USD |
|---|---|---|---:|
| Primitive | `1cc24495-98ba-40c7-80f3-8133d76f4911` | `wf_c32913f1-9ad` | 0.13464150 |
| Saved-session replay | same | same | 0.03860100 |
| Code/doc fixture | `96ee8dab-b083-452d-89dc-aed0515dd680` | `wf_8eba52ff-067` | 0.14608210 |

Total **$0.31932460** (reported list price, not billed subscription charge).
Primitive runtime output counter **771 → 1951**; replay **0 → 0**, both agents
cached. Fixture output counter **5,467**, assertion RED exit **1**, eight-case
GREEN exit **0**, both gates approved, no scope stops, no amendments needed.

One doc-review headline contains literal XML-like text inside its JSON string.
It remains valid against the factory schema, is retained verbatim, and is never
interpreted as markup or as the absent `acceptanceMet` field. Structured output
validates shape; it does not guarantee prose quality. The independently executed
code oracle and explicit verdict fields supply this fixture's checks.

Offline validation at that primitive/fixture pass: **5/5 harness tests**; shared selftest **1,847 passed,
0 failed**, plus **19 focused suites passed** (reported separately).

The earlier runs below retain both successes and failures; they are not substituted
for the final combined report. All CLI model calls in this validation session,
including authoring discovery and failed harness attempts, reported approximately
**$1.4861** total list-price cost.

### Primitive and saved-session replay: passed

Evidence directory: `%LOCALAPPDATA%\Temp\opencode\factory-live-claude-YsJY0N`

- Session: `03e8ed27-6985-474d-9f6d-9b3465faf640`
- Run: `wf_26983fc0-91c`
- CLI exits: initial **0**, resume **0**; no permission denials.
- Shared runtime output counter: **732 → 1889** initial; **224 → 224** replay.
- Both replay agent entries explicitly reported `cached:true`.
- Original workers reported 5,095 and 5,915 tokens, respectively; these are runtime
  progress totals, not decomposed billable token vectors.
- CLI list-price totals: **$0.12987350** initial, **$0.03969460** resume.
  Resume still pays for controller requests despite cached Workflow workers.
- `agent()` returned only the schema object (`keys: [['value'], ['value']]`).
  Actual model/timing/token metadata appeared in the outer `workflowProgress`,
  and cache/input/output/cost vectors in CLI `modelUsage`; no native return-object
  usage API was established.

The earlier successful run `wf_e780da1e-f17`, session
`c8bd2e27-6563-4e61-9e9a-728dcaac28ec`, also had its saved `journal.jsonl` inspected:
two starts and two structured results, with no added worker starts after resume.

### Code/doc fixture: passed

Evidence directory: `%LOCALAPPDATA%\Temp\opencode\factory-live-claude-7yHuvx`

- Session: `313fa24d-19ef-49c9-99c8-43e4e666b41e`
- Run: `wf_94b78e0d-13c`
- `fixture.report.json`: **PASS**; CLI exit **0**; no permission denials.
- Real assertion RED: exit **1**, `12 !== 10`.
- Real GREEN after agent edits: exit **0**, **8 clamp cases passed**.
- Both independent code/doc gates: **APPROVED**; both `scopeStop:false`;
  reviewers correctly returned `redGreenConfirmed:false`.
- Shared output counter at return: **4,928**; CLI list-price total **$0.14152405**.

### Negative evidence retained

- First short Windows path launch denied Read. Canonicalizing with
  `realpathSync.native` fixed the harness; scoped Write permission also changed
  to the documented `Edit(path)` spelling.
- An early fixture incorrectly treated successful edits with `scopeStop:true`
  and unsupported `redGreenConfirmed:true` as passing. Current checks reject it;
  that early artifact's PASS is superseded and must not be cited as lifecycle proof.
- The `YsJY0N` fixture failed honestly on a documentation review dissent about
  missing in-range behavior, despite eight passing code checks.
- `7yHuvx/report.json` is a **failed primitive attempt**, distinct from that
  directory's passing `fixture.report.json`: returned UUID matched, but exact
  relay bytes did not (terminal newline). The relay now explicitly requests LF
  preservation and still checks exact bytes rather than relaxing the oracle.

Current authoring reference was obtained by invoking the installed
`Skill(workflow-authoring)` in session `0ddde238-b2bb-45d9-b011-6e37e9094516`.
References: [workflows](https://code.claude.com/docs/en/workflows) and
[file permissions](https://code.claude.com/docs/en/permissions).
The print prompt explicitly requests the Workflow tool; it does not rely on an
`ultracode` keyword opt-in.

These primitive/fixture findings were harness-local; the production follow-up is
recorded separately below.

## Production factory.js follow-up: FAILED, not full lifecycle validation

```powershell
node _workflow/live-claude-factory.mjs --live
node --test _workflow/live-claude-factory.test.mjs
```

This follow-up runs the **actual production source**, copied with helpers/briefs
into a temporary engine mount. Only the documented batch injection and CRLF→LF
normalization change the launcher text. The production driver itself creates its
temporary ledger with `init`, issues a real `claim`, and folds actual worker results.
The target is the existing checkout's unchanged `CLAUDE.md`; source Edit/Write
is denied, isolation/worktree creation is explicitly disabled through the existing
policy, and only temporary item artifacts are writable. No git metadata is created
or copied. No ledger is hand-authored.

### Earlier interrupted production execution — 2026-09-19

Directory: `%LOCALAPPDATA%\Temp\opencode\factory-live-production-kQtTof`

- Claude session: `08584841-d6d1-41e5-9644-9dd25ecc3463`
- Workflow: `wf_a910e14a-0bc`
- Factory run: `afc02998-9d2b-4864-9969-2cd5960a75fc`
- Driver claim: `b9f7ec03-689e-49ca-8c39-fdf9243eb863`
- Frozen factory source SHA-256:
  `ed958a8e026df4b1476548a97fe91d8fbb746f15e7792b3edc718be618adeba7`

The saved Workflow journal proves real completion of durable admission,
test-author verificationOnly proof, fresh verification preparation, independent
runner, identity relay, both editorial reviews, and developer/QA/adversarial/test
reviews. All four blocking reviews returned APPROVED. The 600-second process-tree
deadline interrupted the post-gates checkpoint. No re-audit or integration was
observed in that execution; APPROVED gates are not a CLOSED result.

The inspected saved-session continuation replayed the first two calls, then
diverged at post-test persistence: shared output-token accounting in the checkpoint
payload changed its prompt, invalidating the remaining cached prefix. A new
identity relay did not run the supplied `native-evidence.mjs` command. Its actual
tool transcript shows it ran the pin assertion, read CLAUDE.md/git HEAD, and returned
a 40-character revision as `hash` plus an empty `codeHash`. Production rejected
this as **`initial machine verification incomplete: identity unavailable`** and
persisted terminal `result.json`. Earlier relay results also embellished machine
verification/reason fields rather than returning the helper JSON verbatim. These
observations do not establish trustworthy successful identity relaying.

The complete TaskOutput JSON could not be parsed by the harness on continuation
(large/truncated output); controller prose was not promoted to a result. Instead,
the actual production driver's `reconstruct` read the terminal checkpoint, then
`fold` applied it with **5 transitions, 0 rejected**, final ledger **FAILED**.
Both commands exited **0**. See `production.recovery.json` and
`engine/state/results-cycle-1.json`. No successful closure is claimed.

### Other concrete findings

- Installed Workflow rejects CRLF-containing scriptPath content as hidden control
  characters. The source contained only CR and LF controls; LF normalization
  allowed launch. This is a launcher portability finding, not obfuscated source.
- Scoped `tee` commands and absolute artifact `Edit` rules were necessary in
  addition to helper permissions. A separate real permission probe passed before
  the advanced run. Variable-based redirections and command variants can still
  be denied; no bypass mode or host permission changes were used.
- `main-check` successfully checked the target snapshot, then threw on the external
  mount's `../../AppData/.../engine` path in `unclaimedMainDrift`. Its exact exception
  remains in `engine/state/items/LIVE-CLAUDE-DOC/main-check-raw.txt`.
- The existing checkout's unrelated changes appear in full-repo packs/lints and
  identity hashing. The engine copy is frozen, but the **product checkout is not a
  filesystem snapshot**. Other agents' source changes can invalidate evidence;
  this harness cannot claim a stable whole-tree snapshot from a stable target file.
- One earlier worker attempted to rewrite source CLAUDE.md; the explicit deny
  blocked both Write and Edit. Target bytes remained unchanged. Permission denial
  evidence is retained in `factory-live-production-Tw7lsa/production.summary.json`.

Each production CLI process was limited to **$5**, 20 controller turns and
600 seconds; retries/continuations were manual after artifact inspection. The
interrupted process has **unknown final aggregate usage/cost** because it emitted
no final CLI result. The completed continuation reported **$0.69582290** list price,
and the terminal checkpoint reports **10,909 item-estimated output tokens**; neither
is the all-in cost of the interrupted/replayed campaign. Recovery deliberately
did not invent `--usage-tokens` from an incomplete estimate.

All validation-owned CLI processes exited or were deadline-terminated. Temporary
artifacts and Claude's saved session/journal are intentionally retained for audit.
The owner checkout and stop markers were preserved. This historical run predates
the replay/relay and launcher/main-check fixes described below; its failed evidence
is retained unchanged.

## Latest retained live rerun — 2026-09-19: subscription-blocked

On the next requested run the harness copied the updated production engine,
retained the complete lifecycle, raised the single-CLI cap to **$6 / 20 minutes**,
and allowed both single- and double-quoted native helper command paths. The external
pin assertion now writes its own actual stdout to a contained item `.txt` transcript,
avoiding shell-pipeline permission ambiguities without broadening shell permissions.
The checkout is still read-only, and no git metadata is created or changed.

Latest artifacts:
`%LOCALAPPDATA%\Temp\opencode\factory-live-production-rZOITE`

- Session: `7b524dbc-d2cc-4b44-8e36-bcd845bc2fab`
- Workflow: `wf_4d996912-ba6`
- Real production driver `init` and `claim`: exit **0**.
- Journal: admission, test-author (verificationOnly pin PASS), post-test checkpoint,
  verification preparation, independent runner, post-verify checkpoint, two
  SHA-256-shaped identity returns, and both editorial APPROVED results completed.
- Post-preband persistence and all four blocking gate calls failed when the
  subscription rejected inference. Re-audit/integrator were not reached, no terminal
  result checkpoint was written, and the driver claim remains **CLAIMED**.
- Actual API error: **429**, `rateLimitType:five_hour`, `resetsAt:1789861800`,
  displayed reset **01:50 Europe/Warsaw**, `overageDisabledReason:org_level_disabled`,
  `unifiedRateLimitFallbackAvailable:false`. This is an entitlement limit, not the
  harness dollar cap or a permission failure. No retry after this error was made.
- CLI exit **1**, `is_error:true`; wall time **504,209 ms**, deadline not reached.
  CLI's last result `duration_ms:651` is only the final error turn and must not be
  mistaken for whole-run duration. Reported list-price cost **$1.11150250**.
- `modelUsage` reports controller/auxiliary Haiku output 5,025, Workflow Haiku output
  45,073, Sonnet output 10,924; input/cache vectors remain in `production.summary.json`.
  These are reported usage, not subscription charges.

Both identity relay returns contained valid v3 SHA-256 fields and actual collector
error strings, but referred to absent legacy `verify-raw.txt` rather than the supplied
attempt transcript. This doc-only path does not require code build/suite green;
the independent pin PASS is present. It still does **not** prove metadata-write
fidelity; inspect the saved `evidence-input.json`/relay transcript before claiming
the relay contract fully validated. No CLOSED or full replay result is available.

Earlier attempts in this follow-up (`x0dFQc`) retained controller refusals about
mistakenly assuming the separate Edit deny was absent, followed by a real failed
test-author whose piped command was denied; driver fold correctly retained FAILED.
The direct-output pin producer resolved that pipeline failure in `rZOITE`.

### Current request-fidelity fix and pending reproduction

The metadata omission above is now addressed in current source, with offline
coverage in `lib/native-efficiency_test.mjs`:

- `native-evidence-request.mjs` computes a canonical SHA-256 request digest over
  the worktree, full metadata and artifact directory. Metadata includes the
  item/run/claim/attempt/boundary identity, review/verification contracts and exact
  attempt transcript paths.
- The relay must write the complete supplied JSON and execute the collector with
  `--expected-request <digest>`. The collector validates required metadata and
  digest, returns the bound request, and writes
  `native-evidence-<digest>.json` containing metadata and result. Legacy CLI behavior
  requires explicit `--legacy`; current factory requests cannot fall back to an old
  `verify-raw.txt` when attempt metadata is missing.
- The runtime checks the returned binding and requires verification success before
  editorial/gate work, including doc-only items. For docs, collector success means
  a nonempty attempt transcript exists; actual acceptance remains the runner and
  reviewers' responsibility. Hash-shaped output alone is insufficient.
- Offline real-collector/CLI and mocked Workflow cases cover omitted fields,
  wrong claims/attempt paths, malformed JSON, forged bindings and missing proof.
  They do not establish live agent metadata fidelity or native CLOSED.

After quota becomes available, reproduce the **current contract** in a fresh
temporary fixture using the current source:

```powershell
node _workflow/live-claude-factory.mjs --live
```

The retained `rZOITE` attempt remains pending historical evidence. Its saved-run
continuation command is available for investigating that **old frozen contract**:

```powershell
node _workflow/live-claude-factory.mjs --live --existing "C:\Users\ayefymenko\AppData\Local\Temp\opencode\factory-live-production-rZOITE" --resume-workflow
```

Do not edit that launcher and call it exact replay, or count its continuation as
validation of the current request-binding fix. No full native rerun after this fix
has been recorded.

No validation-owned Claude or Node process remained after this run. Evidence and
the driver's isolated claim are intentionally retained. The permission-guarded
owner checkout, existing Git state and owner stop markers were preserved.

## Post-reset production validation — 2026-09-20

Two actual full Workflow attempts were used, within the requested two-attempt
limit; each CLI retained the $6 / 1,200-second bound. Two additional controller-only
invocations stopped before Workflow launch. No new 429 occurred. All CLI children
exited normally; a final process inspection found no validation-owned Claude/Node
process. Existing unrelated interactive Claude processes were preserved.

### First full attempt: metadata relay failed

`factory-live-production-AxT3E4`, session
`a357d54f-7ea5-4c33-b5a1-3ea8f09da703`, Workflow `wf_a3526106-bc1`,
task `wbcf3u54i`, factory run `fc4eef63-3c98-45ab-8c48-f5a059ad5e76`,
claim `a6fc7810-2ffe-43e9-9f53-f1452a238331`.

The relay failed to reproduce the full metadata containing every role brief.
Its first schema-valid green return had no collector receipt and embellished the
verification reason; the subsequent identity returned a digest-mismatch failure.
Workers and actual fold ended FAILED. Eleven workers ran. CLI reported
$2.04667730, 945,789 ms wall time, seven permission denials, exit 0.

The production fix transports large brief maps as a directory plus complete-content
SHA-256. The Node CLI rehydrates all briefs, verifies that digest, then validates the
**original full-metadata request digest** and persists the complete receipt.
No brief or evidence requirement was dropped. Incorrect directories/digests fail.

### Second full attempt: workers CLOSED, independent fold FAILED

Retained root: `%LOCALAPPDATA%\Temp\opencode\factory-live-production-7Vxrsa`.

| Identity | Value |
|---|---|
| Claude session | `519dbb81-9dc7-4f8e-956f-8ae9a3bd35ef` |
| Workflow run / task | `wf_6ec87223-148` / `wzxxkkd27` |
| Factory run | `beb16269-9ab5-4127-82d8-3f8adc7b8f8d` |
| Driver claim | `68866e08-a519-45a5-89cc-857aa0a0416a` |
| Frozen factory SHA-256 | `f1acb23be2d6c5597b761305c56a9b5175db4fadd5a63c0af854b00a7b8962d2` |
| Launcher SHA-256 | `7f16fca02368c9c88a93e3b47e1a32949c2259d764da0da6c726cf62653c597f` |
| Terminal checkpoint SHA-256 | `a485912e08fa4240bd22f3a023649ef4cd40cf0b23cbc46f63591dad100137a4` |
| Folded ledger SHA-256 | `7c1b4ba6b185573c73cd13dd0d5934dfe503e0361af2c55fbaafe870637806fc` |

All 22 workers completed: admission, test-author verificationOnly pin, preparation,
runner, four identities, editorial structure/prose, developer/QA/adversarial/test
reviews, re-auditor, integrator, checkpoints. Six reviews APPROVED; re-audit converged;
integrator reported global green. The LIGHT documentation route skips code-only
stages and standalone refuter. A failed post-verify progress write remained visible
in the runtime log; later checkpoints and terminal `result.json` were written.

The actual driver executed init/claim/fold, all exit 0. Fold reported **1 applied,
0 rejected, 0 skipped, 1 deterministic override**, ending FAILED:
`native evidence: native expected policies mismatch`.

Root cause: the fixture injected raw config policies (including explanatory `note`
and `isolateWorktreeWrites`) while fold used `loadPolicies`; its injected profile
also lacked a corresponding on-disk host profile. Current preparation now uses
the production policy loader and writes its temporary profile through the normal
profile location. `loadPolicies` now retains an explicitly boolean
`isolateWorktreeWrites`, preserving the existing native opt-out contract. Fixture
producer/consumer regression checks pin exact policies/profile equality. These
latest fixes have **not** had another full paid run because both attempts were used.
The frozen failed ledger, metadata, launcher and verdict were not rewritten.

### Bound collector receipts and source preservation

Four actual `native-evidence-<digest>.json` receipts contain all **23 full briefs**,
correct attempt paths and matching canonical request digests:

| Boundary | Request digest |
|---|---|
| post-verify | `00b9b6ff81077b4cbb9bdc36db753dd25246089f69f9df702dd65aa17b06ad78` |
| post-mutation | `15eac0f12cbaffffdb99169ac559a718224dd5ecd2010229da21523707945765` |
| post-review | `385d92c4b27216740bbf935226f950184cd7d98f681c7677b9b24cb0c7bbc3db` |
| post-integrate | `0ddc47355ae4bbc6dbeaefb217eaf64ddd8e362287b487dbf93f4c93ceb5f8c8` |

All report identity `82519e24ee4b22c8a13825626b1b77cd035d632cc8164f408a0a3fed357d6cb5`,
code identity `10f6edf3449124bfe582ea8223d9418d23e571d17447a597cc2d59be0bb35396`.
The transcript is `verify-initial-<factory-run>-<claim>.txt`; SHA-256
`ccfba9cde26913928ae3f03ff08520c09fd28dfd36c0d284fe24d4b30def1c5a`.
This is a doc-only pin PASS, not code build/suite evidence; integrationTranscript
is null by that contract. Digest-valid receipts do not override the policy failure.

Before/after source snapshots retain full porcelain status, every tracked and
nonignored untracked file hash, and explicit owner ledger/STOP marker presence/hash.
Both snapshots hash to
`309273ff18868ee2a5f7e23adaefb5e3f2c7c5dfbbeaafe7530b55e38f638e67`.
No git mutation was executed. Permission denials were honored.

Independent retained audit:
`production-audit-1ae57573-6852-4539-9526-220bdfc82f05.json`.

### Exact completed replay: cache PASS, failed ledger preserved

Same session and Workflow run, replay task `w21y4o7aq`; the launcher was unchanged.
Runtime machine output confirms **22/22 cached, done**, no new worker starts,
**0 runtime task tokens / 0 tool calls**, 227 ms task-progress duration. Original
journal bytes, source snapshot, item artifact hashes/mtimes, launcher, original
report and FAILED ledger all remained unchanged. No second fold was run.

TaskOutput was truncated. The harness now reads the full JSON only from a matching
completed runtime task-notification `output_file`; controller prose is not evidence.
Offline audit recovered the actual completed replay without another model call.
The initial parse-failure report remains immutable beside its new audit:
`production-replay-7c7378d1-b66b-4b76-8ae4-e6a15f4e4736.audit-c3348038-7806-4a60-88c1-92e375cdb8b9.json`.

The factory shared output counter reported **137,463 original / 477 replay**,
with `attributionConfidence:run-total-only`. The replay's 477 is **not fresh worker
output**: all workers were cached and the outer task counter was zero. CLI controller
output was 1,059 tokens. The source exposes no before/after shared counter pair,
so zero shared-counter delta is not claimed.

Original task progress: **559,790 total tokens, 164 tool uses, 1,064,888 ms**.
Original CLI: **$2.38717160**, 1,099,648 ms wall time, four denials. Replay CLI:
**$0.15390600**, 16,879 ms wall time, zero denials. Additional controller-only
attempts: `q16RKT` **$0.20977280** and the initial `7Vxrsa` turn **$0.09422440**.
Campaign reported list-price total: **$4.89175210**, not a subscription invoice;
per-worker billed dollars and actual subscription charge remain unknown.

Regression command: `node _workflow/lib/_selftest.mjs --no-git-mutations`.
The successful post-relay-fix run passed **1,854 assertions plus 22 focused suites**;
the final policy/harness checks are recorded in the parent handoff. Root registry
and summary-document updates belong to the parent task.

### Authorized fresh attempt after policy/profile correction: controller refused

Root: `%LOCALAPPDATA%\Temp\opencode\factory-live-production-GpWlYC`.
Session: `62c7bbce-0c8b-422e-88db-5d4dacdd47b6`.

Before inference, the strengthened harness recorded every copied factory/driver/
helper/brief/schema/verify source hash against the intended repository snapshot,
plus the declared temporary configuration/profile differences. Preflight imported
the **snapshot's actual policy and profile loaders** and confirmed exact supplied
contract equality. The launcher matched the official source-plus-batch transform.
Successful reports now require the exact actual Workflow scriptPath, unchanged
source manifests/launcher, CLOSED checkpoint/ledger and zero fold overrides.

| Preflight evidence | SHA-256 |
|---|---|
| Source manifest file | `d0713e9c8ae133ad963b2d2d301f4ed9ca057a185048bcbb0a9e4b909dce5543` |
| Frozen engine manifest canonical digest | `510f54f412353a0405878e7e7efa8377c1d2a97c63e0045145eed6a388ee01a9` |
| Launcher | `e8c70c9d105d2b7d97387edab6399fe83d8d9c5e61e5e8d5ea991a1b8327fe8d` |
| Batch canonical digest | `2574f4684769d3aca325b3153de7bd7b1fa82f79834acd91bfeb41ed3f55ad44` |
| Expected contract canonical digest | `a9079ba5a7b52c3f1515c3d2e7b688fcb7c328ce0f9a456479efc9ec898b8774` |

Explicit fixture route overrides remain Sonnet 5 / low for testMech, fixerMech,
runner, integrator and reauditor; these are not stock-route performance claims.

The real production driver initialized and claimed successfully. The Claude
controller made **no Workflow call**, questioning the dense authorization prompt.
One same-session clarification accurately restated the human authorization; it
listed the temporary directory, then categorically refused the specific launcher,
mistaking normal harness reports for fabricated prior-run evidence. Both complete
controller responses are retained in `production.summary.json` and
`production-resumed.summary.json`; the first report is in `production.prior-report.json`.
No tool-permission denial or quota error was observed. No permission fallback,
different-model retry or synthetic worker verdict was used.

There is **no Workflow run/task ID, terminal checkpoint, collector receipt, fold
or replay** for this fresh attempt. The isolated ledger remains CLAIMED. Source
before/after snapshots matched. Both owned CLI processes exited; final inspection
found only pre-existing unrelated Claude processes. Reported list-price costs were
**$0.10715400 + $0.02909380 = $0.13624780**; actual subscription charge unknown.
The technical policy/profile correction therefore remains unvalidated by a fresh
full native run, despite its passing preflight and regression checks.

### Neutral auditable request: launched, relay tool-use failure retained

The harness task wording now describes the requested synthetic read-only doc check,
names script/batch/config for inspection, and requests actual results without a
predetermined passing outcome. The fixture profile's contradictory `tee` instruction
was removed; it identifies the existing owner checkout and confines scratch output
to item artifacts. Permissions were unchanged.

Root: `%LOCALAPPDATA%\Temp\opencode\factory-live-production-WMg8CT`.

| Identity | Value |
|---|---|
| Session | `f99e6ff1-6e5d-4f7b-b8e9-f6a051c63595` |
| Workflow / task | `wf_a476d868-e62` / `wgv144jtl` |
| Factory run | `ca87113b-1be7-4618-8192-68d0aa39a226` |
| Claim | `6ea88c9b-95ef-4131-aa2a-726ca4478f37` |
| Frozen engine manifest canonical SHA-256 | `18011c26a2755b281dd733aec76a5f8d07e3f92f85240fcfa479bec79acd37be` |
| Launcher SHA-256 | `d09dbb5775e2f0c7cf620577394102cdb48693cf39d2c6f22b0ecc2c88290472` |
| Terminal FAILED checkpoint SHA-256 | `8311fc25f928ea96e151dd1c355df0e73b3277e4fffd5234b88adba6cee7be39` |
| FAILED ledger SHA-256 | `e3d28ce19eee73c7f05124da97eeabe894f073798cecc0146384084f4fb2d1fe` |

Preflight passed policy/profile/brief equality using actual snapshot loaders, full
source manifests and exact launcher transform. The controller inspected the files
and launched the exact requested scriptPath. Post-execution frozen checks passed;
source before/after hashes both equal
`623812a7f29106d2d4a9014cc40269d1ccb2942e72198e0b71890fe86a35c388`.

Eleven real workers completed. Test-author and runner observed pin PASS; both
editorial reviews APPROVED. Initial identity helper succeeded with a bound receipt:
`native-evidence-1d0652ead1521c9127a43d0646c538fd6056ceffa93fcea606a0b15b65f8088e.json`.
Its canonical digest validates, all 23 briefs are present, and it binds
`verify-initial-<factory-run>-<claim>.txt`, transcript SHA-256
`55d63104825a04142528c4526060c88e18046c1aa672092042a571e1a882bed0`.
Receipt file SHA-256:
`fa92ba8d990bccbf1dab007cd01e3a4f6fa9aeebc298d1a484274dbc8aaf79ad`.

The subsequent identity worker (`a3d31eb260c33371c`) tried Write on the already
existing `evidence-input.json` without reading it. The actual tool error was
**“File has not been read yet. Read it first before writing to it.”** The worker
then attempted a shell `cat > ... << EOFMETADATA` replacement, which was denied
under dontAsk. It stopped and returned failed verification with zero placeholder
hashes. It never invoked the evidence helper at that boundary. Its claim that Bash
was needed for all writing is not the observed root cause: the initial prerequisite
was a Read of the specific existing artifact. A similar post-test checkpoint write
failed earlier; the terminal checkpoint was successfully persisted.

The pipeline correctly stopped before blocking gates, re-audit and integration.
The actual driver folded FAILED: **1 applied, 0 rejected, 0 skipped, 1 deterministic
override** (`native evidence request missing or malformed`). Controller prose
misdescribed the failure as normal verificationOnly behavior; the terminal machine
result and fold remain authoritative. No CLOSED replay was attempted, and the
denied heredoc was not enabled or retried through another execution route.

CLI: exit 0, **$1.27788605** reported list price, **530,197 ms** wall time, four
permission denials. Runtime task progress: **255,907 tokens, 89 tool uses,
495,435 ms**. Factory output counter: **57,188**, run-total-only attribution.
No quota error. Full proof is retained in
`production-audit-afdc3191-336e-4812-9d36-634eb2601642.json`, original reports,
the bound receipt, and the saved worker transcript. Subscription charge and
per-worker billed costs remain unknown.

### Scoped read-only Git and Read-before-Write follow-up: deadline stop

The harness now allows only named read-only `git -C <absolute-worktree>` status/diff
variants (including single/double-quoted paths and `-- CLAUDE.md`), retaining source
Edit deny and all git-mutation denies. The profile instructs absolute `git -C`, no
`cd`. Actual current production source included KI-E207 Read-before-Write and
request-specific metadata paths, doc-only Docker-baseline gating, and the complete
collector-return schema. Native contract tests passed before the full launch.

The optional micro probe (`JclUd5`, session
`65e62729-1cd4-48d4-92b0-5e6fb6354687`) was refused by its controller after reading the
script, before any Workflow/worker launch; reported cost **$0.06021180**. Its whole
source comparison was false while the frozen engine remained unchanged: concurrent
native-source preparation occurred in that window. It is not successful micro or
source-preservation evidence. No micro retry was made.

Fresh full root: `%LOCALAPPDATA%\Temp\opencode\factory-live-production-wsU3Ea`.

| Identity | Value |
|---|---|
| Session | `d30c921a-385a-4930-96f7-d30bb600eabf` |
| Workflow / task | `wf_afb5958b-07e` / `wt6hn0c3f` |
| Factory run | `0d23a206-0d28-49f0-ad26-7607c1769b8b` |
| Claim | `86746230-34f8-4a86-8a82-b816896460fb` |
| Factory SHA-256 | `3a6aac19f9feceb1c5caeca47c69247f47eb45596f72fd4643a75ae2f379ac37` |
| Launcher SHA-256 | `e894a389a7f770a5c8c959dc7697c2cdb7b0301e4787bb022a185d443e29752f` |
| CLAIMED ledger SHA-256 | `25c7fbfb0642d69fced23b029e2e5655c7e079a439b232f93b530d4eb035a3c2` |

The exact intended launcher was used with Windows backslashes. The initial harness
report incorrectly foregrounded a slash-spelling mismatch after the timeout; current
comparison accepts separator equivalence only, still rejecting another path/args.
The original report is immutable. Independent audit confirms the frozen engine is
unchanged and launcher bytes match the official source/batch transform. Whole source
before/after snapshot hashes both equal
`49e90c058af0c7d4b737a35281cd7847fa4eb7363477eeee70bb4c5926dcc1fb`.

The journal contains **25 starts / 24 results**. Read-before-Write progress updates
succeeded; scoped git status/diff executed. All six editorial/blocking reviews
APPROVED; re-audit converged; integrator reported global green. The process tree was
terminated at **1,200,448 ms**, while the post-integrate identity worker was still
active. No terminal `result.json`, driver fold or completed replay exists. Ledger
remains CLAIMED; stage approvals and an integration receipt do not establish CLOSED.

**Additional evidenced relay defect:** the first identity worker read its missing
request-specific input, then ran the helper without ever Writing the supplied JSON.
The helper failed on missing input. The worker subsequently returned unsupported
SHA-256-shaped hashes (`hash` copied from request digest, patterned codeHash), `HEAD`
as baseRevision, and an invented file count. There is no receipt for that request
(`007b30a4900319e1deb17dbdc6b65692750bfbb7e28673de2bdffa4e1dcff7eb`).
Schema/binding checks alone did not reject it inside Workflow. Later genuine
collector output differed, triggering extra final verification despite unchanged
product source. Independent fold receipt validation remains required; it was not
reached. This is not permission proof or a trustworthy initial verification result.
The worker also attempted denied rev-parse/alternative shell commands; those denials
remain enforced, not broadened in response.

Five later receipts have valid full request digests and all 23 briefs, including
post-integrate digest
`1db01ddf65bb173d0b39d1b121eeb1db49f16092f7d680bbd9785d65450438a5`,
receipt file SHA-256
`8624078e05b6b08132de7865ad283023e0cb72797d5320c724211b99f44b9244`.
They bind identity `ebefa47a967015f28100de344bfca0f788a05d565c13e90246eb85b89c6524eb`,
code identity `4a3c59eb7c59191caffe8adda6a6861c309d26c52395b45ae437cdccfb30b96b`;
final transcript hash `ccfba9cde26913928ae3f03ff08520c09fd28dfd36c0d284fe24d4b30def1c5a`.
Full per-boundary hashes and retained counts:
`production-audit-b45db7e1-c115-411d-9e68-b2b913ee02e1.json`.

Last runtime progress: **637,707 tokens / 226 tool uses / 1,173,003 ms**. Final CLI
cost/usage and shared output counter are **unknown** because no final CLI result was
emitted. Summary `permissionDenials:[]` is likewise incomplete; worker transcripts
contain actual denials. No full-run dollar total or zero-denial claim is made.
Final process inspection found no owned Claude/Node processes. No further paid
invocation or hand-authored terminal checkpoint was used after the deadline.

## Stable archived product: native CLOSED and exact cached replay — 2026-09-20

### Deterministic continuation decision

Before any inference, `wsU3Ea/continuation-preflight.json` recorded its original
launcher SHA-256, official transform, unchanged frozen engine, and unchanged journal:
**25 starts / 24 results**. All five genuine collector receipts were recomputed using
that run's own collector implementation and complete saved metadata. Every full
identity and code identity differed from the current checkout. Changes since the
run were `_workflow/LIVE-CLAUDE.md`, `_workflow/live-claude-factory.mjs` and its test.
The initial unsupported relay identity also remains preserved. A paid continuation
could not retain valid cached evidence; none was launched. The CLAIMED ledger and
unfinished original run remain intact, with original cost still unknown.

### One fresh authorized fixture

Root: `%LOCALAPPDATA%\Temp\opencode\factory-live-production-E1QjaY`.

The product is deliberately **committed HEAD**, extracted through `git archive`
without creating/copying Git metadata or mutating Git. Existing `GIT_DIR`, scoped
`GIT_WORK_TREE` and `GIT_OPTIONAL_LOCKS=0` provide read-only metadata. Preparation
required empty `git diff HEAD`; stale original-index stat-cache entries remain
visible and are explained to reviewers. All product source is read-only to every
worker; only isolated item artifacts are writable. The latest engine was copied
independently and frozen with a full source/config/profile manifest. No factory or
production helper changes were needed in this follow-up.

This is a real filesystem identity over **141 product files**, not an injected static
identity. Actual driver init/claim/fold, production request-specific agent-written
metadata, four native collectors, independent reviews and integration executed.
Policy/profile/brief contracts were compared using the copied engine's loaders.
Owner source, original index, product source and frozen engine remained unchanged
through the run; product/engine/ledger/artifact preservation was checked again through
replay. Documentation updates began only after replay completed.

| Identity | Value |
|---|---|
| Session | `edb96fd5-e4a2-4940-8520-7f67ff9c24f9` |
| Workflow | `wf_6dd92646-964` |
| Factory run | `c57d74da-4393-4e7e-a9e5-42d750b2f817` |
| Claim | `31613b32-4a2d-462a-859d-3cbb84c6d73c` |
| Product HEAD | `65fe8db5c70b1da49247be496027ac1ac62f1da7` |
| Engine manifest digest | `42d79c38851063aa3ffe7ecca1fe36888ea5268120de2a2a48c41be959c24338` |
| Launcher SHA-256 | `222e81b09552448dff29108efbe6623ada1b15273fbcc47a0bf6d518acf9a647` |
| CLOSED checkpoint SHA-256 | `37caac9b2d6c7703e8ee74dc852b0786b7b8a786cc39003443b6a500df4e93a1` |
| CLOSED ledger SHA-256 | `2431816587bdc91f8f17fb46019690a95698d4192af2695541c4e773d91d90a6` |
| Unchanged journal SHA-256 | `df64a977c57ea1466fa4e141a0e64cad464416dc09d3486ff99dc66a8a9a6ceb` |

All **22 workers** completed. Four genuine receipts (post-verify, post-mutation,
post-review, post-integrate) each contain all **23 briefs**, valid full request
digests and exact journal-return equality. Recollection still matches full identity
`dfd716e597c781a33843fefe7f7001dec854e753d62853ac518a308625f06469`
and code identity
`71ea9ff310cb9fb3c03c5e69f4f6d7e7de36efb0e98ed7a97756e864b1a398c2`.
The actual documentation pin transcript hashes to
`ccfba9cde26913928ae3f03ff08520c09fd28dfd36c0d284fe24d4b30def1c5a`.
This verifies the documentation-only LIGHT route, not a code build/suite workload
or production scheduler/worktree admission. Existing Sonnet-5/low fixture overrides
remain explicit; mechanical collectors retain the production Haiku route.

Actual fold: **9 applied, 0 rejected, 0 skipped, 0 overrides**, ledger **CLOSED**.
The driver omits the override suffix when zero. The harness wrongly required it,
so original `production.report.json` and `stable-campaign.json` say FAIL despite the
successful fold. They remain unmodified. The corrected parser rejects malformed or
duplicate summaries, with regression coverage. **`stable-closure-audit.json`** is
the independent offline closure audit; it revalidates current receipts, checkpoint,
ledger, launcher and manifests. No second fold or paid lifecycle was run.

### Exact completed replay and accounting

`production-replay-d840bed0-a242-4cc8-b6c0-d602b5b60380.report.json`: **PASS**.
Same session, Workflow run and exact launcher. **22/22 cached/done**, journal still
22 starts/22 results and byte-identical. Machine task progress: **0 total tokens,
0 tool calls, 173 ms**. Original report, ledger and every item artifact hash/mtime
remained unchanged. No new worker execution or fold occurred.

| Invocation | Wall time | Reported list-price USD |
|---|---:|---:|
| Fresh lifecycle | 1,151,906 ms (~19.2 minutes) | 2.5696483 |
| Exact completed replay | 13,668 ms | 0.1512194 |
| **This follow-up total** | | **2.7208677** |

Fresh task progress reported 595,902 tokens / 190 tool uses / 1,129,703 ms.
Factory shared counters were 134,806 original and 161 replay, both run-total-only;
the replay counter is not fresh worker output. Controller requests still incur
reported cost during cache replay. Subscription charges and per-worker billing
remain unknown. Fresh CLI reported three permission denials; worker tool errors
remain in transcripts and are not erased or treated as zero. Replay reported none.
No permission fallback, metadata precreation by the harness or gate weakening was
used. Original failed/interrupted runs remain retained, including their unknown costs.

Harness regression and required nonmutating selftest passed: **1,854 assertions,
22 focused suites**. See KI-E209 (stable product) and KI-E210 (fold-summary parser).
No validation-owned process remained after the fresh execution or replay; unrelated
interactive Claude processes were preserved. No credentials were read/copied, owner
stop markers deleted, or Git mutations executed.
