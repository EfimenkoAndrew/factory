// KI-E238 (2026-09-24) — VacuousTestScan: catches a [Fact]/[Theory]/[SkippableFact] test method
// whose only reachable path to a real assertion is gated behind a conditional early `return;` (or
// that never asserts at all) -- so the test passes unconditionally whether or not the code under
// test actually works. Same posture as registration-drift.mjs (KI-E77): cheap, deterministic, no
// dotnet, no LLM, advisory.
//
// Motivating incident: a prior item -- 4 test methods silently no-op'd (reached their own end via an
// early `return;` on an "unlocatable path" guard) BEFORE the real assertions ran, producing a false
// green in the real CI job that actually hits the guard. This scan's early-return
// check catches exactly that shape. a sibling incident (a test scanning the WRONG
// interface, so the value it asserted on was structurally always empty) is a SEMANTIC error a text
// scanner cannot detect -- explicitly out of scope here, left to gate/review agents.
//
// [SkippableFact] + Skip.If(...) is the SANCTIONED idiom for an environment-dependent skip (see
// AuthService.Tests/StandardsDivergenceLedgerAuthAotEntryTests.cs) and is never flagged: a body
// containing Skip.If(...) anywhere is exempt from BOTH checks below, regardless of shape.
//
// Deliberately ADVISORY, never a hard block: an early return could legitimately be a same-depth
// guard clause the fixture never actually exercises the "true" arm of (see the (d) exemption in the
// test file), or a hand-rolled data-driven loop shape this scanner does not model. Mirrors
// leftover-scan.mjs's own "deliberately INCLUSIVE, false positives are cheap" posture -- judgment
// (is this a real vacuous test, or a legitimate early-exit) stays with whoever reads the hit.

const ATTR_RE = /\[(Fact|Theory|SkippableFact)\b[^\]]*\]/g;
const ATTR_LINE_RE = /\s*\[[^\]]*\]/y;
const SIG_RE = /\s*(?:public|internal|private|protected)?\s*(?:static\s+)?(?:async\s+)?(?:void|Task(?:<[^>{}]*>)?|ValueTask(?:<[^>{}]*>)?)\s+(\w+)\s*\([^{}]*\)\s*\{/y;
// KI-E432: extended to include Moq .Verify() as a real assertion — tests that only use
// .Verify(Times.Once/Never/...) were incorrectly flagged as vacuous (false positives on
// TASK-A, TASK-B, TASK-C, TASK-D).
const ASSERT_RE = /\bAssert\.\w+\s*\(|\.Should\w*\s*\(|\.Verify\s*\(/g;
const RETURN_RE = /\breturn\s*;/g;
const SKIP_IF_RE = /\bSkip\.If\s*\(/;

// Find the method body `{ ... }` immediately following an attribute match at `attrEnd`, skipping
// any further `[...]` attribute lines (e.g. `[InlineData(...)]` stacked above a `[Theory]`) and the
// method signature itself. Returns { name, bodyStart, bodyEnd } (bodyEnd points just past the '{',
// bodyEnd at the matching '}') or null if no method body is found immediately after the attribute
// (the attribute belongs to something else -- a field, a class -- which this scanner ignores).
function findMethodAfterAttribute(text, attrEnd) {
  let i = attrEnd;
  while (true) {
    ATTR_LINE_RE.lastIndex = i;
    const m = ATTR_LINE_RE.exec(text);
    if (m && m.index === i) { i = ATTR_LINE_RE.lastIndex; continue; }
    break;
  }
  SIG_RE.lastIndex = i;
  const m = SIG_RE.exec(text);
  if (!m || m.index !== i) return null;
  const name = m[1];
  const bodyStart = SIG_RE.lastIndex; // just past the opening '{'
  let depth = 1, j = bodyStart, inStr = false, strCh = '', inLineComment = false, inBlockComment = false;
  while (j < text.length && depth > 0) {
    const c = text[j], c2 = text[j + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; j++; continue; }
    if (inBlockComment) { if (c === '*' && c2 === '/') { inBlockComment = false; j += 2; continue; } j++; continue; }
    if (inStr) {
      if (c === '\\') { j += 2; continue; }
      if (c === strCh) inStr = false;
      j++; continue;
    }
    if (c === '/' && c2 === '/') { inLineComment = true; j += 2; continue; }
    if (c === '/' && c2 === '*') { inBlockComment = true; j += 2; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; j++; continue; }
    if (c === '{') { depth++; j++; continue; }
    if (c === '}') { depth--; j++; continue; }
    j++;
  }
  return { name, bodyStart, bodyEnd: j - 1 };
}

// Within a method body, compute the brace-depth (relative to the body's OWN outer scope -- 0 means
// "not nested in any additional if/while/for/foreach/using/try block") at every position, so a
// `return;` found via a plain regex scan can be classified as unconditional (depth 0 -- the normal
// final-statement shape) or conditional (depth >= 1 -- gated behind a branch). String and comment
// content is excluded from both the depth count and the return/assert scan so a brace or the literal
// text "return;"/"Assert." inside a string or comment is never mistaken for real code.
function analyzeBody(body) {
  const depthAt = new Array(body.length);
  const isCode = new Array(body.length).fill(true);
  let depth = 0, inStr = false, strCh = '', inLineComment = false, inBlockComment = false;
  for (let i = 0; i < body.length; i++) {
    depthAt[i] = depth;
    const c = body[i], c2 = body[i + 1];
    if (inLineComment) { isCode[i] = false; if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) {
      isCode[i] = false;
      if (c === '*' && c2 === '/') { isCode[i + 1] = false; inBlockComment = false; i++; }
      continue;
    }
    if (inStr) {
      isCode[i] = false;
      if (c === '\\') { i++; if (i < body.length) isCode[i] = false; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '/' && c2 === '/') { inLineComment = true; isCode[i] = false; i++; continue; }
    if (c === '/' && c2 === '*') { inBlockComment = true; isCode[i] = false; i++; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  const conditionalReturns = [];
  let m;
  RETURN_RE.lastIndex = 0;
  while ((m = RETURN_RE.exec(body))) {
    if (isCode[m.index] && depthAt[m.index] > 0) conditionalReturns.push(m.index);
  }
  let lastAssertIndex = -1;
  ASSERT_RE.lastIndex = 0;
  while ((m = ASSERT_RE.exec(body))) {
    if (isCode[m.index]) lastAssertIndex = m.index;
  }
  return { conditionalReturns, lastAssertIndex, hasAnyAssert: lastAssertIndex >= 0 };
}

// Pure decision: scan one C# test file's full text and return every [Fact]/[Theory]/[SkippableFact]
// method that either (a) never reaches an Assert./.Should( call anywhere in its body, or (b) has a
// conditional `return;` positioned before its own LAST assertion -- so some execution path skips the
// real check entirely. `[SkippableFact]` methods that call `Skip.If(...)` anywhere in the body are
// exempt from both checks (the sanctioned environment-dependent-skip idiom).
export function scanVacuousTests(fileText) {
  const findings = [];
  if (!fileText) return findings;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(fileText))) {
    const kind = m[1];
    const method = findMethodAfterAttribute(fileText, ATTR_RE.lastIndex);
    if (!method) continue;
    const body = fileText.slice(method.bodyStart, method.bodyEnd);
    if (SKIP_IF_RE.test(body)) continue; // sanctioned idiom -- never flagged
    const { conditionalReturns, lastAssertIndex, hasAnyAssert } = analyzeBody(body);
    if (!hasAnyAssert) {
      findings.push({
        method: method.name,
        kind,
        reason: 'no Assert./`.Should(` call found anywhere in the method body -- the test can never fail',
      });
      continue;
    }
    if (conditionalReturns.some((idx) => idx < lastAssertIndex)) {
      findings.push({
        method: method.name,
        kind,
        reason: "a conditional `return;` (inside if/while/for/foreach/using/try) precedes the method's own last assertion -- that path silently skips the real check",
      });
    }
  }
  return findings;
}
