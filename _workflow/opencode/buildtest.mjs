// tools/ai-factory/_workflow/opencode/buildtest.mjs
//
// OPENCODE ADAPTER (KI-O1). Wraps `verify/build-test.sh` — the SAME deterministic, unmodified script
// the real factory pipeline's runner/test-author/integrator subagents invoke — so the mechanical
// build/test/pack/leftovers/claims steps run identically under this port. No LLM call needed for
// these steps; they are pure toolchain invocation + FACTORY:: marker emission, exactly as upstream.
//
// Windows note: the default `bash` on PATH on this host resolves to a broken WSL stub (no /bin/bash
// in the registered distro). Git for Windows ships a real bash at a fixed path; we invoke that
// explicitly rather than relying on `bash` resolution. If that path doesn't exist on some other
// host, override via the OPENCODE_FACTORY_BASH env var.

import { spawnSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
// Re-export the REAL parsers driver.mjs's fold uses — imported directly (this module is a normal
// Node script with full disk/require access, unlike factory.js's sandboxed runtime) so there is
// ZERO risk of this port's transcript parsing drifting from what `driver.mjs fold` will actually
// apply. Do NOT re-derive these by hand — that was tried and produced subtly wrong regexes
// (missing the keyed-SUMMARY-overrides-heuristic ordering and the dotnet Passed!/Failed! line).
export { parseVerifyRaw, verdictFromParse, parseRedRaw, hasRealInfraMarker, touchedRootCause, debrisFiles, effectiveBaseline, decodeTranscript } from '../lib/verify.mjs';
// Same rationale: reuse the driver's own docker/dotnet probes instead of a hand-rolled duplicate.
export { dockerAvailable, dotnetAvailable } from '../lib/preflight.mjs';

const DEFAULT_BASH_CANDIDATES = [
  process.env.OPENCODE_FACTORY_BASH,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'bash', // last resort — PATH resolution, works as-is on a real POSIX host
].filter(Boolean);

function resolveBash() {
  for (const cand of DEFAULT_BASH_CANDIDATES) {
    if (cand === 'bash') return cand; // can't existsSync a bare PATH lookup; try it last
    if (existsSync(cand)) return cand;
  }
  return 'bash';
}

/**
 * Runs `verify/build-test.sh <subcommand> <args...>` via a real bash, capturing combined
 * stdout+stderr (the script's own `dotnet ... 2>&1` already folds stderr in for build/red/filter/
 * suite, but usage/exec errors go to stderr directly, so we capture both here too).
 * @returns {{code:number, output:string}}
 */
export function runBuildTest(factoryRoot, subcommand, args, opts) {
  const bash = resolveBash();
  const scriptPath = factoryRoot + '/verify/build-test.sh';
  const r = spawnSync(bash, [scriptPath, subcommand, ...(args || [])], {
    cwd: (opts && opts.cwd) || undefined,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: (opts && opts.timeoutMs) || 20 * 60 * 1000, // 20min ceiling — a hung dotnet test must not hang the whole session
  });
  const output = (r.stdout || '') + (r.stderr || '');
  if (r.error) {
    return { code: -1, output: output + '\n[opencode-adapter] spawn error: ' + r.error.message };
  }
  return { code: typeof r.status === 'number' ? r.status : -1, output };
}

/** Overwrite (not append) a raw-transcript file with the given text — matches factory.js's runner
 *  convention of one file per stage-run (verify-raw.txt / verify-red-raw.txt / integrate-raw.txt). */
export function writeRaw(path, text) { writeFileSync(path, text); }

/** Append to a raw-transcript file — used when a phase concatenates multiple sub-runs (e.g. Verify's
 *  build THEN filter/suite both land in the SAME verify-raw.txt, matching what the real runner tees). */
export function appendRaw(path, text) { appendFileSync(path, (existsSync(path) ? '\n' : '') + text); }
