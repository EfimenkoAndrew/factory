# Real OpenCode worker validation

Follow-up: [`LIVE-OPENCODE-LIFECYCLE.md`](LIVE-OPENCODE-LIFECYCLE.md) records the
subsequent real runtime/finalize/driver-fold doc fixture and v1/v2 running-tool
cancellation plus fresh retry. The six-call slice below remains its own evidence.

`live-opencode-workers.mjs` is the opt-in, billable companion to the unchanged
no-model `live-check.mjs`. Node built-ins only. It calls the actual `OpenCodeServer`
and `dispatchAgent` with registered factory response schemas.

```powershell
node _workflow/live-opencode-workers.mjs --discover --executable "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
node _workflow/live-opencode-workers.mjs --model github-copilot/gpt-5-mini --executable "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
node --test _workflow/live-opencode-workers.test.mjs
```

Discovery sends no prompts. It filters `/provider` and `/agent` to connected
model IDs and agent names. The model argument must match an advertised connected
model. Automatic selection prefers Copilot GPT-4.1, GPT-5-mini, then GPT-6-astra;
other providers require an explicit model argument. Advertised availability is
not proof that inference succeeds.

## Isolation and bounds

The harness owns a newly generated `factory-live-workers-*` TEMP child and two
sequential loopback servers (discovery, then configured workers). Configuration,
cache, state and working directory are temporary. The normal user home/data auth
context is retained for OpenCode's built-in authentication; credentials are never
read or copied by the harness. Consequently OpenCode's normal shared database and
auth-refresh mechanisms remain active. Session deletion removes owned sessions;
this does not promise erasure of runtime logs, database WAL or provider records.

Global/project configuration, external plugins/skills, snapshots, sharing, MCP,
LSP and formatters are excluded/disabled. Configuration is supplied through the
supported `OPENCODE_CONFIG_CONTENT` mechanism and validated by runtime startup.
The configured server is newly started, so no controller restart or host config
edit is needed. Inherited credential/config environment variables are excluded.
Providers that need private global configuration are not covered by this default.

Two normal worker calls, maximum six dispatch admissions per invocation, six model
steps per worker, 90-second dispatch deadline (programmatic maximum 180 seconds).
Automatic paid retries are absent. A completed dispatch is replayed against its
durable session without resending. Actual provider HTTP request counts can differ
from worker-call counts; model turns and hidden runtime operations are not billed
request counters. Model usage/cost comes from assistant records, null if unknown.

Only synthetic sum/check files are sent. Permissions deny external directories,
delegation, web and arbitrary shell; the allowed shell command is exactly
`node check.mjs`. The writer may edit fixture `.mjs` files; the reviewer cannot
edit. These are runtime permissions, not an OS sandbox. Actual allowed read,
edit and shell execution is checked. Denied-tool adversarial execution is not
claimed. No factory checkout, claim, ledger or fold is part of this harness.

Normal success/failure cleanup aborts and reconciles owned sessions, deletes them,
stops owned server PIDs and removes the generated root only after cleanup succeeds.
Uncertain cleanup retains the root. No broad process kill or session deletion is
used. SIGKILL, host failure and externally terminated Node processes cannot run
cleanup; the printed PID/session/root evidence identifies owned resources.

## Actual validation — 2026-09-19

Installed **OpenCode 1.18.31**, owned endpoint **http://127.0.0.1:4096**.
Normal auth discovered GitHub Copilot, including GPT-5-mini and GPT-6-astra.
The final run passed all eight checks with **github-copilot/gpt-5-mini**:

| Worker | Session | Tools | Result |
|---|---|---|---|
| writer | `ses_f44f3c9c8ffe0xwqh1se1EgqbR` | read, apply_patch, bash; all completed | subtraction changed to addition; FIX_SCHEMA valid |
| independent reviewer | `ses_f44f3a16effeaF2EI61kYwGptv` | read, bash; all completed | APPROVED; GATE_SCHEMA valid |

Both shell commands were exactly `node check.mjs`. Both sessions had one matching
durable user message, completed assistant output and idle/settled execution.
Replaying each dispatch returned the identical validated output without another
message or admission. The reviewer was a fresh parentless session, not a fork.
The reviewer's `redGreenConfirmed` field is model-reported; this harness does not
claim a factory RED/GREEN lifecycle from that field.

| Worker | Input | Output | Cache read/write | Runtime-reported cost |
|---|---:|---:|---:|---:|
| writer | 3037 | 276 | 7296 / 0 | 0.00187765 |
| reviewer | 2384 | 247 | 4096 / 0 | 0.0022164 |

Combined reported cost: **0.00409405** (runtime accounting, not a verified invoice).
Final-run server PIDs **40408**, **36224** stopped; both sessions aborted/reconciled
and deleted; `factory-live-workers-SAKc6G` removed.

### Failures discovered and cleanup

Six physical dispatch attempts total across development runs; only the last two
completed model work. Earlier failed requests have unknown usage/cost, not zero.

1. Three early admissions (two GPT-5-mini, one GPT-6-astra) exposed a real adapter
   race: the durable user header appeared before text parts, while status was idle.
   `outcome()` incorrectly raised `durable prompt content mismatch` and cancelled.
   It now returns pending for a header with no text parts, retaining timeout and
   cancellation fences. Genuine nonempty mismatches still fail. Sessions
   `ses_f44f623e7ffexgJKJX5iW494T9`, `ses_f44f5c0e6ffeKzYzg17klyM8si`,
   `ses_f44f557b5ffeGf8NsccCm3oOyU` were stopped/deleted and roots removed.
   Their server PID pairs were **13704/16356**, **13752/12808** and
   **34448/43656**; all stopped. Removed root suffixes: **qxTPyr**, **LkzEJp**,
   **iPMb8U**.
2. One experimental `format:json_schema` request matched the advertised format
   envelope but caused OpenCode message reads to return HTTP 400,
   `Expected OutputFormatJsonSchema`. Its cause within the installed runtime was
   not isolated. That experiment was removed: the working adapter retains schema
   in the prompt plus strict local `validateNamed`, not server-format enforcement.
   Session `ses_f44f4ebb2ffe0METp92RypCdXM` was fenced and TEMP retained initially.
   A no-prompt owned restart verified session identity, acknowledged abort and idle,
   then deleted that exact session. Recovery server PID **41076** stopped and
   `factory-live-workers-lRZmYe` was removed. No orphan from this run remains.
   Its initial server PIDs **21704/7456** had already stopped. Discovery-only
   PIDs **13060**, **25400**, **41268** also stopped, and their generated roots
   **zr9XwB**, **HDQBNu**, **KkkELw** were removed.

Paid active-tool cancellation, paid retry after provider failure, v2 inference,
full runtime `--fixture` states, driver claim/fold and production cost/quality are
not established. The successful final slice and durable completed replay are the
scope of this evidence. The six-call initial budget was exhausted; no wider run
was attempted.

## Regression results

- Worker/no-model test command: **20 passed**, zero failures/skips.
- `node _workflow/lib/_selftest.mjs --no-git-mutations`: **1847 assertions passed**,
  **18 focused suites passed**, all seven nonmutating git fixture groups completed.
- `node _workflow/opencode/_selftest.mjs`: **190 legacy/pure passed**, plus runtime
  behavioral, dispatch, settlement, phase catalog, admission, shadow and lease suites.
- `git diff --check`: exit 0.
