# AI factory controller guidance

This repo has the **AI Implementation Factory** mounted — an in-project agentic
implement-and-auto-evaluate engine. The mount is the directory containing
`_workflow/driver.mjs` (default `_bmad-output/ai-factory`; check `.gitmodules` if moved).

Read **`.opencode/ai-factory.md`** before touching factory-owned paths or work items.
The operating procedure is the **`ai-factory` skill** (v1: `.opencode/skill/ai-factory/SKILL.md`;
v2: `.opencode/skills/ai-factory/SKILL.md`). OpenCode v2 loads this `AGENTS.md` guidance;
its `instructions` config array does not load files. Do not rely on `CLAUDE.md` fallback.

The three rules that matter most, restated here so they are never a click away:

1. **Never mutate git on the factory's behalf** — no `commit`/`add`/`checkout`/`restore`/
   `stash`/`reset`/`clean`/`push` for factory-managed changes. Finished fixes wait as UNSTAGED
   changes on `factory/<id>` branches under `state/worktrees/`; a human reviews and commits them.
2. **`state/ledger.json` is machine-owned** — single writer, the factory's driver. Never
   hand-edit it. `state/findings-graph.json` IS hand-editable (`schema/work-item.schema.json`).
3. **`state/STOP_REQUESTED.md` is an owner-controlled drain marker** — never delete it from
   inference.

4. **One controller lease, independent reviewers.** Read the controller manual before
   dispatch. Product-scope red-lines require BLOCKED/owner ruling. Build/test markers,
   including RED and required real-infra proof, outrank agent prose.

Setup embeds this section in an `ai-factory` marker block while preserving surrounding
host guidance. Untouched installed blocks upgrade by content hash; edited or unknown
blocks receive an `AGENTS.md.factory-new` proposal for manual merging.
