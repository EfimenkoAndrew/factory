# Repo style profile — Contoso.Widgets (FICTIONAL EXAMPLE — template only)

> This file demonstrates the profile shape for a made-up repo. Copy it to
> `agents/repo-profiles/<your-target>.md` in a HOST mount, replace every fact, and delete what you
> cannot verify from the repo's own merged PRs. Real profiles are host data and stay gitignored.

Auto-derived from analysis of the last 10 real merged PRs (#101–#110, 2026-06). Facts below
describe what the team demonstrably does in merged code, which may differ from its written style
guide — where they conflict, the merged-PR reality is recorded and flagged.

## Test framework & assertion idiom

- xUnit (`[Fact]`/`[Theory]`) + FluentAssertions (`result.Should().Be(...)`). No NUnit anywhere.
- Test names: `MethodName_Scenario_ExpectedBehavior`. One test class per production class.
- Mocking: NSubstitute (`Substitute.For<IWidgetStore>()`); Moq appears only in the two oldest
  test projects — match the sibling file, do not migrate either way.

## Naming conventions

- Private fields `_camelCase`; async methods carry the `Async` suffix; interfaces `I`-prefixed.
- DTOs are positional records (`public record WidgetDto(Guid Id, string Name);`).

## Common code patterns

- Handlers take dependencies via primary constructors; no property injection anywhere.
- Guard clauses throw `ArgumentException.ThrowIfNullOrEmpty` — never hand-rolled `if/throw`.
- Result-shaped returns (`OneOf<Widget, NotFound>`) in Application; controllers translate.

## Architecture notes

- Clean-architecture 4-project layout: `Api` / `Application` / `Domain` / `Infrastructure`.
- Persistence is EF Core + PostgreSQL; migrations are CLI-generated, one per PR when schema moves.
- Messaging via MassTransit + RabbitMQ with the EF outbox; no direct bus publishes.

## File/folder organization

- One feature folder per aggregate under `Application/Features/<Aggregate>/`.
- Tests mirror source paths: `src/Contoso.Widgets.Application` → `tests/...Application.Tests`.

## Linting/formatting config

- `.editorconfig` enforces file-scoped namespaces + 4-space indent; `dotnet format` runs in CI.

## Gotchas observed in merged PRs

- The `WidgetCache` invalidation helper must be called after every write path — two merged PRs
  fixed misses of exactly this; treat it as a review checklist item for any write-path change.
