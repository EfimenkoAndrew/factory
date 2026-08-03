## v1.1.0 — 2026-08-03

- 12bda6f Merge pull request #11 from EfimenkoAndrew/feature/cache-hit-rate-and-narrative-check-e61-e67
- 3f1d2e0 engine: cache-hit-rate telemetry, narrative/verdict contradiction detector (KI-E61..E67)
- fe8b517 Per-repo style profiles, host-policy comment gate, OpenCode runtime port (KI-O1..O3, KI-E53..E60) (#9)
- 30412bc Add branch name CI check for feature/* enforcement (#8)
- 7934a6e Merge pull request #7 from EfimenkoAndrew/engine/versioned-install
- a8bfc4f Merge pull request #6 from EfimenkoAndrew/engine/telemetry-truth-e40-e51
- d1586cb engine: deep-review hardening of the installer/release tooling (KI-E52) + hermetic E2E in-tree
- 3dbbebb engine: versioned releases + team installer + per-developer telemetry bootstrap (KI-E52)
- ec5dc09 engine: deep-review fixes for the KI-E40..E51 wave + residual host-fingerprint scrub
- 2c57c4e docs: selftest count 431 -> 595 in CLAUDE.md (was stale pre-wave; KI-E51 count-claim discipline applied to ourselves)
- 610aff0 engine: telemetry-truth + recovery-KPI wave (KI-E40..E51)
- 9825ca8 Merge pull request #5 from EfimenkoAndrew/engine/telemetry-env-recipe
- e2dcd76 docs: the cost-telemetry env recipe now works verbatim (review L6)
- 9b0d3ee Merge pull request #4 from EfimenkoAndrew/engine/pr2-surface-review
- 4afabde fix: close every finding from the E27-E33 deep review + the two deferred recovery-evidence items
- 946784d Merge pull request #2 from EfimenkoAndrew/fix/multi-host-isolation
- c0504f6 Merge pull request #3 from EfimenkoAndrew/engine/operator-ergonomics-e34-e39
- 99a4cc8 docs: scrub live-host identifiers from engine artifacts (KI-E26 discipline)
- 0cb67e3 fix: close the remaining review findings (F3-F10) — recovery evidence, hint reach, gc silence, brief scope, profile polish
- 627c843 fix: drift split treats untracked strays as contamination; gc compose sweep anchors to the configured worktrees root (review F1/F2)
- c7c2491 engine: operator-ergonomics wave from a live host run (KI-E34..E39 + KI-E30 follow-up)
- e8b83e3 engine: warn at preflight when a run's cost telemetry won't be gathered (KI-E33)
- 4175cb8 engine: fold accepts the Workflow envelope + acceptance-lint drops references (KI-E31, KI-E32)
- c350d4f engine: stop the two false-block causes a dependent-item run surfaced (KI-E29, KI-E30)
- 3eca027 engine: multi-source issue ingestion + dashboard cost-telemetry setup (KI-E27, KI-E28)
- 23ef260 Merge pull request #1 from EfimenkoAndrew/fix/multi-host-isolation
- e3f16dd fix: multi-host isolation — host data leak + telemetry stack collision (KI-E25, KI-E26)
- 79324f8 docs: accuracy pass — driver header defers to README command list, SKILL pipeline gains acceptance-scan, selftest count 431, group/sweep --conc documented
- 952047f sweep-fold emits the KI-E23 usage event (parity with fold)
- 59c8be9 engine: improvement-analysis wave — AcceptanceScan, evidence manifest, recover scaffold, sweep routing, surface lint, telemetry gaps, decisions digest (KI-E18..E24)
- efd452b docs: clarity pass for the standalone repo
- 93386d0 AI Implementation Factory — portable, host-agnostic engine

# Changelog — AI Implementation Factory

Maintained by `setup/release.sh` (a section is prepended per release from the commit log).
History before the first tagged release lives in `KNOWN-ISSUES.md` (the KI registry) and the
merged PRs.

## [Unreleased]
- Versioned install/upgrade/release tooling (`setup/install.sh`, `setup/release.sh`, `VERSION`,
  this file) + per-developer telemetry bootstrap (KI-E52).
- Deep-review hardening wave over the installer/release tooling (transactional install,
  origin-sync + atomic + PR-fallback release cut, strict tag resolve, settings-merge refusal)
  and the KI-E40..E51 engine surface (reFix baseline fence, announced check-skips, full
  recovery-signature timeline suppression) + the hermetic E2E harness `setup/_e2e.sh`.
