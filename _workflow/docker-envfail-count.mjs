#!/usr/bin/env node
// KI-E85 (2026-08-23) — the DockerEnvFailCount CLI: `verify/build-test.sh suite` invokes this on the
// FULL, untruncated `dotnet test` output (BEFORE the display-only `grep | tail -30` that writes the
// bounded transcript to disk) so the per-test Docker/Testcontainers-unavailable failure count survives
// into the keyed FACTORY::SUMMARY::suite marker as `dockerfail=<N>` — the count is computed from the
// COMPLETE run, never from the display-trimmed artifact the driver reads back later (which, live-caught
// on a prior item, retains only bare "Error Message:" header lines with the actual exception text
// already stripped by the summary grep — the pairing this script's underlying function relies on cannot
// work against that trimmed artifact at all). Single source of truth: the SAME
// lib/verify.mjs#dockerEnvironmentalFailureCount the driver's fold-time fallback heuristic uses when a
// transcript predates this marker (an older build-test.sh, or a build-test.local.sh override host that
// has not adopted `dockerfail=`).
// Output contract: a single bare integer to stdout, ALWAYS exit 0 — a counting aid must never block a
// build/test run. Any internal error (missing module, empty stdin, etc.) prints 0.
import { dockerEnvironmentalFailureCount } from './lib/verify.mjs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let n = 0;
  try { n = dockerEnvironmentalFailureCount(input) || 0; } catch { n = 0; }
  process.stdout.write(String(n) + '\n');
  process.exit(0);
});
process.stdin.on('error', () => { process.stdout.write('0\n'); process.exit(0); });
