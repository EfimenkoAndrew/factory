// Environment preflight (KI-C5). A realInfra item (money / security / concurrency / idempotency) cannot
// CLOSE without Docker (Testcontainers spins real Postgres/Redis); the factory must NEVER treat an EF
// in-memory green as a real-infra pass. These probes let the driver LABEL a run's environment up front so
// "why did my realInfra item park?" is answerable before the run, not after. Shells out; kept off the hot path.
import { execFileSync } from 'node:child_process';

function probe(cmd, args) {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; }
}

export function dockerAvailable() { return probe('docker', ['info']); }
export function dotnetAvailable() { return probe('dotnet', ['--version']); }

// KI-E33: the dashboard's cost panels (claude_code_token_usage) are fed by the Claude Code SESSION's
// OTLP telemetry, not by the factory — so if the session was launched without CLAUDE_CODE_ENABLE_TELEMETRY
// + an OTLP endpoint, an entire run's token/cost telemetry is silently NOT gathered (factory_* metrics
// still land; the two cost panels stay empty). This was missable with no cue — surface it at preflight.
// `env` is injected for testability; defaults to process.env.
export function costTelemetryReady(env) {
  const e = env || process.env;
  if (e.FACTORY_TELEMETRY === '0') return { ready: false, reason: 'FACTORY_TELEMETRY=0 (telemetry disabled)' };
  if (e.CLAUDE_CODE_ENABLE_TELEMETRY !== '1') return { ready: false, reason: 'CLAUDE_CODE_ENABLE_TELEMETRY is not "1" — the session emits no token telemetry (cost panels stay empty)' };
  if (!e.OTEL_EXPORTER_OTLP_ENDPOINT) return { ready: false, reason: 'OTEL_EXPORTER_OTLP_ENDPOINT is unset — nowhere to send token telemetry' };
  return { ready: true, endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT };
}

export function preflight() {
  return { docker: dockerAvailable(), dotnet: dotnetAvailable(), costTelemetry: costTelemetryReady() };
}
