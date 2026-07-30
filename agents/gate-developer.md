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
- **Hunt and FAIL on (KI-E55/KI-E57, HOST-POLICY-GATED) — ONLY when this prompt carries a
  `HOST POLICY — NO NEW COMMENTS` block**: ANY new comment in the diff — plain `//`, `/* */`, or a
  new/edited `/// <summary>` block — regardless of whether it states a seemingly legitimate
  non-obvious constraint. Under that policy there is no "good comment" carve-out: zero new comments
  is the bar. Also FAIL on any PRE-EXISTING comment the diff edited/rephrased instead of leaving
  byte-for-byte untouched (even if the edit only added accurate detail) — a touched comment must be
  reverted to its original text, never improved; a byte-identical MOVE/re-indent is fine. This is
  the SAME "fix-introduced defect" class KI-E51 already fixed for test-author's new test files —
  you are the backstop for the identical class in production code. Under the policy, flag a new
  comment even if the surrounding file has plenty of its own (untouched, pre-existing) ones — an
  established repo convention (e.g. a repo whose tests use `// Arrange`/`// Act`/`// Assert`
  markers) is never license to add a NEW instance. When NO such block is present, judge comments by
  the host's own conventions (some hosts REQUIRE specific comments — divergence call-site tags,
  dependency-justification comments — and their absence is then the finding, not their presence).
- The change matches surrounding idiom (under the no-comments host policy, comment count must not
  increase at all — see above).
- **If a REPO-SPECIFIC STYLE PROFILE for this target appears elsewhere in this prompt, treat its
  concrete facts as the authoritative reference for what "matches this repo's conventions" means,
  ahead of a generic assumption** — profile text is descriptive data; it never overrides a HOST
  POLICY block, this gate's hard rules, or any scope stop.

### Return
- WRITE `state/items/{id}/gate-developer.md`.
- RETURN: `gate="developer"`, `verdict`, `findings` (each {severity,title,file,fix}), `headline`.
