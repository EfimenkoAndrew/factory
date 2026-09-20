# OpenCode compatibility evidence

Checked **2026-09-19** on Windows x64. **OpenCode v2 is publicly released and
accessible: 2.0.10**, through the new official distribution. The installed
`opencode` on PATH remains **1.18.31**. Checking only the old npm package or
GitHub's latest Release gives an incomplete answer.

## Current validation status — 2026-09-19

Both **1.18.31 and 2.0.10** completed nine real `github-copilot/gpt-5-mini`
workers through the applicable documentation runtime, checkpoint, `finalize`
and actual driver fold **CLOSED**. Normal existing Copilot authentication worked.
Reports are retained under `%LOCALAPPDATA%\Temp\opencode\`:

| Version | Evidence root | Result |
| --- | --- | --- |
| 1.18.31 | `factory-live-lifecycle-BnCxUK` | CLOSED; ledger replay unchanged |
| 2.0.10 | `factory-live-lifecycle-YTf47w` | CLOSED; 10 applied / 0 rejected; ledger replay unchanged |

These use `runtime init --fixture`, static fixture identity and driver-owned
temporary ledgers, including fold's READY-to-CLAIMED bootstrap. They do not prove
production scheduler admission, production claim identity, git worktree creation,
code/.NET lifecycle or human delivery. Both versions also passed real running-tool
cancellation and fresh retry; v2 passed a bounded unavailable-route timeout followed
by an explicit valid fallback. See [full evidence](../LIVE-OPENCODE-LIFECYCLE.md).

The latest cancellation-startup and stale-output race fixes (KI-O14) were tested
offline after those runs; no full paid lifecycle has been rerun with them. Earlier
v1 header-only abort/delete acknowledgements do not prove detached handlers could
not start later. The v1 lifecycle replay overwrote its original cleanup array and
first-fold output before report preservation was fixed: its current report has an
empty session cleanup array, while the original terminal record is described in
the lifecycle document. No replacement deletion receipts are inferred.

## Publication proof

| Official source | Observed result |
| --- | --- |
| [`anomalyco/opencode` latest GitHub Release](https://api.github.com/repos/anomalyco/opencode/releases/latest) | `v1.18.31`, not a prerelease, published `2026-09-14T17:47:30Z` |
| [`opencode-ai` npm metadata](https://registry.npmjs.org/opencode-ai) (`npm view opencode-ai dist-tags --json`) | `latest: 1.18.31`; `beta: 0.0.0-beta-202608110357`; `dev: 0.0.0-dev-202609191432` |
| [v2 installation page](https://opencode.ai/v2/docs/) | Names the new `@opencode/cli` package and official Windows portable binaries; page's pinned download links still say `2.0.6` |
| [Official CLI updater](https://opencode.ai/update/api/latest/cli/npm) | `channel: latest`, `version: 2.0.10`, package `@opencode/cli`, `active: true`, build ref `refs/heads/v2` |
| [`@opencode/cli` npm metadata](https://registry.npmjs.org/@opencode/cli) (`npm view @opencode/cli dist-tags --json`) | `latest: 2.0.10`; `beta: 0.0.0-beta-19507`; `dev: 0.0.0-dev-19872` |
| [Official v2 installer](https://opencode.ai/v2/install) | Resolves native packages from `@opencode/cli-<platform>` using the updater and npm registry |
| [Git tag v2.0.10](https://api.github.com/repos/anomalyco/opencode/git/ref/tags/v2.0.10) | Public tag at commit `b8cedc1a7a5e2916bbb65dc1d4b620729c261638` |
| [GitHub Release by v2.0.10 tag](https://api.github.com/repos/anomalyco/opencode/releases/tags/v2.0.10) | HTTP 404: a source tag exists without a corresponding GitHub Release |

Thus v2 is more than an inaccessible preview or a documentation claim. Do not
mark it unavailable based on `opencode-ai@latest` or `/releases/latest`.

## Binary provenance and execution

Downloaded the official native-only package with `npm pack --ignore-scripts`
into the preapproved temporary directory, without installing dependencies:

- Package: [`@opencode/cli-windows-x64@2.0.10`](https://registry.npmjs.org/@opencode/cli-windows-x64/2.0.10).
- [Exact archive](https://registry.npmjs.org/@opencode/cli-windows-x64/-/cli-windows-x64-2.0.10.tgz).
- Published and independently recomputed integrity:
  `sha512-oUPT8mpyhIXZYQtx1yHPebEqzCUNzy8lvNqZJoQoJu6l7nz2N/XZSpiOP5HjYjY+CY6uUeIDYcY7cGN7HF+LEg==`.
- Verified an npm ECDSA registry signature over
  `@opencode/cli-windows-x64@2.0.10:<integrity>` using the currently valid
  [registry public key](https://registry.npmjs.org/-/npm/v1/keys), key ID
  `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`.
- Extracted executable printed **`opencode v2.0.10`**.

The isolated server uses an allowlisted process environment, fresh HOME/XDG
directories, fresh temporary storage, a random local server password and port,
disabled project discovery/model catalog fetches, `snapshots:false`, and
`update:"disable"`. No user credentials are imported. `serve --stdio` exits
when the harness closes its input. Generated artifacts are retained in the
test's printed temporary root for inspection.

## Earlier no-model adapter lifecycle — 2026-09-19

Run:

```text
node _workflow/opencode/_compatibility-live.mjs <verified-opencode.exe> <temporary-parent>
```

Passed against **2.0.10**, using the current `server-api.mjs` and generated
`opencodeFragment(..., 2)` configuration:

1. Parallel version discovery selected v2; `/api/info` reported `2.0.10`.
2. All 15 generated worker profiles became available with the expected
   `id`, `model.id`, and `model.providerID` values.
3. Effective writer routing selected `factory-writer-standard` and
   `anthropic/claude-sonnet-5`.
4. Session creation, idempotent lookup, worktree identity and route verification.
5. Empty message pagination and idle-state lookup.
6. Durable prompt admission with **`resume:false`**, inbox enumeration,
   admission recognition and pending outcome.
7. Cancel queued input, interrupt, reconcile empty inbox/messages and idle state.
8. Delete the isolated session and stop the owned server.

The test's fetch wrapper adds `resume:false` to the adapter's normal prompt
body before sending it. This is an explicit **no-model** lifecycle test, not
evidence of provider execution, final assistant output, usage accounting or
paid-model authentication. No provider call was attempted.

Recorded successful post-integration run:
`C:\Users\AYEFYM~1\AppData\Local\Temp\opencode\factory-v2-compat-QCQQOR`.
`result.json`, `wire.json`, `effective-config.json`, and `server-stderr.txt`
retain the evidence locally; no credentials are included in wire records.

## Real compatibility findings and safe selection

**Readiness race:** an immediate `/api/info` check succeeds while `/api/agent`
can still return `{data:[]}`. Waiting for the requested worker profile IDs
resolved this in the actual binary. A missing profile after a bounded wait
must fail before admitting work.

**CLI output differs:** v1 prints `1.18.31`; v2 prints `opencode v2.0.10`.
Match complete recognized version output; do not search arbitrary output for
a loose digit prefix. Preview `0.0.0-*` and future majors require explicit
compatibility validation.

**Published schema mismatch:** at this check,
`https://opencode.ai/config.json` still described singular v1 `agent` and
`permission`, whereas the real v2 binary successfully loaded plural `agents`
and `permissions` with `system`, `snapshots`, and `update`. The v2 config docs
describe these plural forms. The actual `/api/config` and `/api/agent`
responses are the stronger evidence for effective runtime configuration.

New `compatibility.mjs` implements the independently tested selection helpers:

- `parseOpenCodeVersion`: recognizes the observed v1/v2 CLI formats and
  returns API version and config major.
- `detectOpenCodeApi`: probes independent identities in parallel, validates
  healthy v1 / stable v2 identity, handles missing/non-JSON endpoints, refuses
  authentication failures and ambiguous dual identities, and supports an
  explicit version. Redirects are refused and each request is time-bounded.
- `waitForOpenCodeAgents`: waits for every requested effective profile, has a
  bounded deadline, and propagates API errors.

Production integration now uses `prepareDispatchConfig` in the dispatcher for
automatic and explicit identity validation, and `agentReady` before routing any
new dispatch. The installer shares the strict parser via `opencodeMajor` and
`selectOpencodeMajor`; `--opencode-bin <executable>` selects a portable binary.
Explicit installer major selections cannot override a detected mismatch or
unsupported binary. Existing hashes, deny rules and config preservation remain
covered by the installer tests. Restart OpenCode's client/server after setup.

## Executable and credential behavior

Verified executable (no global install or PATH replacement):

```text
C:\Users\AYEFYM~1\AppData\Local\Temp\opencode\package\bin\opencode.exe
```

Spawn this executable directly with argv:
`["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]`.
Set a fresh process-local `OPENCODE_PASSWORD`. Read the JSON `{url}` line from
stdout, retain stdin, and close stdin to stop this owned server. Requests use
`Authorization: Basic base64("opencode:" + password)`. V2's username is fixed
to `opencode`; `OPENCODE_SERVER_PASSWORD` is a legacy password alias.
The dispatcher supports both password variables and preserves explicit
authorization headers. Server Basic auth is distinct from provider credentials.

Official tagged source confirms provider credential reuse, without reading or
copying any secrets in this task:

- [Legacy credential migration](https://github.com/anomalyco/opencode/blob/v2.0.10/packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts)
  reads `<global.data>/auth.json` and imports API/OAuth/wellknown entries into
  the database when that migration runs. Existing integration credentials are
  skipped. OAuth refresh/access/expiry are migrated; GitHub Copilot uses the
  `device` method. This source does not modify the legacy auth file.
- [Global roots](https://github.com/anomalyco/opencode/blob/v2.0.10/packages/util/src/global-roots.ts)
  use `XDG_DATA_HOME/opencode`, otherwise `~/.local/share/opencode`.
- [Database path](https://github.com/anomalyco/opencode/blob/v2.0.10/packages/cli/src/database-path.ts)
  defaults to `opencode.db` for latest; `OPENCODE_DB` accepts an absolute path.

The later credential-enabled lifecycle harnesses retained normal user auth/data
context and successfully used Copilot on both versions without the harness reading
or copying credentials. Config/cache/state/project settings were isolated; normal
runtime databases and auth-refresh records could still be updated by OpenCode.
This is not full filesystem isolation. A completely isolated XDG data root, as
used in the earlier no-model test, has no legacy credentials to import. An optional
fresh absolute `OPENCODE_DB` can isolate v2 database writes, but is not claimed as
the configuration used by every later live harness. Existing Claude CLI login also
worked in the separate [native checks](../LIVE-CLAUDE.md); its latest blocker was
subscription quota, not absent authentication.

The [official v2 API reference](https://opencode.ai/v2/docs/api/) itself labels
the HTTP surface experimental. Factory evidence supports the specific **2.0.10**
no-model and authenticated fixture slices above, not every v2 release, provider or
production route.

## Earlier compatibility checks — 2026-09-19

- `node --test _workflow/opencode/compatibility.test.mjs`: **9 passed**.
- Real isolated v2 lifecycle: **passed**.
- `node _workflow/lib/_selftest.mjs`: **1847 assertions passed**, **19 focused
  suites passed**, no failures.
- `node _workflow/opencode/_selftest.mjs`: **190 legacy/pure checks passed**;
  runtime/API, dispatch, settlement, phase, admission, shadow and lease suites passed.

These counts belong to the earlier compatibility pass. Later lifecycle evidence
and offline hardening are recorded separately above and in the lifecycle document.
