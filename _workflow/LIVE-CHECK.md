# Local OpenCode capability verification

**Current evidence — 2026-09-19:** installed OpenCode **1.18.31** and official
portable **2.0.10** have since completed real Copilot-backed doc fixtures through
runtime, finalize and driver fold **CLOSED**, using normal existing authentication.
See [lifecycle evidence](LIVE-OPENCODE-LIFECYCLE.md) and
[v2 provenance](opencode/COMPATIBILITY.md). Those fixtures use synthetic bootstrap
identities and temporary driver ledgers; production scheduling/worktrees and code
lifecycle are not established. Latest startup-cancellation/stale-output race fixes
have offline coverage but no subsequent full paid lifecycle rerun.

`live-check.mjs` is a zero-dependency, unpaid endpoint verifier based on the earlier
temporary `factory-capability-live.mjs` smoke script. It uses the repository's real
`OpenCodeServer` adapter. Node built-ins only; no installation or npm dependencies.

```powershell
node _workflow/live-check.mjs --help
node _workflow/live-check.mjs --executable "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
node --test _workflow/live-check.test.mjs _workflow/observations.test.mjs
```

On a platform with a native `opencode` executable on PATH, the executable option
can be omitted. Windows `.cmd` wrappers are not supported: use the native `.exe`.
The optional temporary parent must exist. Only a newly generated
`factory-live-check-*` child is owned and removed by this invocation.

## What runs

1. Launch `--version` with an isolated environment and working directory. Require a
   v1 version before starting `serve --pure --hostname 127.0.0.1 --port 0`.
2. Require matching `/global/health` version and the adapter's required OpenAPI
   endpoints. Schema presence of `prompt_async` is checked without calling it.
3. Check effective home/config/workspace containment and isolated database under
   the configured data root. `/path` need not expose a `data` property, and its
   non-repository `worktree` sentinel is not the session's directory binding.
   Read effective config, provider and agent envelopes; require snapshots/sharing
   disabled, deny permissions, no enabled/connected providers, plugins or MCPs.
4. Create one empty session, reconcile its idempotent lookup and directory/title
   identity, verify empty messages and idle state, and require a pending outcome.
5. Abort that empty session and reconcile stopped state. Delete it, terminate the
   owned server (bounded wait, force-kill fallback), then remove the generated root.
   Startup/check failures and SIGINT/SIGTERM also enter cleanup. Cleanup failures
   make the result FAIL; no broad process kill or temporary-parent deletion occurs.

No prompt sending, paid model request or agent tool execution is supported, including
through flags. HTTP requests are restricted to the owned loopback origin and an
endpoint/method allowlist; redirects are rejected. Only basic OS/path environment
variables are inherited. Home, config, cache, data, state and temp paths are isolated;
provider credentials, proxy settings and inherited OpenCode/Node configuration are
not forwarded. External plugins, skills, project config, updates and model fetching
are disabled. This is process/config isolation, not an operating-system sandbox.

JSON goes to stdout, with exit 0 for PASS and 1 for failure or unsupported live mode.
It contains allowlisted checks, version and cleanup booleans; raw server output,
response bodies, configuration values, provider names and error details are never
printed. Failure names identify the stage to investigate. No report file, telemetry,
ledger or host configuration is written. Configured model presence is reported as
`configured-unverified`; omission remains `unknown`, not proof of absence.
`actualModel` stays null because no model is invoked.

## Evidence limits and versions

The installed environment's v1 version is **1.18.31**. The verifier checks the
installed version against server health rather than assuming that fixed version on
other hosts. Other v1 versions still have to pass the same capability checks.
**Official portable v2.0.10 passed both the separate no-model test and the later
authenticated doc lifecycle.**
This v1 verifier still rejects `--api-version v2` before launch. Use
`opencode/_compatibility-live.mjs` for v2; see [`opencode/COMPATIBILITY.md`](opencode/COMPATIBILITY.md)
for binary provenance, effective profile checks and durable queued-input cancellation.

## Earlier no-model environment validation — 2026-09-19

The revised verifier completed the full sequential no-model lifecycle against the
installed v1 server: **PASS, exit 0**. This supersedes the earlier path-check failure.
Exact command, run from the repository root after confirming the temp parent exists:

```powershell
node _workflow/live-check.mjs --executable "C:\nvm4w\nodejs\node_modules\opencode-ai\bin\opencode.exe" --temp-parent "C:\Users\AYEFYM~1\AppData\Local\Temp\opencode"
```

The live JSON reported 11 successful checks, all 10 required schema endpoint
definitions present, and 7 agent definitions. It checked health, path isolation,
the isolated database, effective config and provider isolation, then created an
empty session, found the same session on repeated create, verified session identity,
read empty messages and idle status, verified a pending outcome, aborted the session
and reconciled stopped state. Session deletion, owned-process termination and owned
temporary-root removal all succeeded. `prompt_async` was inspected in the schema
only; no prompt was sent.

Machine-readable summary of that actual run and the separate prerequisite probes:

```json
{
  "result": "PASS",
  "exitCode": 0,
  "apiVersion": "v1",
  "installedVersion": "1.18.31",
  "checksPassed": 11,
  "schemaEndpointsPresent": 10,
  "agentCount": 7,
  "providerCalls": 0,
  "promptsSent": 0,
  "toolExecutions": 0,
  "actualModel": null,
  "config": {
    "snapshotDisabled": true,
    "sharingDisabled": true,
    "configuredModel": null,
    "modelStatus": "unknown"
  },
  "cleanup": {
    "ownSessionDeleted": true,
    "ownServerStopped": true,
    "ownTempRemoved": true
  },
  "prerequisites": {
    "nodeVersion": "v24.18.0",
    "claudeVersion": "2.1.273 (Claude Code)",
    "dotnetSdkVersion": "10.0.303",
    "dockerClientVersion": "29.7.2",
    "dockerServerVersion": "29.7.2",
    "dockerDaemonReachable": true
  },
  "v2": {
    "status": "pending",
    "reason": "Historical v1-run snapshot; superseded by the separate v2.0.10 live result in opencode/COMPATIBILITY.md."
  }
}
```

Each prerequisite command exited 0; Docker's server-version response establishes
daemon reachability without starting a container:

| Exact command | Actual output |
|---|---|
| `node --version` | `v24.18.0` |
| `claude --version` | `2.1.273 (Claude Code)` |
| `dotnet --version` | `10.0.303` |
| `docker version --format '{{.Client.Version}}\|{{.Server.Version}}'` | `29.7.2\|29.7.2` |

These are installed-version and daemon-reachability probes, not Claude Workflow,
.NET build/test or container workload executions. No Claude prompt, paid request,
container creation or credential/config output was used. The verifier itself does
not require Claude, .NET or Docker to run its OpenCode endpoint checks.

## Interpretation

A passing run establishes local endpoint, session-identity and empty-session stop
behavior only. Model access, worker routing, durable prompt admission, tool execution,
paid cancellation races and production delivery remain untested by this command.
Zero prompt/provider/tool counts describe the verifier's actions, not provider billing
measurements. This check does not establish measured savings.

Tests use an owned local HTTP fixture plus the real adapter and mocked process handles.
They cover redaction, unknown model state, endpoint/version rejection, credential
isolation, session identity, interruption and success/failure cleanup. The live CLI
must be run separately to verify an actual installed runtime. An uncatchable process
kill or host crash cannot execute JavaScript cleanup; ordinary exits and handled
signals verify cleanup explicitly.
