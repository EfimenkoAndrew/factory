## Role: normalizer

Turn one audited target's review docs into structured work-item nodes for the factory
graph. Routed cheap (sonnet/low) — this is bounded extraction from existing docs, not
fresh analysis. Executable copy of this contract is inlined in `_workflow/normalize.js`;
this file is the authoritative human-readable spec.

### Inputs (read)
- `{auditRoot}/services/{Target}/REVIEW-SYNTHESIS.md` — authoritative consolidated register.
- `{auditRoot}/services/{Target}/REVIEW-PO.md` — PO discrepancies (claimed vs real).
- The per-lens `REVIEW-*.md` only if the synthesis points at one for a missing file:line.

### Output (write + return)
1. **WRITE** a JSON array of work-item nodes to `{outDir}/{Target}.json` (the merge source).
2. **RETURN** the compact summary (target, prefix, file, counts, total, headline).

### One node per finding — rules
- Emit one node for **every CRITICAL and HIGH** finding in the synthesis. Add a MEDIUM
  **only** when it is a crisp mechanical win with an obvious red→green test.
- `id`: `{PREFIX}-{CODE}`, uppercase, `^[A-Z0-9]+(-[A-Z0-9]+)+$`. Reuse the synthesis's own
  code where present (`FIND-C1`→`{PREFIX}-FIND-C1`, `M-1`→`{PREFIX}-M1`); else assign
  `C1,C2,…` / `H1,H2,…` in document order. Unique within the target.
- `severity`: CRITICAL | HIGH | MEDIUM | LOW.
- `theme`: one of `security-multitenancy | money-correctness | deployability-oncall |
  product-scope | idempotency-dataflow | doc-drift | test-coverage` (the audit's T1–T7).
- `fixType`:
  - `mechanical` — doc rebuild, health-check add, tag/constant, InvariantCulture, missing
    test, config key, id-only event trim. Deterministic, localized.
  - `non-trivial` — real logic / correctness / concurrency / authz design.
  - `owner-decision` — the synthesis says an owner ruling is required (e.g. a DISPUTED
    finding); set `ownerDecision` to the question and `autonomyTier: blocked`.
  - `scope-stop` — the "fix" would cross a `product-scope.md` red-line (tax / purchase-fee /
    SAR / government-reporting / platform-shipping). NEVER auto-fix; `autonomyTier: blocked`.
- `files`: every repo-relative path named in the finding's `file:line` (the lock set).
- `dependsOn`: same-target ordering only (e.g. a test depends on the fix it covers, or a
  health-probe fix depends on the exporter it queries). Leave cross-service links for `cascade`.
- `realInfra`: true when a green EF-in-memory test does NOT close it — money / security /
  concurrency / idempotency-dataflow.
- `autonomyTier`: `escalate` if theme/files touch auth, money, crypto, or cross-service
  contracts (auto-draft, human signs off before integrate); `blocked` for owner-decision /
  scope-stop; otherwise `auto`.
- `gateSet`: all five (`architect,developer,qa,security,po`) for services/portals; libs may
  drop `qa`/`po` if the synthesis treated them as lib-lenses.
- `reviewFlows` (optional, Band B/C of the review stage): **leave EMPTY** — the driver derives the
  live set from `files` at select time (code-touching → `bmad-code-review` +
  `bmad-review-edge-case-hunter`; always `bmad-review-adversarial-general` +
  `bmad-testarch-test-review`; doc-touching → `bmad-editorial-review-structure` +
  `bmad-editorial-review-prose`). Any value here is informational only; the driver does not read it.
- `acceptance`: the concrete checkable condition that means "fixed" (from the finding's Fix).
- `regressionTest`: what a red→green test must do — what fails on old code, passes on new.
- `source`: `{auditRoot}/services/{Target}/REVIEW-SYNTHESIS.md#{anchor}`.
- `fixHint`: the synthesis's suggested fix, carried verbatim where given.
- `cascade`: for an event-contract change, the producer + every consumer that must change
  together (names from the finding).

Real data only. If the synthesis is thin on a field, infer conservatively from the stated
file:line and Fix; never invent a file path. Do not pad with INFO/LOW noise.
