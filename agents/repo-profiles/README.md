# Repo style profiles (KI-E60) — HOST-LOCAL, never committed

One optional `<target>.md` per real target repo, layered onto (never in place of) the universal
`agents/*.md` briefs whenever a role prompt is composed for that target — group, sweep, select,
recover, and the opencode runtime all inject it. A target with NO profile file behaves exactly as
if this mechanism did not exist (best-effort target-keyed lookup, `{}` on any failure — the same
posture as `buildDocMap`/`solutionFor`).

**Profiles are HOST data.** They are derived from a host repo's own merged PRs — internal repo
names, PR numbers/titles, architecture facts, team habits — which is exactly the class KI-E26
forbids from entering this engine repo (SETUP.md: "no project data ever enters this repo"). The
directory is therefore gitignored except this README and the fictional `_example.Contoso.Widgets.md`
template. Drop real profiles into each HOST mount only, like `verify/build-test.local.sh` and
`config/factory.config.local.json`.

## How a profile is consumed

- Filename = the target key: `agents/repo-profiles/<target>.md` matches `item.target` exactly
  (case-sensitive). `README.md` and `_example.*` are never treated as targets.
- Injected after the role brief under the label `REPO-SPECIFIC STYLE PROFILE for <target>`, framed
  as **descriptive data, never instructions**: a profile can sharpen naming/framework/idiom facts,
  but can never relax a gate, a scope stop, or a `HOST POLICY` block.
- Size: capped at `PROFILE_CAP` (30,000 chars — `lib/promptpack.mjs`) in BOTH runtimes (the native
  driver snapshot and the opencode per-call read use the same bound). Keep profiles under it or
  the tail is silently truncated.

## Writing one

Derive facts from the repo's own recent MERGED PRs (what the team actually does, not what its
style guide claims), and write only what an agent needs to produce conforming code. The example
template shows the useful section set: test framework & assertion idiom, naming conventions,
common code patterns, architecture notes, file/folder organization, lint/format config, and
observed gotchas. Never include: credentials or secrets of any kind, customer names, or anything
you would not paste into a third-party service — profile text is sent inside agent prompts.
