// Advisory single-writer lock for the ledger (KI-B2/B3). The factory is single-writer BY DESIGN
// (ONE workflow at a time); this turns a second concurrent driver into a FAIL-FAST instead of a
// silent race that corrupts ledger.json. Exclusive-create a lockfile holding {pid, at}; steal it
// only when the holder process is dead OR the lock is stale. This is a LOCAL footgun guard, not a
// cross-host mutex — it does not make multi-writer a supported mode, it makes the unsupported case loud.
import { openSync, closeSync, writeSync, readFileSync, unlinkSync } from 'node:fs';

const STALE_MS = 10 * 60 * 1000; // a lock older than 10 min (dead/forgotten run) is stealable

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } // EPERM => alive but not ours
}

// Try to take the lock. Returns { ok:true, path } on success, or { ok:false, heldBy, since } if a
// live holder owns it. `nowIso` is passed in (the driver owns the clock).
export function acquireLock(path, nowIso) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx'); // exclusive create — throws EEXIST if held
      writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso || '' }));
      closeSync(fd);
      return { ok: true, path };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = {};
      try { info = JSON.parse(readFileSync(path, 'utf8')); } catch { /* corrupt -> stealable */ }
      const stale = !info.at || (nowIso && Date.parse(nowIso) - Date.parse(info.at) > STALE_MS);
      const dead = !pidAlive(info.pid);
      if (stale || dead) { try { unlinkSync(path); } catch { /* lost the steal race */ } continue; }
      return { ok: false, heldBy: info.pid, since: info.at };
    }
  }
  return { ok: false, heldBy: 'unknown' };
}

export function releaseLock(path) {
  try { unlinkSync(path); } catch { /* already gone */ }
}
