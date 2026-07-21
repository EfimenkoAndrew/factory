// KI-D12 (2026-07-19) — LeftoverScan deterministic candidate detector.
//
// Greps the worktree diff's ADDED lines for the "intentionally-created tech debt" lexicon
// (TODO/FIXME/HACK/XXX, NotImplementedException, "for now", "deferred", "temporary workaround",
// "follow-up", …) so a fixer punt is caught EARLY (pre-band) and CHEAP, directly enforcing
// execution-policy.md §4 ("no deferred items", "no // TODO/FIXME/HACK/XXX … 'for now' comments the
// assistant introduced") on the FIXER's own diff rather than hoping the opus PO/adversarial gates
// notice it after the whole band has run.
//
// This is the DETERMINISTIC half. It is deliberately INCLUSIVE (false positives are cheap): a haiku
// `leftover-probe` in factory.js is the second stage that classifies each candidate as a genuine punt
// vs. legit (a constraint-explaining comment, a test asserting the behaviour, a term quoted in prose,
// or a properly-ledgered divergence). The driver re-greps the raw output at fold as the backstop.
//
// Excludes the SANCTIONED deferral mechanisms so they never register as leftovers:
//   - lines carrying a `standards-evolution:` call-site tag (the ledgered-divergence convention)
//   - `.claude/rules/**` + `_bmad-output/**` paths (they DEFINE / quote the lexicon)
//   - `REPLACE_WITH_` / `CHANGE_ME` secret-template placeholders (deploy-verification.md convention,
//     which has its own dedicated startup guard)
import { execFileSync } from 'node:child_process';

// Tight, case-insensitive lexeme set. The haiku classifier is the second stage — this grep only has to
// surface candidates, so it errs inclusive without drowning the classifier in noise.
const LEXEMES = [
  /\bTODO\b/i, /\bFIXME\b/i, /\bHACK\b/i, /\bXXX\b/i,
  /NotImplementedException/, /\bnot implemented\b/i,
  /\bfor now\b/i, /\bfor the time being\b/i,
  /\bdeferred?\b/i, /\btech(nical)? debt\b/i, /\bfollow[- ]?up\b/i,
  /\btemporary (workaround|hack|fix|measure|stub)\b/i,
  /\buntil\b.{0,40}\b(ships?|lands?|is ready|is done|exists?|refactor|the real)\b/i,
  /\bcome back to\b/i, /\brevisit (this )?later\b/i, /\bplaceholder\b/i, /\bstub(bed|s)?\b/i,
];
const EXCLUDE_PATH = /(^|\/)(\.claude\/rules\/|_bmad-output\/)/;
const SECRET_TEMPLATE_MARKERS = /REPLACE_WITH_|CHANGE_ME/i;
const SANCTIONED_LINE = /standards-evolution:|REPLACE_WITH_|CHANGE_ME/i;

export function firstLexeme(line) {
  for (const re of LEXEMES) { const m = line.match(re); if (m) return (m[0] || re.source).trim(); }
  return null;
}

// A single added line -> a hit (or nothing). Exported for the selftest.
export function classifyLine(file, line) {
  if (EXCLUDE_PATH.test(file)) return null;
  if (SANCTIONED_LINE.test(line)) return null;
  const lex = firstLexeme(line);
  return lex ? { file, lexeme: lex, line: line.trim().slice(0, 200) } : null;
}

// KI-D12 refinement (2026-07-20, session 23): the `placeholder` lexeme's only live firings across
// cycles 41–45 were files that IMPLEMENT or TEST the sanctioned loud-placeholder secret convention
// (deploy-verification.md `REPLACE_WITH_`/`CHANGE_ME`) — XML-doc prose and assertion-message strings
// ABOUT the convention (9/9 candidates on ITEM-M2; same class on ITEM-H5), every one
// haiku-cleared, every one re-surfacing as fold-backstop WARN noise. Line-local context matching is
// FRAGILE here (wrapped doc-prose lines carry no context word — e.g. "This placeholder is an"), but
// the FILE-level signal is robust: a file legitimately about the convention carries the literal
// marker somewhere in its OWN added lines, while a genuine "placeholder implementation" punt does
// not. So prune `placeholder`-lexeme hits — that lexeme ONLY; a TODO/stub/for-now in the same file
// still fires — from files whose added lines contain the secret-template markers. Pure + exported
// for the selftest.
export function pruneConventionPlaceholderHits(hits, addedTextByFile) {
  return hits.filter((h) => {
    if (!/^placeholders?$/i.test(h.lexeme)) return true;
    return !SECRET_TEMPLATE_MARKERS.test((addedTextByFile && addedTextByFile[h.file]) || '');
  });
}

// Scan a worktree's diff-vs-HEAD ADDED lines + untracked new files for leftover candidates.
export function findLeftovers(worktree, cap = 25) {
  const hits = [];
  const addedTextByFile = {};
  const scan = (file, text) => {
    addedTextByFile[file] = (addedTextByFile[file] || '') + text + '\n';
    if (hits.length < cap) { const h = classifyLine(file, text); if (h) hits.push(h); }
  };
  const diff = execFileSync('git', ['-C', worktree, 'diff', 'HEAD', '--unified=0'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let cur = '?';
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { cur = l.slice(4).replace(/^b\//, ''); continue; }
    if (l.startsWith('+') && !l.startsWith('+++')) scan(cur, l.slice(1));
  }
  const untracked = execFileSync('git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of untracked) {
    try { for (const t of execFileSync('cat', [worktree + '/' + f], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n')) scan(f, t); } catch { /* per-file best-effort */ }
  }
  return pruneConventionPlaceholderHits(hits, addedTextByFile);
}
