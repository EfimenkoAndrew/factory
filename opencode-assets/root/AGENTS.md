# Agent instructions

This repo has the **AI Implementation Factory** mounted — an in-project agentic
implement-and-auto-evaluate engine. The mount is the directory containing
`_workflow/driver.mjs` (default `_bmad-output/ai-factory`; check `.gitmodules` if moved).

The factory's full always-on rules live in **`.opencode/ai-factory.md`**, registered via
`opencode.json`'s `instructions` so every OpenCode session loads them automatically. The
operating procedure is the **`ai-factory` skill** (`.opencode/skill/ai-factory/SKILL.md`).
If you are an agent that reads only this file, read `.opencode/ai-factory.md` too before
touching anything the factory owns.

The three rules that matter most, restated here so they are never a click away:

1. **Never mutate git on the factory's behalf** — no `commit`/`add`/`checkout`/`restore`/
   `stash`/`reset`/`clean`/`push` for factory-managed changes. Finished fixes wait as UNSTAGED
   changes on `factory/<id>` branches under `state/worktrees/`; a human reviews and commits them.
2. **`state/ledger.json` is machine-owned** — single writer, the factory's driver. Never
   hand-edit it. `state/findings-graph.json` IS hand-editable (`schema/work-item.schema.json`).
3. **`state/STOP_REQUESTED.md` is an owner-controlled drain marker** — never delete it from
   inference.

Add this repo's own conventions below; `setup/init.mjs` only creates this file when it is
absent, and never overwrites your edits (it writes `AGENTS.md.factory-new` alongside instead).
