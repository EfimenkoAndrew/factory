# Real-infra verification (Phase 3) — Testcontainers harness notes

> Status: **ACTIVE (Phase 3, 2026-06-26).** The binding gate is wired in `factory.js`: a `realInfra=true`
> item cannot CLOSE on an EF in-memory green — verify requires `realInfraExercised===true` (else FAILED
> if Docker is present, `BLOCKED:needs-docker` if absent). The runner detects Docker and the test-author
> writes a Testcontainers-backed test. This file is the harness contract.

## Why (the #1 audit theme: the green-build illusion)

The audit's headline root cause was that **money / concurrency / multi-pod CRITICALs are
invisible to the EF Core in-memory provider** — the suite is green while the defect ships.
Examples from `CROSS-SERVICE-FINDINGS.md`: CPS `ReserveAsync` read-then-append TOCTOU
double-spend (T2), Analytics consumer-agnostic idempotency-key collision dropping a
projection (T5), SagaService unschema-qualified reaper SQL `42P01` swallowed (T5). Every one
passes in-memory.

**Rule:** a work item with `realInfra=true` (theme ∈ money-correctness / security-multitenancy /
idempotency-dataflow / concurrency) is **NOT** CLOSED on an in-memory green. Its verify stage
MUST run against real Postgres/Redis (and, for multi-pod races, two app instances).

## Harness shape

Most services already ship Testcontainers-style integration fixtures; where present, the runner
points `dotnet test` at the real-infra suite instead of the in-memory factory. Where absent, the
Phase-3 fixture is:

- **Postgres**: `Testcontainers.PostgreSql` → real schema via the service's EF migrations
  (`MigrateAsync` against the container), exercising `WHERE balance >= amount`, unique-index
  23505 paths, schema-qualified SQL, optimistic-concurrency `RowVersion`.
- **Redis**: `Testcontainers.Redis` → real `SET NX` (DPoP nonce / idempotency), rate-limit
  windows, search-Redis health.
- **Multi-pod race**: two `WebApplicationFactory` hosts (or two scoped service providers) sharing
  ONE container, driving the concurrent interleaving the finding describes (e.g. two `ReserveAsync`
  callers, two first-delivery consumers inserting the same `ProcessedEvent`).
- **MassTransit**: the in-memory test harness for outbox ordering, but the consumer's DB writes
  hit the real Postgres container so idempotency-key uniqueness is genuinely enforced.

## Gate

The runner returns `realInfraExercised`. For a `realInfra=true` item, the QA gate and the refuter
both FAIL the item if `realInfraExercised` is false — an in-memory green is explicitly rejected as
proof. Docker-absent environments: the item parks `BLOCKED:needs-docker` (never a silent pass —
`deploy-verification.md` / audit AP#19), surfaced in `queue/decisions.md`.

## Driver hook

`factory.config.json:realInfraThemes` + the work item's `realInfra` flag select this path. The
runner template (`agents/runner.md`) already asks for `realInfraExercised`; Phase 3 makes it
binding for those themes.
