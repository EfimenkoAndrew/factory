# Native artifact isolation and persistence — integration handoff

## Implemented endpoints

- `native-persist.mjs <artifactDir> <checkpoint-input-DIGEST.json> --expected-request DIGEST` consumes a prewritten snapshot. The digest covers `nativeCheckpointRequest(artifactDir, output, snapshot)` (canonical `nativeRequestJson`, SHA-256), including destination, item/run/claim/attempt and payload. Output is mechanically selected from state: `IN_PROGRESS` → `progress.json`, terminal → `result.json`. It rejects invalid states/stages, budget-stopped results, mismatched admission and unsafe paths; writes are atomic same-directory replacements, identical bytes are not rewritten. Fold remains independently authoritative.
- `native-evidence.mjs` now requires the exact `evidence-input-DIGEST.json` in the artifact directory. Its existing request digest still covers the full hydrated metadata. The old parse-only admission CLI is compatibility-only under explicit `--legacy`; Workflow uses `native-persist.mjs` instead.
- `prepare-verification.mjs ... initial verification-contract-input.json --expected-request DIGEST` verifies the canonical input digest before deriving commands or archiving/creating output.
- These endpoints reject existing instruction-bearing files anywhere below the item artifact directory, symlink/junction ancestors or descendants, hardlinked files and nonregular files. Files are never deleted/quarantined by inference. The scan detects contamination; it cannot undo already-loaded nested instructions or stop a concurrent external writer.
- Workflow generates checkpoint payload/digest **after** recording the dispatch-start observation inside the limiter. It carries no fresh clock or completed usage counters. SWEEP's embedded persistence uses the same helper. Exact mocked replay and existing native contract tests remain applicable.
- Native count-claim commands now explicitly pass `--transcript <current attempt path>`. Final code refresh substitutes its new path; prose-only refresh retains the verified code transcript. Missing proof before initial verification is explicitly unavailable, not clean.

## Required driver/controller wiring (parent-owned)

1. Before **any** Workflow/agent invocation, call `assertArtifactTree()` on the artifact root(s), including the shared parent directories that could contain inherited `CLAUDE.md`. Refuse contaminated launches and ask the owner to handle the file; a first relay scan happens after that worker may already have loaded instructions.
2. Optionally pre-stage immutable evidence context using `stageNativeContext(itemArtifactDir, metadata)` from `native-context.mjs`. Supply returned references in `A.nativeEvidenceContexts[itemId]`. Snapshot exactly `acceptance`, normalized `policies`, `profile`, complete `reviewerContract` (including effective portfolio), `inputs`, and `engineMount`. Workflow recomputes the expected digest before using the reference; Node rechecks exact path/content. Keep these files through cached continuation. Add `native-context-<64 lowercase hex>.json` to the shared artifact vocabulary; `checkpoint-input-<digest>.json` is also required. No automatic driver prestaging is claimed here.
3. Register `native-artifact.test.mjs` in the full gate if discovery is not enabled. Existing `native-efficiency_test.mjs` was updated for the exact input-only writer contract. No edits to the shared selftest in this workstream.
4. Registry owner: append the KI row below, assigning the available ID. Do not describe instruction isolation as fully deployed until the hook and trusted dispatch policy are wired.

## Installer-owned PreToolUse hook

Public Claude Code reference: <https://code.claude.com/docs/en/hooks>. Project/settings hooks apply inside subagents. This implementation uses the documented stdin `{tool_name,tool_input,cwd}` and stdout `hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason}`. No unverified `agent({allowedTools})` or `agent({tools})` API was added.

Install a synchronous command handler for **all** tools, not just Write/Edit:

```json
{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"node \"<factory>/_workflow/artifact-guard.mjs\" --hook \"<trusted-policy.json>\""}]}]}}
```

The owner-managed policy v1:

```json
{
  "version": 1,
  "artifactRoots": ["<absolute existing artifact directory>"],
  "mechanical": true,
  "allowedWrites": [{"path":"<absolute exact staged-input path>","digest":"<sha256 of exact Write.content UTF-8 bytes>"}],
  "allowedReads": ["<resolved absolute exact staged-input path>"],
  "allowedCommands": ["<exact complete Node invocation>"]
}
```

Mechanical mode permits only exact-byte Write, exact Read and exact Bash commands. Edit/MultiEdit/NotebookEdit, alternate shell, MCP and unknown tools are denied; shell string matching is exact, no shell parser or wildcard prefix. A hook no-decision never grants a permission. Invalid policy/event or scan errors fail closed. The controller must bind each subagent/dispatch to its policy using trusted runtime identity, **not** an agent-selected path, merge policies without cross-agent grants, and keep policy/helper/installer settings outside agent-writable surfaces. If the installed runtime cannot provide trusted dispatch association, refuse strict mechanical launches rather than treating a shared broad allowlist as equivalent. Generated telemetry invocations must be exact-listed too, or omitted in strict relays. Installer ownership is outside this change.

`mechanical:false` only blocks instruction-bearing file-tool writes within artifact roots and scans for existing contamination. It is not a filesystem sandbox: arbitrary shell commands, aliases through unrecognized tools, parent-process writes and time-of-check races remain outside that mode. Strict mode also requires trusted executable resolution and protecting executable dependencies; an exact approved command that itself executes arbitrary untrusted code is not safe. Semantic build/fixer workers require their own host write isolation. Do not advertise OS-wide prevention from either this hook or a scan.

## Integration reuse decision API

`nativeIntegrationReuseDecision({enabled, previous, current, transcript, expected, worktree})` is opt-in and read-only. Version-1 execution fingerprints require matching current `codeHash`, `commandHash`, `environmentHash`, `sdkHash`, item/run/claim/pass, FULL band and all-target command expectations. The previous transcript hash must match its bytes and all requested build/suite invocations must independently pass. Missing evidence, LIGHT, changes or failure return `reuse:false`.

Current native receipts do not independently capture SDK/environment execution fingerprints. Consequently **Workflow still runs the independent integrator and full integration commands**. This helper is a scheduling decision API for a future trusted producer, not reuse authorization or a claim of measured savings. Parent wiring must capture fingerprints mechanically with verification, recompute immediately before integration, preserve a distinct integrator judgment and independently verifiable fold evidence pair; do not copy markers to claim fresh execution.

## Suggested registry row (parent assigns ID)

Native E1QjaY artifact-context leak / parse-only persistence: digest/state/path-bound Node checkpoints and preparation, exact request-input names, atomic idempotent writes, fail-closed instruction/link scans, optional immutable context relay and a documented synchronous PreToolUse guard API implemented. Deployment still requires parent prelaunch scans, trusted per-dispatch policies and installer hook settings; scans cannot prevent prior nested-instruction loading or arbitrary shell writes. FULL reuse remains off pending complete SDK/environment execution proof; the opt-in decision API rejects incomplete proof. Focused no-paid-call tests exercise persistence mutation, replay, hook denial, links, context corruption and reuse misses.
