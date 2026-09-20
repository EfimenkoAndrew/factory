# Source identity and physical path API

## Evidence inputs

`collectEvidenceIdentity(worktree, metadata, options = {})` returns only
`{version, hash, codeHash, baseRevision, fileCount}`. Version 3 invalidates old
fingerprints. No source/config values, secret values, link targets, or file lists
are emitted in that result. No git mutation is performed.

The collector covers tracked working-tree bytes and deletions, index file modes,
working-tree executable bits, nonignored untracked files, and recursive gitlinks.
A gitlink binds both its index revision and its initialized worktree HEAD, then
recursively collects the child's files. Missing/uninitialized worktrees, conflicted
indices, unreadable inputs, unsupported special files, and escaping/dangling
symlinks fail collection. A file symlink binds its link text and target bytes;
directory symlink file entries fail closed rather than claiming incomplete content.

### Trusted live engine mount

A freshly created host worktree does not initialize submodules. Its factory
gitlink is execution infrastructure, not a required product checkout. Native and
OpenCode metadata producers pass this separate driver-owned contract:

```js
metadata.engineMount = { path: MOUNT_REL, sourceRoot: FACTORY_ROOT };
metadata.reviewerContract.briefs = effectiveBriefSnapshot;
preflightWorktreeInputs(worktree, metadata); // lib/worktree.mjs, before dispatch
```

`path` is the exact repository-relative engine mount; `sourceRoot` is the absolute
live factory source directory. Both must come from trusted controller discovery,
never a work item, agent response, or product input exclusion. The schema permits
only these two properties. The engine contract requires a nonempty effective
`reviewerContract.briefs` object containing nonempty strings; the existing
`briefsDirectory` loader can supply it. Other effective reviewer/profile/config
fields remain in `reviewerContract` and are fingerprinted with that snapshot.

The collector reads the live `VERSION`, revision, and source hashes itself;
caller-supplied hashes are rejected. Required source roots are exported as
`ENGINE_SOURCE_PATHS`: `VERSION`, `_workflow`, `agents`, `verify`, `config`, and
`schema`. Missing roots or unreadable files fail; source symlinks fail closed.
Generated/dependency directories are pruned. Dirty live implementation/config
bytes, version/revision changes, and effective contract changes invalidate both
identities. Paths/source contents are not emitted in the result.

Only that exact mount and its descendants are omitted from product traversal and
discovery, whether its worktree copy is initialized or empty. Sibling gitlinks and
all product gitlinks still require initialized worktrees, even when listed in
`inputs.excludePaths`/globs. No blanket missing-submodule exemption exists.
Without `engineMount`, every gitlink retains the product requirement.

`preflightWorktreeInputs(worktree, metadata, options = {})` performs the same
read-only collection and returns the identity or throws. It accepts the same
injected git/fs interfaces for tests. The driver calls it before costly dispatch
for newly created and reused worktrees; neither it nor the collector runs git
submodule initialization. It does not create a worktree or modify Git state.

Supply a host-owned declared input contract as `metadata.inputs` (survives JSON
transport to the existing CLI), or `options.inputs` for a direct Node caller:

```js
const inputs = {
  includePaths: ['build/custom.settings', 'src/Service/config', 'vendor/tool/version.lock'],
  includeGlobs: ['**/deployment/*.config', 'eng/**/*.lock'],
  excludePaths: ['factory/state', 'factory/reports'],
  excludeGlobs: ['**/generated-evidence/**'],
  // Optional replacement for DEFAULT_GENERATED_EXCLUDES:
  // generatedExcludes: ['**/.git', '**/node_modules', '**/bin', '**/obj'],
  discoverDefaults: true,
};
collectEvidenceIdentity(worktree, { ...metadata, inputs });
```

All paths/globs are repository-root-relative, including nested submodules.
Globs support `/`, `*`, `?`, and whole-segment `**`; unsupported syntax throws.
`includePaths` can name a file or directory tree, including an otherwise-pruned
generated location. A missing explicit path is fingerprinted as absent, so later
creation invalidates identity. An explicit path also excluded by the contract is
an error. Explicit exclusions apply to tracked files and discovered inputs and must
name only host-confirmed noninputs; they are themselves fingerprinted. Product
gitlinks are still checked and their revisions bound despite such exclusions.

Default discovery includes ignored `.env`/`.env.*`, global.json, NuGet configuration, MSBuild
props/targets, dependency manifests/lockfiles and common build configuration
(exported `DEFAULT_INPUT_GLOBS`). `DEFAULT_GENERATED_EXCLUDES` prunes dependency
and output directories **before reading their children**. It affects discovery,
not tracked/nonignored git inputs. `includeGlobs` uses that bounded discovery;
use `includePaths` to opt specific generated/dependency inputs back in. Source
text is never parsed to guess every dynamic build reference. Hosts must declare
nonstandard referenced inputs; external inputs must be materialized inside the
repository and declared. This is a deterministic declared source contract, not
a promise to discover arbitrary environment/network/SDK inputs.

The normalized contract affects both hashes. Markdown/RST ordinarily affect
review identity only, but explicitly included or discovered build-input documents
also affect `codeHash`. Discovery adds no model invocation or prompt payload.

For tests, `options.git` is a read-only interface:
`{root(directory), head(directory), index(directory), untracked(directory)}`.
`index` returns `{path, mode, oid}[]`; `untracked` returns relative strings.
`options.fs` supplies the Node synchronous read/stat/realpath/directory interface.
Production uses exported `readOnlyEvidenceGit` with `--no-optional-locks`.
Injected fixtures test recursion against real file bytes, not synthetic command
output claimed as a live submodule verification run.

## Physical scheduling identities

`canonicalRepoPath(value, platform)` remains the standalone pure lexical helper
for Workflow. `repoPathIdentity(value, {repoRoot, platform?, fs?})` is the Node
helper, returning `{path, absolute, keys, exists, directory}`. Keys include a
physical-parent path and, for existing regular files, the filesystem device/inode
pair. Existing hardlink and symlink aliases overlap; new files use resolved parent
paths. Trailing separators and terminal `.`/`..` preserve directory declaration
intent even when the directory does not exist. Directory and child claims conflict
in either scheduling order, including through junction parents. Every existing
path segment must resolve inside the repository, including
segments before `..`. Unavailable file IDs fail closed. No temporary probes,
mutations, filesystem locks, or universal filesystem case-sensitivity guarantees
are used. `repoPathsOverlap(a, b)` compares identities and directory ancestry.

Existing API extensions accept either the original platform string or an options
object; the string form also accepts a following optional `repoRoot`:

```js
const paths = { repoRoot: REPO_ROOT };
const locks = lockedFiles(graph, ledger, paths);
conflictFor(item, locks); // inherits paths from the returned Map
conflictFor(item, rawLocks, paths); // copied/raw Maps need explicit options
filesOverlapDirty(item.files, dirty, paths);
unclaimedMainDrift(dirty, mountRel, claimedPaths, paths);
splitDriftByStatus(REPO_ROOT, drifted, paths);
```

Snapshots/drift hashing and worktree-debris reads already receive repository roots
and now enforce physical containment. The compatibility repair helper remains
diagnostic-only.

## Caller contract

Root-aware `computeReady`, eligibility and `disjointItems` callers carry
`{repoRoot: REPO_ROOT}` through lock/dirty comparisons. Raw/copied lock maps need
explicit options. Directory declarations are preserved in the map, not collapsed
to lexical file strings.

Identity metadata must carry `inputs`, `engineMount`, and the effective
`reviewerContract` consistently for initial, final, fold and recovery collection
in both bindings. The existing collector CLI transports these JSON fields; no
new flag is needed. Engine source fingerprinting is recomputed live, not copied
from a prior successful checkpoint. The driver carries the input and trusted mount
contracts through launches, native/OpenCode producers and recovery; fold checks
them against current configuration and independently collected version-3 identity.

These are point-in-time identities, not atomic filesystem snapshots. Concurrent
replacement and transient mutate/revert activity require execution isolation if
the host wants prevention. Hardlinks to external names cannot be discovered from
an in-repository path alone. No claim of OS write prevention is made.

## Coverage boundaries

Nonmutating fixtures combine injected read-only git responses with real file bytes
and real read-only checkout inspection. Physical-path tests exercise hardlinks and
directory junctions. If Windows denies native file-symlink creation, that case injects
only link metadata/realpath while retaining real target-file reads; it is reported
as injected coverage, not a successful native file-symlink creation. Unsupported
actual hardlink/directory-link creation is reported separately by the fixture.
