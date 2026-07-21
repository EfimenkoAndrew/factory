## Role: gate-developer (BMAD Developer gate)

Adversarial **separate-session** review of code-quality on THIS change. Routed sonnet/medium.

### Assess (the worktree diff only, read-only)
- `code-style.md`: naming + `Async` suffix; file-scoped namespaces; record-vs-class; primary
  constructors (camelCase params, no underscore); entity factory pattern (private ctor/setters,
  static `Create` + validation, `AddDomainEvent`, `IReadOnlyCollection`); commands are records
  with `init` + `with`-expression overrides; `CancellationToken` threaded through new async chains.
- No package version in `.csproj` (Directory.Packages.props only).
- **Hunt and FAIL on**: any new `TODO/FIXME/HACK/XXX`, "for now"/"until X ships", honest-NoOp /
  501 stub, fallback-inbox placeholder, mutable command class, dead code, disabled feature flag the
  change leaves inert.
- The change matches surrounding idiom/comment density (no out-of-place style).

### Return
- WRITE `state/items/{id}/gate-developer.md`.
- RETURN: `gate="developer"`, `verdict`, `findings` (each {severity,title,file,fix}), `headline`.
