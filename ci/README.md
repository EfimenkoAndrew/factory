# Build-time audit gate (shift the rules-audit left)

## Factory selftest gates

`node _workflow/lib/_selftest.mjs` defaults to `--suite portable`: Node + usable
Bash + read-only Git, isolated HOME and empty NuGet cache, no .NET SDK or packages.
It prints **integration NOT REQUESTED**. Both installers explicitly use this gate.

The **required full repository gate** is `node _workflow/lib/_selftest.mjs --suite all`
(alias `--integration`). It includes the portable suites, real offline TRX producer,
and real .NET OpenCode lifecycle/failure-fold fixtures. `--suite integration` runs
the latter two alone. Requested integration always fails on missing prerequisites;
it never auto-skips or downloads.

Prerequisites are declared in `setup/test-fixtures/dotnet/`: exact SDK 8.0.425,
net8.0, direct packages and NuGet-resolved transitive closure in `packages.lock.json`.
They are optional test dependencies; the factory has zero npm/package dependencies.

```bash
node setup/test-prereqs.mjs --check --root /tmp/factory-test-prereqs
node setup/test-prereqs.mjs --provision --allow-network --root /tmp/factory-test-prereqs
FACTORY_TEST_PREREQS_ROOT=/tmp/factory-test-prereqs node _workflow/lib/_selftest.mjs --suite all
```

`--check` copies hash-checked archives to an isolated feed and performs an offline
`dotnet restore --use-lock-file --locked-mode`, checking actual net8.0 assets against
the lock. Missing transitives name package/version/framework/path; irrelevant
framework dependency groups are never copied. `--cache <existing NuGet packages>`
allows a read-only source cache (use `FACTORY_TEST_NUGET_CACHE` for selftests).
The default prerequisite root is `factory-test-prereqs` under the OS temp directory;
`FACTORY_TEST_PREREQS_ROOT` overrides it. Provisioning requires explicit network
consent, reuses an installed exact SDK or downloads/verifies its Microsoft SHA-512
archive into the selected root, and restores pinned packages there. It changes no
global SDK, NuGet sources, shell profile, or certificate store. Download/extraction
requires HTTPS access plus tar (Unix) or PowerShell Expand-Archive (Windows).
Delete only the selected prerequisite root to remove provisioned test resources.

The portable gate runs installer command-injection and real nonzero fixture tests,
plus `bash -n` on the E2E scripts. The full `bash setup/_e2e.sh` transactional/release
harness uses mutating Git in throwaway repositories and is a separate human-run
check; neither selftest suite executes it. Its broken tag replaces the entire
selftest with a named exit-73 fixture and asserts its marker reaches install/upgrade.

The factory's LLM review band is the deep, expensive net that finds the backlog. **`audit-diff.mjs`** is the
cheap, fast, deterministic net that keeps the backlog from growing back: a no-LLM, no-cost linter that scans
only the **added** lines of a diff for known anti-patterns and exits non-zero on any new
CRITICAL/HIGH.

It is precise enough to be a blocking gate — comment lines are skipped and string/char literals are blanked
before matching, so an anti-pattern named in an exception MESSAGE or a `//` comment is not a false match
(verified with 0 blocking false positives across a large real-world branch divergence; the only
residual findings were advisory MEDIUMs, left for a reviewer to confirm in context).

## Run it directly

```bash
node <mount>/_workflow/audit-diff.mjs                 # working-tree changes vs HEAD
node <mount>/_workflow/audit-diff.mjs --staged        # staged changes (pre-commit)
node <mount>/_workflow/audit-diff.mjs --base origin/master   # a PR's net changes
```

Exit `1` ⇒ at least one new CRITICAL/HIGH (blocks). Exit `0` ⇒ clean or only MEDIUM/LOW (advisory).

## Activate as a gate (two ways — both opt-in; neither is auto-applied)

These artifacts live under the factory mount so they do **not** alter the team's shared CI or your
git hooks until you deliberately install them.

1. **Local pre-push hook** (fast feedback, per-developer):
   ```bash
   bash <mount>/ci/install-hooks.sh
   ```
   Now every `git push` runs the gate against your upstream base and blocks on a new CRIT/HIGH. Emergency
   bypass: `git push --no-verify` (then refine the rule if it was a false positive).

2. **CI gate** (enforced for everyone, on every PR): copy `ci/audit-diff.yml` to
   `.github/workflows/audit-diff.yml` and commit it **together with** the factory dir (the workflow skips
   gracefully if the script is absent, so a partial commit fails open, not red).

## The rules it enforces

The shipped rule-set is a working default for a .NET + Kubernetes host (distilled from a real project's
engineering rules): bare `[Authorize]`, string-literal policy names, `:latest` in `k8s/base`,
`CHANGE_ME` secrets, `Version=` in `.csproj`, `bus.Publish` outbox bypass, `Guid.NewGuid()` idempotency-key
fallback, `--no-verify-ssl` (HIGH) / `DangerousAcceptAnyServerCertificateValidator` (MEDIUM, guard-dependent),
`RequireHttpsMetadata=false`, `dbContext.SaveChangesAsync` in a handler, block-scoped namespaces, plus
example product-scope HARD-STOP greps. **Edit `audit-diff.mjs` to match your own project's rules**, and
refine a rule when a false positive appears — precision is what keeps a blocking gate trusted.
