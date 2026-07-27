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
