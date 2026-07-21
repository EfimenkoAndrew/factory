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

export function preflight() {
  return { docker: dockerAvailable(), dotnet: dotnetAvailable() };
}
