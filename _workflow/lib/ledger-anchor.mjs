// KI-E91 (2026-08-28, ported from a host-mount session) — LedgerAnchor: mechanizes
// standards-evolution.md §3.4's own documented "ripple check" (grep for the tag, confirm the
// ledger anchor exists, confirm the entry isn't self-contradictory) instead of leaving it to a
// human/reviewer's memory. Prevention companion to the existing leftover-lint.mjs/comment-lint.mjs
// pre-band probes — same posture: a cheap, deterministic, git-diff-only scan (no dotnet, no LLM)
// that finds CANDIDATES, never judges them. Judgment (is this a genuine contradiction, or a
// legitimate variant) stays with the haiku classify step that reads each candidate — this module's
// job is only to make sure it SEES them.
//
// Motivating incident (origin host-mount session, cycle 73): a doc-drift item authored the SAME
// anchor slug as a top-level entry in TWO sibling ledger files (that host's root ledger + a
// subrepo-scoped ledger) with materially different Created dates / Standard citations /
// Legacy-sites content for what is presented as the SAME divergence, and separately asserted "all
// call-site references carry the standards-evolution: tag" for five files that grep proved did NOT
// carry it. Both were caught only after a full expensive adversarial review + adjudication.
//
// This repo has a SINGLE `_bmad-output/tech-debt/STANDARDS-DIVERGENCE-LEDGER.md` (no sibling
// ledger) — the duplicate-anchor half of this module degrades to a structural no-op here
// (findDuplicateAnchors has nothing to compare a touched file against, so it always returns []),
// while the tag-claim-vs-grep half stays fully applicable regardless of ledger count. Both halves
// activate unmodified the moment a host configures a second ledger path.

// Extract every `+#{3,4} <slug>` heading ADDED by a unified diff (git diff HEAD -- <file> output).
// Level is the number of `#` characters (3 = top-level entry, 4 = per-service stub — the two are
// NEVER compared against each other; a top-level entry cross-referenced by a stub at the other
// level is the SANCTIONED pattern, not a candidate). Only `+` lines count — an unchanged or
// removed heading is not "added or edited" by this diff.
export function extractAddedAnchors(diffText) {
  const out = [];
  if (!diffText) return out;
  const HEADING_RE = /^\+(#{3,4})\s+([a-z0-9][a-z0-9-]*)\s*$/;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++')) continue; // the diff's own "+++ b/file" header, not a content line
    const m = HEADING_RE.exec(line);
    if (m) out.push({ level: m[1].length, anchor: m[2] });
  }
  return out;
}

// Locate a `#{level} <anchor>` heading (exact slug, exact level) in ledgerText and return its full
// body — from the heading line to the next `#{1,6} ` heading or EOF. Returns null when absent.
export function findAnchorBody(ledgerText, anchor, level) {
  if (!ledgerText) return null;
  const lines = ledgerText.split('\n');
  const want = '#'.repeat(level) + ' ' + anchor;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === want) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// Pure decision: given the anchors ADDED/edited in `touchedFile`'s diff and a {path: text} map of
// every ledger file (siblings include touchedFile itself), find anchors that ALSO exist at the
// SAME level in a DIFFERENT ledger — a candidate for the classify step to judge (materially
// disagreeing Created/Standard/Legacy-sites content vs. a harmless identical cross-post). With
// only ONE configured ledger path, this always returns [] — there is no sibling to compare
// against (correct degrade, not a bug — see this module's header comment).
export function findDuplicateAnchors(touchedFile, addedAnchors, ledgerTexts, ledgerPaths) {
  const out = [];
  const seen = new Set();
  for (const { anchor, level } of addedAnchors || []) {
    const key = anchor + '#' + level;
    if (seen.has(key)) continue; // a heading can appear once per diff hunk scan; de-dupe re-added lines
    for (const other of ledgerPaths || []) {
      if (other === touchedFile) continue;
      const body = findAnchorBody((ledgerTexts || {})[other], anchor, level);
      if (body != null) { out.push({ anchor, level, fileA: touchedFile, fileB: other }); seen.add(key); break; }
    }
  }
  return out;
}

// Extract file paths an entry body's prose CLAIMS carry a `standards-evolution:` call-site tag —
// heuristic, deliberately inclusive (a false-positive candidate costs one cheap classify judgment;
// a false negative silently misses the exact defect class this module exists to catch). Two
// independent triggers:
// (1) a backtick-quoted path-looking token inside a "**Legacy sites:**" bullet block (the ledger
//     format's own named field for call-site references, per standards-evolution.md §4);
// (2) a backtick-quoted path-looking token on any line whose prose asserts tag presence ("carry
//     the", "carries the", "all call-site references carry") near a `standards-evolution:` mention.
// A path token: backtick-quoted, contains a `/`, ends in a common source/doc extension, optional
// trailing `:<line>`.
const PATH_TOKEN_RE = /`([\w./-]+\/[\w.-]+\.(?:cs|md|json|ya?ml|csproj)(?::\d+)?)`/g;
const CLAIM_PHRASE_RE = /\bcarr(?:y|ies)\b/i;

export function extractTagClaims(bodyText) {
  if (!bodyText) return [];
  const claimed = new Set();
  const lines = bodyText.split('\n');
  let inLegacySites = false;
  for (const line of lines) {
    if (/\*\*Legacy sites:?\*\*/i.test(line)) { inLegacySites = true; }
    else if (/^\s*-\s*\*\*/.test(line) || /^#{1,6}\s/.test(line)) { inLegacySites = false; } // next bullet field / heading ends the block
    const inClaimLine = CLAIM_PHRASE_RE.test(line) && /standards-evolution:/.test(line);
    if (inLegacySites || inClaimLine) {
      let m;
      PATH_TOKEN_RE.lastIndex = 0;
      while ((m = PATH_TOKEN_RE.exec(line))) claimed.add(m[1].replace(/:\d+$/, ''));
    }
  }
  return [...claimed];
}

// Does `fileText` (the ACTUAL file content) contain the literal substring a real call-site tag
// uses? Pure string check — no filesystem access here (callers resolve+read the file).
export function fileHasStandardsEvolutionTag(fileText) {
  return typeof fileText === 'string' && fileText.includes('standards-evolution:');
}

// Top-level pure orchestration for ONE touched ledger file's diff: returns
// { dup: [{anchor, level, fileA, fileB}], tagClaims: [{anchor, claimedFile}] } — the tagClaims
// list still needs each claimedFile's actual text checked by the caller (filesystem access stays
// at the CLI edge, same split as registration-drift.mjs/registration-drift-lint.mjs).
export function findLedgerAnchorCandidates(touchedFile, diffText, ledgerTexts, ledgerPaths) {
  const added = extractAddedAnchors(diffText);
  const dup = findDuplicateAnchors(touchedFile, added, ledgerTexts, ledgerPaths);
  const tagClaims = [];
  for (const { anchor, level } of added) {
    const body = findAnchorBody((ledgerTexts || {})[touchedFile], anchor, level);
    for (const claimedFile of extractTagClaims(body)) tagClaims.push({ anchor, claimedFile });
  }
  return { dup, tagClaims };
}
