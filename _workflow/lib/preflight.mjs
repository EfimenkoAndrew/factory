// Environment preflight (KI-C5). A realInfra item (money / security / concurrency / idempotency) cannot
// CLOSE without Docker (Testcontainers spins real Postgres/Redis); the factory must NEVER treat an EF
// in-memory green as a real-infra pass. These probes let the driver LABEL a run's environment up front so
// "why did my realInfra item park?" is answerable before the run, not after. Shells out; kept off the hot path.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function probe(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; }
}

export function dockerAvailable() { return probe('docker', ['info']); }

// KI-E72: this probe shells `dotnet --version` directly in the CALLER's OWN process env — but the
// REAL verify path every subagent uses (verify/build-test.sh) auto-delegates to a per-host
// verify/build-test.local.sh PATH shim when one exists+is executable (KI-E17 override seam,
// SETUP.md § 6) — e.g. a host where dotnet lives outside PATH for non-interactive shells
// (~/.dotnet, PATH'd only in ~/.zshrc, which a non-interactive Bash-tool shell never sources).
// A controller session whose OWN shell lacks that sourcing reported "dotnet: ABSENT — build/test
// verify cannot run on this host" while every real verify call in the actual run succeeded via the
// shim (live 2026-08-07). Pure + injectable (shimPath param) so it's testable without real dotnet.
export function shimAvailable(shimPath) {
  // KI-E111 — the POSIX execute bit does not exist on Windows: NTFS has no such attribute, and Node
  // synthesises `mode` from the read-only flag alone, so `statSync(f).mode & 0o111` is 0 for EVERY
  // file there (verified against this repo's own shipped verify/build-test.sh: mode 0o666). That made
  // shimAvailable() unconditionally false on Windows, so dotnetAvailable()/preflight() reported
  // "dotnet: ABSENT — build/test verify cannot run on this host" on any Windows host relying on the
  // shim — a byte-for-byte recurrence of the KI-E72 false-negative this function was WRITTEN to fix,
  // one platform over. It matters concretely because the shim is never exec'd by its mode bit on
  // Windows anyway: `_workflow/opencode/buildtest.mjs` spawns build-test.sh through Git Bash, which
  // runs a .sh file regardless of NTFS attributes. So on win32 the honest test is existence-of-a-file;
  // the POSIX path keeps the mode check byte-for-byte unchanged.
  try {
    if (!existsSync(shimPath)) return false;
    const st = statSync(shimPath);
    if (!st.isFile()) return false;
    return process.platform === 'win32' ? true : !!(st.mode & 0o111);
  } catch { return false; }
}
function defaultShimPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'verify', 'build-test.local.sh');
}
// True if dotnet resolves on the raw PATH OR via the same host shim the real verify path already
// trusts — this does not itself re-prove the shim WORKS (a broken shim would still report true
// here), it reports the same trust boundary build-test.sh already relies on for every real call.
export function dotnetAvailable(shimPath) {
  return probe('dotnet', ['--version']) || shimAvailable(shimPath || defaultShimPath());
}

// KI-E33: the dashboard's cost panels (claude_code_token_usage) are fed by the Claude Code SESSION's
// OTLP telemetry, not by the factory — so if the session was launched without CLAUDE_CODE_ENABLE_TELEMETRY
// + an OTLP endpoint, an entire run's token/cost telemetry is silently NOT gathered (factory_* metrics
// still land; the two cost panels stay empty). This was missable with no cue — surface it at preflight.
// `env` is injected for testability; defaults to process.env.
export function costTelemetryReady(env) {
  const e = env || process.env;
  // Review fix: FACTORY_TELEMETRY gates only the factory's own events.jsonl (telemetry.mjs) — the
  // session's token telemetry is an INDEPENDENT plane, so it is deliberately NOT consulted here.
  // Review fix: OTEL_METRICS_EXPORTER has NO default in Claude Code — enable+endpoint alone export
  // nothing, so "ready" requires the exporter too; every missing piece is named. The endpoint may be
  // the generic OTEL_EXPORTER_OTLP_ENDPOINT or the metrics-specific OTEL_EXPORTER_OTLP_METRICS_ENDPOINT.
  const missing = [];
  if (e.CLAUDE_CODE_ENABLE_TELEMETRY !== '1') missing.push('CLAUDE_CODE_ENABLE_TELEMETRY must be "1"' + (e.CLAUDE_CODE_ENABLE_TELEMETRY ? ` (is "${e.CLAUDE_CODE_ENABLE_TELEMETRY}")` : ' (unset)'));
  if (!String(e.OTEL_METRICS_EXPORTER || '').split(',').map((s) => s.trim()).includes('otlp')) missing.push('OTEL_METRICS_EXPORTER must include "otlp"' + (e.OTEL_METRICS_EXPORTER ? ` (is "${e.OTEL_METRICS_EXPORTER}")` : ' (unset — Claude Code has NO default metrics exporter)'));
  const endpoint = e.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || e.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) missing.push('OTEL_EXPORTER_OTLP_ENDPOINT (or _METRICS_ENDPOINT) is unset — nowhere to send token telemetry');
  if (missing.length) return { ready: false, reason: missing.join('; ') + ' — the session emits no token telemetry (cost panels stay empty; see telemetry/claude-code-telemetry.env.example)' };
  const out = { ready: true, endpoint };
  if (!e.OTEL_EXPORTER_OTLP_PROTOCOL) out.note = 'OTEL_EXPORTER_OTLP_PROTOCOL unset — defaults to grpc; set http/protobuf for the collector\'s :4318 HTTP endpoint';
  return out;
}

export function preflight() {
  const dotnetOnPath = probe('dotnet', ['--version']);
  const dotnetViaShim = !dotnetOnPath && shimAvailable(defaultShimPath());
  return { docker: dockerAvailable(), dotnet: dotnetOnPath || dotnetViaShim, dotnetViaShim, costTelemetry: costTelemetryReady() };
}
