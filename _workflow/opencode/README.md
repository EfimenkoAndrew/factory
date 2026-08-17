# `_workflow/opencode/` — OpenCode runtime binding (KI-O1)

An alternate runtime binding for a controlling session that has **no native Claude Code
`Workflow` tool** (e.g. an OpenCode session, VS Code Copilot Chat in agent mode, or the GitHub
Copilot coding agent). `factory.js` cannot run outside Claude Code's sandboxed Workflow runtime
— it needs that runtime's `agent()` primitive to invoke subagents. This directory re-implements
the deterministic half of `factory.js`'s `runItem()` as a real Node CLI, and lets the controlling
session supply the `agent()` calls itself (via whatever subagent-launch tool it has — e.g.
OpenCode's `Task`, or its own terminal/edit tools playing each role directly — see "Using this
binding from GitHub Copilot" below).

Read `KNOWN-ISSUES.md`'s **KI-O1** entry first — it lists the documented fidelity gaps
(no per-call model tiering, no sweep-mode, one item at a time; the decision-framer, PO gate,
escalate check, and edge-scan verdict splice all mirror `factory.js` exactly). This is not a
lighter-weight reimplementation of the factory; it is the SAME contract (schemas, fold rules,
artifact shapes) driven by a different controller.

Two behaviours worth knowing up front:

- **Host policies**: the mechanical no-new-comments gate inside `mech <id> leftover` runs ONLY
  when the host enables `policies.noNewComments` (`config/factory.config[.local].json`, read via
  `lib/policy.mjs` — the same single source `factory.js`'s comment probe and the driver fold's
  WARN backstop key off; shipped-engine default OFF). When enabled, `compose` also injects the
  same two `HOST POLICY — ... (binding):` prompt blocks factory.js injects. A scan that cannot
  run (git failure) records NO gate verdict — loud warning, never a silent APPROVED.
- **Terminal checkpoint**: EVERY terminal outcome — `FAILED`/`BLOCKED`/`ESCALATED` as much as
  `CLOSED` — must persist `state/items/<id>/result.json`. `next` keeps returning the
  `{"mechanical":"checkpoint"}` step until `mech <id> checkpoint` has written it (then reports
  `done`); skipping it leaves the ledger row CLAIMED forever because there is nothing to fold.

## Files

| File | What |
|---|---|
| `schemas.mjs` | The structured-output schemas every phase's subagent call must satisfy (verbatim copies of factory.js's `*_SCHEMA` consts) + a minimal zero-dependency validator for the JSON-Schema subset they use. |
| `routing.mjs` | Verbatim port of `routesFor`/`flowsFor`/`bandFor`/`reauditLenses`/`gateRolesFor`. Pure functions, no model calls — see the model-tiering caveat in the file header. |
| `compose.mjs` | Verbatim port of `compose(role, item, extra)` — builds the exact prompt text a subagent receives, inlining the real `agents/<role>.md` brief (this module has real disk access, unlike the sandboxed factory.js). |
| `buildtest.mjs` | Spawns the **same unmodified** `verify/build-test.sh` via Git Bash (works around the broken default-WSL-bash on some Windows hosts — see `OPENCODE_FACTORY_BASH` to override) and **imports** (does not re-derive) `lib/verify.mjs`'s transcript parsers, so fold-time evidence parsing can never drift from what `driver.mjs fold` actually applies. |
| `runtime.mjs` | The per-item state machine CLI: `init` / `next` / `submit` / `mech` / `status` / `finalize`. See usage below. |
| `_selftest.mjs` + `selftest-fixture.json` + `selftest-fixture-fullband.json` | Pure-module assertions, in-process lifecycle pins (runtime.mjs guards its CLI entry point, so its helpers import cleanly), a mechanical schema-parity check against `factory.js`'s `*_SCHEMA` consts, and full CLI state-machine runs against synthetic fixture items (incl. a doc-only run all the way to CLOSED) — zero real agent calls, zero real product code touched, zero git mutations. Run: `node _workflow/opencode/_selftest.mjs`. |

## Usage protocol

```
node _workflow/opencode/runtime.mjs init <itemId>          # loads the item + ledger worktree, writes state/items/<id>/opencode-progress.json
node _workflow/opencode/runtime.mjs next <itemId>           # prints the current phase's plan:
                                                              #   { "mechanical": "<step>", ... }   -> run it yourself, no LLM (see `mech` below)
                                                              #   { "agents": [{role,key,phase,schema,prompt}, ...] }
                                                              #       -> dispatch ALL of them via your subagent tool
                                                              #          (single message / parallel when >1 — mirrors Promise.all)
node _workflow/opencode/runtime.mjs submit <itemId> --role <key> --json <file|->
                                                              # ingest one subagent's structured JSON answer (the LAST fenced
                                                              # ```json block that parses, or bare JSON); validates against the
                                                              # phase's schema; once ALL keys for the current phase are in,
                                                              # applies the phase's side effects (writes the artifact, advances
                                                              # state) and CLEARS the pending set — a re-submit of a completed
                                                              # phase's role is rejected loudly with no state change. Re-running
                                                              # `next` never resets already-submitted verdicts (idempotent).
node _workflow/opencode/runtime.mjs mech <itemId> <verify|leftover|integrate|checkpoint> -- <args>
                                                              # deterministic steps — build-test.sh + marker/transcript
                                                              # parsing, no LLM involved. Doc-only items (codeChange=false)
                                                              # take a NO-BUILD verify/integrate path with honest evidence;
                                                              # `leftover` runs the host-policy-gated comment gate first
node _workflow/opencode/runtime.mjs status <itemId>          # current phase / gates / pending keys, for resuming
node _workflow/opencode/runtime.mjs finalize <itemId>        # wraps state/items/<id>/result.json into the
                                                              # {mode,cycle,results:[...]} envelope `driver.mjs fold`
                                                              # actually requires — a BARE per-item file folds as
                                                              # "ZERO results" (KI-O1), so always finalize before fold
```

`mech <id> checkpoint` writes `state/items/<id>/result.json` in the exact shape `driver.mjs
fold` expects internally, but `fold` itself needs an ARRAY (or `{results:[...]}`) — `finalize`
does that wrapping for you:

```
node _workflow/opencode/runtime.mjs finalize <id>
node _workflow/driver.mjs fold state/results-cycle-<N>-<id>.json --controller <token>
```

## Using this binding from GitHub Copilot

This same CLI contract works unchanged from a GitHub Copilot controller — VS Code Copilot Chat
in agent mode, or the GitHub Copilot coding agent (both have a terminal/run tool). Point the
session at `.github/copilot-instructions.md` (which links here) and it can drive the exact
"Usage protocol" sequence above: `init` → loop `next` / do the work / `submit` → `mech ...
checkpoint` → `finalize`.

One fidelity gap is new for this controller class, and is NOT a bug to fix here — it's an
accepted limitation, same posture as KI-O1's other documented gaps (KI-O4):

- **No independent subagent dispatch.** OpenCode's `Task` tool spawns a genuinely separate
  subagent session per role. Copilot has no equivalent documented "spawn an independent
  subagent" primitive — a Copilot controller session must play every role `next` hands it
  (`architect`, `developer`, `qa`, `security`, `po`, the review-flow roles, etc.) itself,
  sequentially, in the same conversation. This weakens `PLAN.md`'s "the review stage is
  separate adversarial subagents — never nested in the doing agent" invariant: the reviewer is
  no longer independent of the implementer's own reasoning trail. Treat any GATED/REFUTE_OK
  verdict produced this way as weaker evidence than the native Claude Code or OpenCode paths
  produce, and weigh that when deciding whether an item needs a human second look before
  `INTEGRATED`.

## `--fixture` (self-test only)

`init` accepts `--fixture <file>` to bypass `findings-graph.json`/`ledger.json` entirely
(see `selftest-fixture.json` for the shape) — used ONLY by `_selftest.mjs` so the state
machine can be exercised without touching a real item's on-disk artifacts. Never use it for
a real item; `mech` steps dispatched against a fixture's fake worktree will fail loudly
(there's no real git checkout / .NET solution behind it).
