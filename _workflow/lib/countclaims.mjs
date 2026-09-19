// KI-E182 (2026-09-18) — deterministic test-count-claim linter for doc/ledger prose, mirroring
// doclint.mjs's phantom-path linter (KI-E11) exactly, but for "N/M passed"-style test-count claims
// instead of file-path claims. Live incident: during EGS-4-3's direct recovery, a fixer round
// added a new test (changing a suite's real count from 2257/2282 to 2258/2283) but left the OLD
// count standing in 3 prose locations (STANDARDS-DIVERGENCE-LEDGER.md, VERIFICATION-REPORT.md x2) —
// caught only by a fresh, expensive gate-developer re-dispatch, not for free. This lint catches the
// SAME class mechanically: any "N/M passed" claim in ADDED .md lines must match a REAL
// `Passed!|Failed! ... Failed: F, Passed: P, ..., Total: T` summary line (or the keyed
// `FACTORY::SUMMARY::suite ... passed=P ...` marker) actually present in the item's OWN
// verify-raw.txt/integrate-raw.txt evidence transcripts — the exact machine-authoritative source
// build-test.sh's own `suite` subcommand already produces. A claim with no matching evidence entry
// is flagged; this does NOT judge whether the NUMBER is "good", only whether it is REAL.
//
// Deliberately narrower than a general fact-checker: it verifies arithmetic/evidence correspondence
// for ONE well-evidenced failure shape (a stale or invented pass-count), not qualitative claims
// about what a test proves (that remains the review band's job — see KI-E181's retry-prompt fix for
// the sibling "my own fix mischaracterized the code" failure mode, which this lint does not cover).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { decodeTranscript } from './verify.mjs';

// "N/M" immediately followed by whitespace + "passed" (the shape every real incident used:
// "23/23 passed", "2258/2283 passed") OR "N/M" followed later on the SAME line by "passed"
// somewhere (the shape "(2258/2283, 25 Docker-gated pre-existing)" needs — the checklist prose
// splits the ratio from the word with a trailing clause). Captured separately so the caller can
// require N <= M (a "passed out of total" ratio is never backwards) without re-parsing.
const RATIO_RE = /\b(\d{1,7})\s*\/\s*(\d{1,7})\b/g;

// Ported pattern from doclint.mjs's NOT_YET_EXISTS_RE: a line HONESTLY citing a SUPERSEDED count
// for historical context ("2258/2283 passed (was 2257/2282; +1 from the new test)") must not be
// flagged — the whole point of such a line is to correctly distinguish the old count from the
// current one, the opposite of the stale-claim-presented-as-current class this linter exists to
// catch. Deliberately line-granular, same as its sibling: a genuine stale claim on a DIFFERENT line
// in the same diff still catches; only the line that itself narrates the history is skipped.
const HISTORICAL_RE = /\bwas\b|\bpreviously\b|\bup from\b|\bdown from\b|\bincreased from\b|\bdecreased from\b|\bchanged from\b|\bold(?:er)? count\b|\bbefore (?:this|the) (?:fix|recovery|change)\b/i;

export function extractCountClaims(line) {
  const s = String(line || '');
  if (!/\bpassed\b/i.test(s)) return []; // KI-E182: only lines that actually claim a pass-count at all
  if (HISTORICAL_RE.test(s)) return []; // the line itself honestly narrates a superseded count
  const out = [];
  for (const m of s.matchAll(RATIO_RE)) {
    const passed = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    if (!(passed <= total)) continue; // a backwards ratio is never a pass-count claim (date, version, etc.)
    out.push({ passed, total, text: m[0] });
  }
  return out;
}

// Every real "Passed!/Failed! ... Failed: F, Passed: P, ..., Total: T" dotnet-test summary line
// (the SAME shape build-test.sh's own `suite`/`filter`/`red` subcommands already emit and tee),
// PLUS the keyed `FACTORY::SUMMARY::suite exit=.. failed=F passed=P skipped=S ..` marker — either
// is machine-authoritative; a transcript may carry many (one per dotnet invocation), not just one.
const DOTNET_SUMMARY_RE = /(?:Passed!|Failed!)[^\n]*?Failed:\s*(\d+),\s*Passed:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?(?:,\s*Total:\s*(\d+))?/g;
const KEYED_SUMMARY_RE = /FACTORY::SUMMARY::suite\s+exit=-?\d+\s+failed=(-?\d+)\s+passed=(-?\d+)(?:\s+skipped=(-?\d+))?/g;

// Pure core: every distinct {passed, total} pair actually evidenced in one transcript's text.
export function extractEvidencePairs(text) {
  const pairs = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(DOTNET_SUMMARY_RE)) {
    const failed = parseInt(m[1], 10), passed = parseInt(m[2], 10), skipped = m[3] ? parseInt(m[3], 10) : 0;
    const total = m[4] ? parseInt(m[4], 10) : failed + passed + skipped;
    if (Number.isFinite(passed) && Number.isFinite(total)) pairs.add(passed + '/' + total);
  }
  for (const m of s.matchAll(KEYED_SUMMARY_RE)) {
    const failed = parseInt(m[1], 10), passed = parseInt(m[2], 10), skipped = m[3] ? parseInt(m[3], 10) : 0;
    if (Number.isFinite(passed) && failed >= 0) pairs.add(passed + '/' + (passed + failed + skipped));
  }
  return pairs;
}

// Pure core (selftest-covered): claims from added lines whose {passed,total} matches NO evidenced
// pair. `evidencePairs` is a Set of "P/T" strings (see extractEvidencePairs) — a caller with
// multiple transcripts unions their pair-sets before calling this.
export function findUnevidencedCountClaims(addedLines, evidencePairs, cap = 10) {
  const missing = [];
  const seen = new Set();
  for (const line of addedLines || []) {
    for (const claim of extractCountClaims(line)) {
      const key = claim.passed + '/' + claim.total;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!evidencePairs.has(key)) { missing.push(claim.text); if (missing.length >= cap) return missing; }
    }
  }
  return missing;
}

// IO-wrapping entrypoint, mirroring doclint.mjs's lintWorktreeDocClaims exactly: added .md lines
// (tracked diff + untracked new files) from the WORKTREE, evidence pairs from the ITEM'S OWN
// verify-raw.txt/integrate-raw.txt (a sibling directory to the worktree, not inside it — the
// evidence transcripts live under state/items/<id>/, never in the tracked tree). Returns [] on any
// error — a detection aid must never block a fix. `itemDir` is optional; when omitted (or neither
// evidence file exists) every count claim is unevidenced by definition, which is the CORRECT and
// desired behavior — a count claim written before any real test run exists is exactly as
// unverifiable, and exactly as worth flagging, as one that has since gone stale.
export function lintItemCountClaims(worktree, itemDir, cap = 10) {
  try {
    const diff = execFileSync('git', ['-C', worktree, 'diff', 'HEAD', '--unified=0', '--', '*.md'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    const untracked = execFileSync('git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard', '--', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const f of untracked) {
      try { added.push(...execFileSync('cat', [worktree + '/' + f], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n')); } catch { /* per-file */ }
    }
    if (!added.length) return [];
    const evidencePairs = new Set();
    if (itemDir) {
      for (const f of ['verify-raw.txt', 'integrate-raw.txt']) {
        const p = itemDir.replace(/\/+$/, '') + '/' + f;
        if (!existsSync(p)) continue;
        try { for (const pair of extractEvidencePairs(decodeTranscript(readFileSync(p)))) evidencePairs.add(pair); } catch { /* per-file */ }
      }
    }
    return findUnevidencedCountClaims(added, evidencePairs, cap);
  } catch { return []; }
}
