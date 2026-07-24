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
  return { docker: dockerAvailable(), dotnet: dotnetAvailable(), costTelemetry: costTelemetryReady() };
}
