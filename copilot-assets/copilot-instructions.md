# AI Implementation Factory — Copilot instructions

This repo has the AI Implementation Factory mounted (an in-project agentic
implement-and-auto-evaluate engine). It manages its own state and git history in a specific,
deliberate way. Follow these rules whenever you touch factory-owned paths (`_workflow/`,
`agents/`, `schema/`, `config/`, `state/`, `queue/`, `reports/`, `verify/`) or any in-flight
factory work item.

## Hard rules

- **Never mutate git on the factory's behalf.** No `commit`/`add`/`checkout`/`restore`/`stash`/
  `reset`/`clean` for factory-managed changes. The factory's own fixes live as UNSTAGED changes
  on `factory/<id>` worktree branches — a human reviews and commits them. If you're implementing
  something yourself (not the factory), that's fine; just don't touch a `factory/<id>` worktree's
  git state, and don't commit on the factory's behalf even if asked to "clean up" its output.
- **`state/ledger.json` is machine-owned** — it has a single writer (the factory's driver). Never
  hand-edit it. The findings-graph (`state/findings-graph.json`) IS meant to be hand-edited —
  schema: `schema/work-item.schema.json`.
- **Read `KNOWN-ISSUES.md` before changing anything under `_workflow/`, `verify/`, or `agents/`.**
  It's an append-only registry of known limitations and accepted constraints; a change that adds
  a new limitation needs a new `KI-*` row in the same change.
- **`verify/build-test.sh` emits parseable `FACTORY::` markers** the driver treats as the only
  trustworthy evidence of build/test outcomes — never trust an agent's own prose claim that tests
  passed over what the markers actually say.

## Driving a factory work item yourself

If you're asked to act as the factory's worker plane directly (implement a work item through its
full lifecycle: RED → GREEN → BUILT → TESTED → GATED → REFUTE_OK → REAUDITED → INTEGRATED →
CLOSED), you have no native equivalent of Claude Code's `Workflow` tool — use the
`_workflow/opencode/` binding instead. It's controller-agnostic despite the name: see
`_workflow/opencode/README.md`'s "Usage protocol" and "Using this binding from GitHub Copilot"
sections for the exact `init`/`next`/`submit`/`mech`/`status`/`finalize` command sequence, and
its "no independent subagent dispatch" caveat — you'll be playing every review role yourself in
one conversation, which is a known, accepted fidelity gap (see `KNOWN-ISSUES.md` KI-O4), not
something to work around silently.
