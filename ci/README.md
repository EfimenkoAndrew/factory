# Build-time audit gate (shift the rules-audit left)

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
