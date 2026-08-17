# AI Implementation Factory — always-on rules

This repo has the AI Implementation Factory mounted: an in-project agentic
implement-and-auto-evaluate engine that manages its own state and git history in a specific,
deliberate way. The mount is the directory containing `_workflow/driver.mjs` (default
`_bmad-output/ai-factory`; check `.gitmodules` if it was moved).

These rules apply whenever you touch factory-owned paths (`_workflow/`, `agents/`, `schema/`,
`config/`, `state/`, `queue/`, `reports/`, `verify/`) or any in-flight factory work item. The
full controller manual is the `ai-factory` skill — load it when you are asked to run, continue,
fold or report on the factory.

## Hard rules

- **Never mutate git on the factory's behalf.** No `commit`/`add`/`checkout`/`restore`/`stash`/
  `reset`/`clean`/`push` for factory-managed changes. Finished fixes live as UNSTAGED changes on
  `factory/<id>` worktree branches under `state/worktrees/` — a human reviews and commits them.
  Implementing something yourself, outside the factory, is fine; that is why the mutating-git
  rules in `opencode.json` are `ask` rather than `deny`. Anything targeting a factory worktree is
  a hard `deny` — if one of those prompts fires, the answer is no, and the right move is to
  report the branch to the human, not to find a way around the rule.
- **`state/ledger.json` is machine-owned** — single writer, the factory's driver. Never hand-edit
  it (`opencode.json` denies edits to it). `state/findings-graph.json` IS meant to be
  hand-edited — schema: `schema/work-item.schema.json`.
- **`state/STOP_REQUESTED.md` is an owner-controlled drain marker.** Never delete it from
  inference; only the owner's explicit acknowledgment lifts it.
- **Read `KNOWN-ISSUES.md` before changing anything under `_workflow/`, `verify/` or `agents/`.**
  It is an append-only registry of known limitations and accepted constraints; a change that adds
  a new limitation needs a new `KI-*` row in the same change.
- **`verify/build-test.sh` emits parseable `FACTORY::` markers** that the driver treats as the
  only trustworthy evidence of build/test outcomes. Never trust an agent's prose claim that tests
  passed over what the markers actually say — including your own.
- **Green build != done.** Every fix needs its red->green regression test; money/security/
  concurrency items additionally need real-infra (Testcontainers) proof.
- **Product-scope red-lines are hard stops.** An item whose only fix crosses a product-scope
  boundary is `scope-stop` -> BLOCKED for the human, never "fixed".

## Driving a work item yourself

You have no native equivalent of Claude Code's `Workflow` tool, so use the `_workflow/opencode/`
binding — a real Node CLI that re-implements the deterministic half of the pipeline and lets you
supply the subagent calls via your own `Task` tool:

```
node <mount>/_workflow/opencode/runtime.mjs init <itemId>
node <mount>/_workflow/opencode/runtime.mjs next <itemId>      # -> {mechanical:...} or {agents:[...]}
node <mount>/_workflow/opencode/runtime.mjs submit <itemId> --role <key> --json <file|->
node <mount>/_workflow/opencode/runtime.mjs mech <itemId> <verify|leftover|integrate|checkpoint>
node <mount>/_workflow/opencode/runtime.mjs finalize <itemId>
```

Dispatch every agent in a `{agents:[...]}` step through `Task` — one genuinely separate subagent
per role, all in a single message when there is more than one (that mirrors the native runtime's
`Promise.all`, and keeps the reviewer independent of the implementer's reasoning trail, which is
the invariant the whole review band rests on). Read `_workflow/opencode/README.md` for the full
protocol and its documented fidelity gaps (KI-O1).
