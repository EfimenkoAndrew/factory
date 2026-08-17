# `opencode-assets/` — host-installable OpenCode controller assets (KI-O5)

Installed into a host repo by `setup/init.mjs` (skip with `--no-opencode-assets`). Two halves,
because they have two different ownership stories:

| Path | Host target | How it installs |
|---|---|---|
| `root/AGENTS.md` | `<host>/AGENTS.md` | copied (`copyTree`) |
| `root/.opencode/ai-factory.md` | `<host>/.opencode/ai-factory.md` | copied (`copyTree`) |
| `root/.opencode/skill/ai-factory/SKILL.md` | `<host>/.opencode/skill/ai-factory/SKILL.md` | copied (`copyTree`) |
| `opencode.config.json` | the host's own `opencode.json` | **deep-merged** (`lib/hostinstall.mjs`) |

**`root/` is copied verbatim onto the HOST REPO ROOT** — every file added under it lands at the
corresponding path in the host repo, with the same `copyTree` contract the Claude and Copilot
assets use: byte-identical is a silent no-op, absent is created, and a locally-edited file is
NEVER clobbered (the new version is written alongside as `*.factory-new` with a warning).
`AGENTS.md` is the one asset a host is genuinely likely to already own, which is why the shipped
copy is a short pointer: the substance lives in `.opencode/ai-factory.md`, a factory-owned path
that cannot collide, loaded on every request via the merged `instructions` entry. A host that
keeps its own `AGENTS.md` therefore still gets the full rule set.

**`opencode.config.json` is a fragment, not a file to copy.** An OpenCode config is the host's
own — it carries their model, provider and MCP settings — so the factory merges into it rather
than owning it. `mergeOpencodeConfig` (`_workflow/lib/hostinstall.mjs`, selftest-pinned) appends
the factory's `instructions` entry and re-appends the factory's `permission` rules at the END of
each tool's rule object, because opencode evaluates the **last** matching pattern and a broad
host rule declared later would otherwise outrank a factory rule.

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
