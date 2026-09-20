# `opencode-assets/` — host-installable OpenCode controller assets (KI-O5)

Installed into a host repo by `setup/init.mjs` (skip with `--no-opencode-assets`). Two halves,
because they have two different ownership stories:

| Path | Host target | How it installs |
|---|---|---|
| `root/AGENTS.md` | `<host>/AGENTS.md` | active marker block; surrounding host guidance retained |
| `root/.opencode/ai-factory.md` | `<host>/.opencode/ai-factory.md` | copied (`copyTree`) |
| `root/.opencode/skill/ai-factory/SKILL.md` | `<host>/.opencode/skill/ai-factory/SKILL.md` | copied (`copyTree`) |
| `opencode.config.json` | the host's own `opencode.json` | **deep-merged** (`lib/hostinstall.mjs`) |
| `worker-profiles.json` | version-selected `agent` / `agents` config | named model/role profiles, existing host model overrides retained |

Controller file hashes are recorded in the mount's `state/controller-assets.json`, keyed
by host-relative path and bound to the host root. An untouched old release upgrades;
actual local edits receive a `*.factory-new` proposal. With no prior hash, differing files
are conservatively preserved. Identical files establish a known baseline. This applies
to Claude/Copilot manuals as well as OpenCode. Writes and manifest updates are atomic.

`AGENTS.md` has an independently hashed `ai-factory:begin/end` block. Setup appends it to
an existing host file, preserving the surrounding text, and upgrades only an untouched
block. Edited/unknown marker blocks get a sidecar. The active block includes the hard
rules and explicitly directs the agent to read `.opencode/ai-factory.md`.

## Version selection

Setup probes `opencode --version`; `--opencode-bin <executable>` probes a portable binary
without changing PATH or installing globally. `--opencode-version 1|2` selects the dialect
when no binary is available; it must agree with a detected supported binary. Full CLI output
must match a recognized stable version, including v2's `opencode v2.0.10` format.
An unknown/future/preview binary is refused before config merge.

| Version | Config and discovery |
|---|---|
| v1 | `permission.bash`, `agent`, `prompt`, `instructions`; singular skill directory |
| v2 | ordered `permissions: [{action, resource, effect}]`, `shell`/`subagent` actions, `agents`, `system`; plural `.opencode/skills/` |

V2 **does not load `instructions` entries or fall back to `CLAUDE.md`**; the active root
AGENTS block is essential. The version-specific shapes were checked against
https://opencode.ai/config.json and https://opencode.ai/v2/docs/{config,permissions,agents,instructions}/.
On 2026-09-19 the published schema still described the v1 keys while the v2 docs described
the plural keys; do not validate a v2 fragment using that v1 schema snapshot alone.

Existing provider/model/MCP settings are retained. Cross-version permission/agent keys,
multiple local config files, malformed JSON and comment-bearing JSONC are left for manual
merge, with a version-selected sidecar where possible. Setup never silently migrates host
provider/plugin/MCP configuration. Permission merges preserve exact and broad host denies;
v1 bare-string/global scalar denies and legacy disabled-tool configs require manual migration.
Read/edit/tool-level and wildcard denies are propagated into installed profiles; flat-only
v1 permission keys remain flat actions. Higher-level and agent config layers
remain host-owned; inspect effective configuration after installation.

The recorded local capability smoke passed against **OpenCode 1.18.31** on
2026-09-19 without sending a prompt or invoking a model. It checked isolated
configuration, empty-session lifecycle and cleanup, not installed worker routing
or paid execution. The official portable **v2.0.10** also passed generated-profile loading,
effective routing and durable no-model lifecycle against the current adapter. See
`_workflow/opencode/COMPATIBILITY.md` for official distribution evidence, exact executable
path, startup/authentication and test scope. `opencode-ai@latest` still selects v1;
the official v2 npm distribution is `@opencode/cli`.

**Quit and restart OpenCode (including its server)** after setup. Check installed models
and provider aliases before dispatch. Profiles are named
`factory-{writer|reviewer|probe}-{mechanical|standard|strong|planning|cheap}`; host model
overrides on those names survive setup. Reviewers/probes deny edits but retain shell and
network probes under host permissions; their JSON is persisted by the controller. Writers
can implement and write artifacts. All worker profiles deny mutating git and nested agents.

## Integrated dispatcher

After claiming a batch, initialize each item with
`runtime.mjs init ID --launch <run-args.json>`, then run
`node <mount>/_workflow/opencode/dispatch.mjs --url <server> --ids ID,OTHER`.
Optional flags are `--version v1|v2` and `--config <file>`; the default factory-local config is
`config/opencode-dispatch.local.json`. This is separate from OpenCode's own configuration.
The dispatcher finalizes terminal envelopes; the controller folds them with its driver lease.

The route kind is `writer` for fixer/test-author/editorial roles, `probe` for other roles
ending `-probe`, and `reviewer` otherwise (including planner/runner/integrator). The tier
matches the intended model against `worker-profiles.json`:

| Tier | Intended model |
|---|---|
| mechanical | `claude-sonnet-4-6` |
| standard | `claude-sonnet-5` |
| strong | `claude-opus-4-8` |
| planning | `claude-fable-5` |
| cheap | `claude-haiku-4-5` |

The adapter queries the chosen agent's **effective worktree-local** model. Host overrides
survive installation. Factory dispatch config `roles[role]` takes precedence over
`models[intended-model]`; override fields are `agent`, `providerID`, `modelID`, plus v2
`variant`/`variants[effort]`. Missing effective profiles/models fail closed. V1 does not
send effort/variant on the prompt request; v2 selects a session model variant. Neither path
silently falls back to a generic worker. The v2 agent config's expanded model uses
`{providerID, model, variant}`; the server's effective model response uses `{providerID, id,
variant}`. These are different surfaces, not interchangeable JSON shapes.

The runtime's read-only prompt supersedes old brief requests to write reports or temporarily
mutate source. The worker returns schema-validated JSON; runtime submission persists canonical
artifacts. Edit-deny still allows useful shell/network probes, subject to host restrictions;
it is not an OS sandbox preventing shell writes. Build/red/filter/suite/EF probes use the
shared `build-lease.mjs` wrapper. `agentConcurrency` and `buildConcurrency` are independent
dispatcher knobs. Native Workflow prompts use the same enforced wrapper and shared
slots; arbitrary shell commands bypassing it are not intercepted. The `opencode`
orchestrator backend maps its `modelConcurrency` and
`buildCapacity` to these knobs. See `orchestrator/ORCHESTRATOR.md` for launch/recovery behavior.

**`opencode.config.json` is a fragment, not a file to copy.** An OpenCode config is the host's
own — it carries their model, provider and MCP settings — so the factory merges into it rather
than owning it. `mergeOpencodeConfig` (`_workflow/lib/hostinstall.mjs`, selftest-pinned) appends
the factory's v1 `instructions` entry and merges ordered permission restrictions. Factory
restrictions outrank host allows, while existing host denies cannot be weakened to ask.

## Why the permission rules are shaped the way they are

`opencode.json` is repo-wide, not factory-session-scoped, so a blanket `deny` on mutating git
would also block ordinary OpenCode-assisted development in the host repo — which the factory's
own rules explicitly permit ("implementing something yourself, outside the factory, is fine").
So:

- bare mutating git verbs (`commit`/`add`/`checkout`/`restore`/`stash`/`reset`/`clean`/`push`,
  with and without `-C`) are **`ask`** — normal work costs one keystroke, and every attempt to
  commit on the factory's behalf becomes a visible human decision, which is exactly the
  "the human authors every commit" invariant;
- the same verbs targeting a **factory worktree** (`git -C *worktrees* ...`) are a hard
  **`deny`** — there is no legitimate case for those, and the `*worktrees*` fragment matches both
  `/` and `\` path separators in one pattern;
- deleting `state/STOP_REQUESTED.md` (`rm`/`del`/`Remove-Item`) is a hard **`deny`** — the drain
  marker is owner-controlled and must never be lifted from inference;
- editing `state/ledger.json` is a hard **`deny`** — it is machine-owned with a single writer.

`git worktree add` is deliberately NOT denied: the factory creates worktrees through
`lib/worktree.mjs`, which invokes it without `-C`, and the patterns above are anchored on
`git -C ` or the bare verb so they cannot catch it.
