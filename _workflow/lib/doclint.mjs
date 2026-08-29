// F2 (telemetry analysis 2026-07-17) — deterministic path-claim linter for doc diffs.
// Cycle 39's ITEM-HI-11 FAILED a full review round because the fixer's own new prose asserted a
// phantom `Api/Controllers/Support/` path — a class that is machine-checkable: extract path-like
// claims from ADDED doc lines and verify each resolves somewhere in the tree. Detection aid at
// fold (WARN, never a verdict): doc paths are usually SERVICE-relative, so a claim "exists" when
// it matches any tracked file/dir as a path SUFFIX (repo-root-relative claims match trivially).
import { execFileSync } from 'node:child_process';

// Path-like tokens on a line: >=2 segments joined by '/', letters/digits/._- only.
// Deliberately conservative: skip URLs, globs, placeholders, interpolations, ranges, relative
// parents. Precision rule (live-tuned on the ITEM-HI-11 worktree): natural prose is full of
// slash-joined word alternations ("mute/unmute", "analytics/CRM", "A/B/C feature lists") — a
// claim is kept ONLY when it is unambiguously path-shaped: it ends with '/' (explicit directory
// claim, the witness shape) OR its last segment carries a file extension (services.json,
// admin-portal.md, AdminController.cs).
const CLAIM_RE = /(?:^|[\s`"'(\[])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\/?)(?=$|[\s`"')\],;:])/g;
const SKIP_RE = /https?:|[*{}<>$]|\.\.\.|^\d+(\.\d+)*\/?$|(^|\/)\.\.(\/|$)/;

// Bare-hostname first segment (hub.docker.com/…, raw.githubusercontent.com/…) — a URL written
// without its scheme is a WEB claim, not a tree-path claim (KI-E11 live false positive, 2026-07-19:
// the repo-root smoke flagged 7 scheme-less registry/CDN URLs). Deliberately TLD-listed so .NET
// Dotted.Names first segments (`Svc.Api/Controllers/…`) stay path claims.
const HOST_SEG_RE = /^(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|edu|gov|app|cloud|sh|ai|me|uk|de)$/i;

export function extractPathClaims(line) {
  const out = [];
  for (const m of String(line || '').matchAll(CLAIM_RE)) {
    const c = m[1];
    if (SKIP_RE.test(c)) continue;
    if (!c.includes('/')) continue;
    const segs = c.replace(/\/+$/, '').split('/');
    const last = segs[segs.length - 1];
    if (!c.endsWith('/') && !/\.[A-Za-z0-9]+$/.test(last)) continue; // prose alternation, not a path claim
    if (segs.every((s) => /^\d/.test(s))) continue; // timing/number lists ("500ms/1s/1.5s") — live false positive, cycle 40
    if (HOST_SEG_RE.test(segs[0])) continue; // scheme-less URL (hub.docker.com/…) — a web claim, not a tree path (KI-E11)
    const norm = c.replace(/^(?:\.\/)+/, ''); // `./data/events.jsonl` → suffix-matchable form (KI-E11 live false positive)
    if (!norm.includes('/')) continue;
    out.push(norm);
  }
  return out;
}

// Build the suffix-matchable entry list: every tracked+untracked-but-present file path plus every
// implied directory path, '/'-normalized, from `git ls-files` in the given checkout.
export function buildEntryIndex(root) {
  const files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
  const entries = new Set(files);
  for (const f of files) {
    let d = f;
    while (d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')); entries.add(d + '/'); entries.add(d); }
  }
  return entries;
}

// Does a claim resolve? Exact repo-relative match, or SUFFIX match on any entry (service-relative
// doc paths). Trailing '/' means "directory claim" — must match a directory entry. The suffix
// boundary accepts '/' OR '.' — .NET project dirs are Dotted.Names (`Svc.Api/Controllers/…`), so
// a doc claim `Api/Controllers/Admin/` legitimately refers to `…/Svc.Api/Controllers/Admin/`;
// requiring a '/' boundary alone would false-flag every such real path.
function suffixAligned(entry, want) {
  if (!entry.endsWith(want)) return false;
  const i = entry.length - want.length;
  return i === 0 || entry[i - 1] === '/' || entry[i - 1] === '.';
}
export function claimResolves(claim, entries) {
  const dir = claim.endsWith('/');
  const c = claim.replace(/\/+$/, '');
  const want = dir ? c + '/' : c;
  if (entries.has(want) || entries.has(c)) return true;
  for (const e of entries) {
    if (dir ? (e.endsWith('/') && suffixAligned(e, want)) : suffixAligned(e, c)) return true;
  }
  return false;
}

// Ported from a host-mount session (2026-08-29) — a line HONESTLY stating a path does not exist YET
// (a common, legitimate "deferred/planned/Wave N" prose pattern in the origin session's host
// codebase, and plausible in any codebase with a phased rollout) must not be flagged as a
// fabricated-path claim: the whole point of such a sentence is to correctly say the path is absent,
// the opposite of the false-existence claim this linter exists to catch. Origin evidence: a doc-drift
// fix's own added line — "**No K8s manifest yet**: `k8s/.../a-service.yaml` is Wave 5 (deploy gates
// the full sprint)." — a true statement about the current tree, was flagged anyway because the linter
// only checked "does this path resolve", never whether the surrounding prose asserts existence or
// absence. Deliberately line-granular (a genuine phantom-path claim on a DIFFERENT line in the same
// call still catches; only the matching line itself is skipped).
const NOT_YET_EXISTS_RE = /\bno\b[^.\n]{0,40}\byet\b|\bnot yet\b|\bdoes(?:n't| not) exist\b|\byet to (?:be|exist)\b|\bto be (?:built|created|added|implemented)\b|\bnot (?:yet )?(?:built|created|implemented)\b|\bis wave \d/i;

// Pure core (selftest-covered): missing claims from added diff lines against an entry set.
export function findMissingClaims(addedLines, entries, cap = 10) {
  const missing = [];
  const seen = new Set();
  for (const line of addedLines || []) {
    if (NOT_YET_EXISTS_RE.test(line)) continue; // the line itself says the path is honestly absent
    for (const claim of extractPathClaims(line)) {
      if (seen.has(claim)) continue;
      seen.add(claim);
      if (!claimResolves(claim, entries)) { missing.push(claim); if (missing.length >= cap) return missing; }
    }
  }
  return missing;
}

// Fold-time entrypoint: lint the ADDED lines of a worktree's DOC (.md) diff. Returns [] on any
// error — a detection aid must never block a fold.
export function lintWorktreeDocClaims(worktree, cap = 10) {
  try {
    const diff = execFileSync('git', ['-C', worktree, 'diff', 'HEAD', '--unified=0', '--', '*.md'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    // Untracked new docs are entirely "added":
    const untracked = execFileSync('git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard', '--', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const f of untracked) {
      try { added.push(...execFileSync('cat', [worktree + '/' + f], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n')); } catch { /* per-file */ }
    }
    if (!added.length) return [];
    return findMissingClaims(added, buildEntryIndex(worktree), cap);
  } catch { return []; }
}
