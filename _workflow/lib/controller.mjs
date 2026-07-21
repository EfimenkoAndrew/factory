// KI-C11 — session-controller LEASE for the factory campaign. The advisory per-command lock
// (lock.mjs, KI-B2) serializes individual driver invocations, but a CAMPAIGN — group → launch →
// fold — spans many commands with the Workflow running in between; two sessions interleaving
// campaign commands on ONE ledger was witnessed live 2026-07-04 (KNOWN-ISSUES § C KI-C11 /
// § A.19). This lease makes accidental concurrency LOUD: the first mutating command of a session
// auto-claims `state/controller.json` (token + heartbeat); every subsequent mutating command must
// present the token (--controller / FACTORY_CONTROLLER); a bare or mismatched command while a
// FRESH foreign lease is held REFUSES. A lease whose heartbeat is past the TTL is stale — the
// holder crashed or the session ended — and is silently claimable by the next controller.
//
// Advisory ANTI-FOOTGUN, same posture as lock.mjs — NOT a security boundary. The token sits
// world-readable on disk; a determined impersonator can read it. The threat model is an
// ACCIDENTAL second controller (a zombie daemon, a second innocent session) running bare
// commands — those now fail fast with recovery instructions instead of silently racing.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const DEFAULT_TTL_MINUTES = 240; // must outlast the longest group→fold gap (a full Workflow band)

export function loadController(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } // absent/corrupt -> no lease
}

// Stale = heartbeat missing/corrupt or older than the TTL. Corrupt parses to NaN, and NaN < ttlMs
// is false -> stale (fail toward claimable, matching lock.mjs's corrupt-lock-is-stealable posture).
export function isStale(ctl, nowIso, ttlMinutes) {
  if (!ctl || !ctl.heartbeatAt) return true;
  const age = Date.parse(nowIso) - Date.parse(ctl.heartbeatAt);
  return !(age < ttlMinutes * 60 * 1000);
}

// tmp+rename atomic write — single-writer under the driver's advisory lock (KI-B3 applies here too).
function writeAtomic(path, doc) {
  writeFileSync(path + '.tmp', JSON.stringify(doc, null, 2) + '\n');
  renameSync(path + '.tmp', path);
}

// Claim (or refresh) the lease. `token` provided + matching the current lease -> refresh in place
// (same acquiredAt). Free or stale lease -> claim with the provided token or a freshly minted one.
// FRESH lease under a DIFFERENT token -> refused unless `force` (the post-zombie-kill takeover).
export function claimController(path, { token, label, nowIso, ttlMinutes, force } = {}) {
  const cur = loadController(path);
  const stale = cur ? isStale(cur, nowIso, ttlMinutes) : false;
  const mine = cur && typeof token === 'string' && cur.token === token;
  if (cur && !stale && !mine && !force) return { ok: false, holder: cur };
  const tok = (typeof token === 'string' && token) || randomBytes(6).toString('hex');
  const doc = {
    token: tok,
    label: label || (mine && cur.label) || 'controller',
    pid: process.pid, // informational only — the driver process exits between commands
    acquiredAt: (mine && cur.acquiredAt) || nowIso,
    heartbeatAt: nowIso,
  };
  writeAtomic(path, doc);
  return { ok: true, controller: doc, takeover: !!(cur && !mine), wasStale: stale };
}

// Verify a mutating command's right to proceed. Returns:
//   { ok:true,  reason:'match' }            — token matches; heartbeat refreshed.
//   { ok:false, reason:'none' }             — no lease; caller should auto-claim.
//   { ok:false, reason:'stale',  holder }   — lease past TTL; caller may auto-claim (takeover).
//   { ok:false, reason:'foreign', holder }  — FRESH lease under another token; caller must REFUSE.
export function verifyController(path, token, nowIso, ttlMinutes) {
  const cur = loadController(path);
  if (!cur) return { ok: false, reason: 'none' };
  if (typeof token === 'string' && cur.token === token) {
    writeAtomic(path, { ...cur, heartbeatAt: nowIso, pid: process.pid });
    return { ok: true, reason: 'match', holder: cur };
  }
  if (isStale(cur, nowIso, ttlMinutes)) return { ok: false, reason: 'stale', holder: cur };
  return { ok: false, reason: 'foreign', holder: cur };
}

// Release only with the matching token (a mismatched release is a no-op false — never unlink a
// lease you don't hold). Missing file is also false.
export function releaseController(path, token) {
  const cur = loadController(path);
  if (!cur || typeof token !== 'string' || cur.token !== token) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}
