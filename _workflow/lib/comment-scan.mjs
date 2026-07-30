// KI-E59 (2026-07-30, hardened in the PR#9 review wave) — CommentScan deterministic candidate detector.
//
// Scans the worktree diff's ADDED lines + untracked new files for comment syntax, per-language.
// Host policy (config `policies.noNewComments`, OFF by default — see lib/policy.mjs): when a host
// enables it, NO comment may be added or reworded by the factory's output. Because a modified
// comment's diff shows BOTH a removed `-old` line AND an added `+new` line, scanning ADDED lines
// catches both a wholly NEW comment and a REWORDED one. A byte-identical MOVED/re-indented comment
// also appears as an added line, but its trimmed text matches a REMOVED line elsewhere in the same
// diff — those are suppressed (a pure relocation is neither new nor reworded; without this, a
// file-scoped-namespace conversion hard-failed with no possible compliance).
//
// Precision rules (each killed a measured false-positive class from the PR#9 review):
//   - string literals are stripped before trailing-marker checks (`"//"`, protocol-relative URLs,
//     base64 blobs, csproj `Include="**/*.cs"` globs all live inside quotes);
//   - comment syntax is EXTENSION-AWARE: `<!-- -->` only counts in markup files (`x --> 0` in JS is
//     not a comment), `#`/`--`/`@* *@`/`(* *)` count only where they are real comment syntax;
//   - `.md`/`.txt`/`.json`(&c) are never scanned — docs are where residual-gap notes belong (KI-E58)
//     and JSON has no comments, so every hit there was noise.
// Deliberate exclusion: VB's apostrophe comment (`'`) is NOT detected — an apostrophe is too
// FP-prone (string apostrophes, prose) for a hard gate; legacy .vb additions rely on the
// prompt-level policy + the review band instead.
// Failure honesty (AP#19 — never a silent pass): git failures THROW (the CLI turns that into an
// explicit FACTORY::COMMENT-SCAN-ERROR marker + exit 2), and unreadable untracked files are counted
// on the returned array's `.skipped` property instead of being silently dropped. Untracked files are
// read with readFileSync — the previous `execFileSync('cat')` was a silent no-op on hosts without
// coreutils (Windows), exactly where new test files (always untracked — the factory never commits)
// most needed scanning.
//
// Single source of truth for the CLI (_workflow/comment-lint.mjs via `build-test.sh comments`), the
// opencode runtime's mechanical gate (direct import), and driver fold's WARN backstop.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

// Extension families. A file can be in several (e.g. .razor: slash + markup + razor).
const SLASH = new Set(['.cs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.css', '.scss', '.less', '.fs', '.fsx', '.razor', '.cshtml', '.vue', '.svelte']);
const MARKUP = new Set(['.html', '.htm', '.cshtml', '.razor', '.xml', '.xaml', '.axaml', '.csproj', '.props', '.targets', '.config', '.resx', '.svg', '.vue', '.svelte', '.nuspec', '.ruleset']);
const HASH = new Set(['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.psd1', '.yml', '.yaml', '.py', '.rb', '.toml']);
const SQLDASH = new Set(['.sql']);
const RAZOR = new Set(['.razor', '.cshtml']);
const FSHARP = new Set(['.fs', '.fsx']);
// Never scanned: prose/data formats where a "comment" is either legitimate content or impossible.
const EXCLUDED = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.lock', '.snap', '.map']);
// Extension-less meta files: hash-comment family, never slash/markup (a `**/*` glob is not `/*`).
const HASH_BASENAMES = new Set(['dockerfile', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.globalconfig']);

function familiesFor(file) {
  const ext = extname(file).toLowerCase();
  const base = basename(file).toLowerCase();
  if (EXCLUDED.has(ext)) return null;
  if (HASH_BASENAMES.has(base)) return { slash: false, markup: false, hash: true, sql: false, razor: false, fsharp: false };
  if (!ext) return null; // unknown extension-less file — not scannable with confidence
  const known = SLASH.has(ext) || MARKUP.has(ext) || HASH.has(ext) || SQLDASH.has(ext) || FSHARP.has(ext);
  // Unknown code-ish extension: fall back to the slash family only (the pre-hardening default,
  // minus the `-->`/glob false-positive surfaces that needed markup/unquoted context).
  if (!known) return { slash: true, markup: false, hash: false, sql: false, razor: false, fsharp: false };
  return { slash: SLASH.has(ext), markup: MARKUP.has(ext), hash: HASH.has(ext), sql: SQLDASH.has(ext), razor: RAZOR.has(ext), fsharp: FSHARP.has(ext) };
}

// Remove string-literal contents so markers inside strings never classify as comments. Handles
// double/single/backtick quoting with backslash escapes, C# verbatim @"..." ("" escapes), and
// JS/TS regex literals (a `/` after an operator/opener with a closing unescaped `/` later on the
// line — `/\/\//` must not read as a `//` comment, while `a / b / c` division is left alone). An
// unterminated literal swallows the rest of the line (a continued string cannot start a comment).
const REGEX_PRECEDER = new Set(['=', '(', ',', ':', '[', '!', '&', '|', '?', ';', '{', '+', '-', '*', '%', '<', '>']);
export function stripStrings(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' && s[i - 1] === '@') { // C# verbatim string: "" is an escaped quote
      i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') { i += 2; continue; }
        if (s[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === c) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && s[i + 1] !== '/' && s[i + 1] !== '*') {
      const prev = out.trimEnd().slice(-1);
      if (prev === '' || REGEX_PRECEDER.has(prev)) {
        // Candidate regex literal: only consume when a closing unescaped `/` exists on this line.
        let j = i + 1, inClass = false, closed = -1;
        while (j < s.length) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '[') inClass = true;
          else if (s[j] === ']') inClass = false;
          else if (s[j] === '/' && !inClass) { closed = j; break; }
          j++;
        }
        if (closed !== -1) { i = closed + 1; continue; }
      }
    }
    out += c;
    i++;
  }
  return out;
}

// Finds a genuine `//` marker in an already string-stripped line, walking every occurrence so an
// unquoted scheme URL earlier in the line does not mask a real comment later. A `//` immediately
// preceded by `:` is a URL scheme, not a comment.
function hasSlashSlashComment(line) {
  let idx = -1;
  while ((idx = line.indexOf('//', idx + 1)) !== -1) {
    if (line[idx - 1] !== ':') return true;
  }
  return false;
}

export function classifyCommentLine(file, line) {
  const fam = familiesFor(file);
  if (!fam) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const hit = (kind) => ({ file, kind, line: trimmed.slice(0, 200) });

  // Fast path: the line IS a comment from its first character (no stripping needed).
  if (fam.slash && trimmed.startsWith('//')) return hit('line');
  if (fam.slash && (trimmed.startsWith('/*') || trimmed.startsWith('*/'))) return hit('block');
  if (fam.markup && trimmed.startsWith('<!--')) return hit('html');
  if (fam.razor && trimmed.startsWith('@*')) return hit('razor');
  if (fam.fsharp && trimmed.startsWith('(*') && !trimmed.startsWith('(*)')) return hit('block');
  if (fam.hash && trimmed.startsWith('#') && !trimmed.startsWith('#!')) return hit('hash');
  if (fam.hash && trimmed.startsWith('<#')) return hit('block'); // PowerShell block comment
  if (fam.sql && trimmed.startsWith('--') && !trimmed.startsWith('-->')) return hit('dash');

  // Trailing markers: only meaningful OUTSIDE string literals.
  const s = stripStrings(trimmed);
  if (fam.slash && hasSlashSlashComment(s)) return hit('line');
  if (fam.slash && /\/\*|\*\//.test(s)) return hit('block');
  if (fam.markup && /<!--|-->/.test(s)) return hit('html');
  if (fam.razor && /@\*/.test(s)) return hit('razor');
  if (fam.fsharp && /\(\*(?!\))/.test(s)) return hit('block');
  if (fam.hash && /(^|\s)#(?!!)/.test(s)) return hit('hash');
  if (fam.hash && /<#|#>/.test(s)) return hit('block');
  if (fam.sql && /(^|\s)--(?!>)/.test(s)) return hit('dash');
  return null;
}

// Scan a worktree's diff-vs-HEAD ADDED lines + untracked new files for new/reworded comments.
// Returns the hits array; `hits.skipped` carries the count of unreadable untracked files (the CLI
// surfaces it as FACTORY::COMMENT-SCAN-SKIPPED so a partial scan never reads as a clean one).
// Throws when git itself fails — the caller decides how to report scan unavailability.
export function findComments(worktree, cap = 50) {
  const hits = [];
  let skipped = 0;
  const diff = execFileSync('git', ['-C', worktree, 'diff', 'HEAD', '--unified=0'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // Removed-line multiset (trimmed): an added comment line whose exact trimmed text was also
  // REMOVED somewhere in this diff is a pure move/re-indent, not a new or reworded comment.
  const removed = new Map();
  const added = [];
  let cur = '?';
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { cur = l.slice(4).replace(/^b\//, ''); continue; }
    if (l.startsWith('---')) continue;
    if (l.startsWith('-')) { const t = l.slice(1).trim(); if (t) removed.set(t, (removed.get(t) || 0) + 1); continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) added.push([cur, l.slice(1)]);
  }
  const scan = (file, text) => {
    if (hits.length >= cap) return;
    const h = classifyCommentLine(file, text);
    if (!h) return;
    const key = text.trim();
    const n = removed.get(key);
    if (n) { removed.set(key, n - 1); return; } // relocated byte-identical line — not a hit
    hits.push(h);
  };
  for (const [file, text] of added) scan(file, text);
  const untracked = execFileSync('git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of untracked) {
    try {
      for (const t of readFileSync(join(worktree, f), 'utf8').split('\n')) scan(f, t);
    } catch { skipped++; }
  }
  hits.skipped = skipped;
  return hits;
}
