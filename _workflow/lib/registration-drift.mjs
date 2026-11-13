// KI-E77 (2026-08-09) — RegistrationDrift: the PREVENTION companion to KI-E76's fold-time
// backstop. KI-E76 catches an undocumented shared-registration-call divergence AFTER an expensive
// gate cycle has already run against it (and, in the live incident, never actually looked at it) —
// pure mitigation, paid for at the single most expensive point in the pipeline. This module is the
// prevention half: a cheap, deterministic, git-diff-only scan (no dotnet, no LLM — same posture as
// leftover-scan.mjs/comment-scan.mjs) that runs in seconds, immediately after a remedy is written
// and BEFORE a single gate-agent token is spent reviewing it.
//
// Motivating incident: CUSTPORTAL-M1 / SHOPPORTAL-H12 (cycle 60r) each independently introduced
//   AddHostDataProtection(name, skipCertificateProtection)
// where `skipCertificateProtection` was a bare local-variable identifier assigned from a
// multi-operator expression (`IsEnvironment("Testing") || !File.Exists(...)`) — a shape that
// matches NONE of the other 5 Program.cs files' calls to the same method (all pass a single
// inline `builder.Environment.IsEnvironment("Testing")` call directly as the argument). A
// one-second grep-and-compare would have caught this before either recovery ever touched a gate
// agent; instead it was caught (once, by luck) at the far more expensive review stage, and
// (once, not at all) reached CLOSED unreviewed.
//
// Deliberately ADVISORY, never a hard block: a normalized-shape mismatch is a real signal but not
// a certain one (a legitimately overloaded shared method has more than one valid call shape) —
// mirrors leftover-scan.mjs's own "deliberately INCLUSIVE, false positives are cheap" posture.
// Judgment (is this a real divergence needing standards-evolution.md, or a benign overload) stays
// with whoever reads the hit — this module's job is only to make sure they SEE it, cheaply, early.

const CALL_RE = /\b(?:builder\.Services|services)\.(Add[A-Z]\w*)\(/g;

// Extract every `<receiver>.<Method>(...)` registration-style call from `text`, where <receiver>
// is `builder.Services` or a bare `services` identifier (the two spellings used throughout this
// repo's Program.cs / *InfrastructureRegistration.cs files) and <Method> starts with `Add` (the
// ASP.NET Core DI-registration convention). Paren-balanced across newlines so a call wrapped onto
// a second line (this repo's common style for a long argument list) is captured whole; a
// `(`/`)`/`,` inside a string literal is not counted. This is a bounded string scanner tuned to
// this repo's call-site style, not a general C# tokenizer — good enough for a cheap early lint,
// never the sole arbiter (KI-E76's fold-time check is the actual gate).
export function extractRegistrationCalls(text) {
  const out = [];
  if (!text) return out;
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(text))) {
    const method = m[1];
    const start = m.index + m[0].length; // just past the opening '('
    let depth = 1, i = start, inStr = false, strCh = '';
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === strCh) inStr = false;
      } else if (c === '"' || c === "'") { inStr = true; strCh = c; }
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    out.push({ method, args: text.slice(start, Math.max(start, i - 1)), index: m.index });
    CALL_RE.lastIndex = i;
  }
  return out;
}

// Normalize an argument-list string to a comparable SHAPE: string/char literals -> STR, numeric
// literals -> NUM, whitespace collapsed. Two calls with the same normalized shape pass identical
// argument STRUCTURE (count, named-vs-positional, operator/call nesting) even when the literal
// DATA differs (e.g. two services each passing their own applicationName string) — exactly the
// legitimate variation that must NOT be flagged.
export function normalizeShape(argsText) {
  return String(argsText || '')
    .replace(/"(?:[^"\\]|\\.)*"/g, 'STR')
    .replace(/'(?:[^'\\]|\\.)*'/g, 'STR')
    .replace(/\b\d+(\.\d+)?\b/g, 'NUM')
    .replace(/\s+/g, ' ')
    .trim();
}

// A call whose argument list is dominated by a lambda/anonymous-function body (`options => { ... }`,
// `client => { ... }`) is EXPECTED to vary per call site — that is the entire point of passing a
// configuration lambda, and comparing lambda bodies structurally produces near-total noise (an
// AddHttpClient registering 8 different named clients with 8 different BaseAddress/Timeout bodies
// is not a convention divergence, it is 8 independent, legitimate configurations). A repo-wide
// CONVENTION is only a meaningful signal for simple, non-lambda argument lists (string constants,
// booleans, a single inline method call) — exactly the shape of the incident this module exists to
// catch (`AddHostDataProtection("x", skipCertificateProtection)`, no lambda anywhere in it).
// Live-verified: excluding `=>`-bearing calls drops CUSTPORTAL-M1's hit count from 7 to 1 and
// SHOPPORTAL-H12's from 9 to 1 — in both cases the ONE surviving hit is the real incident.
const HAS_LAMBDA = /=>/;

// Pure decision: given ONE modified file's path+text and a {path: text} map of every sibling
// registration-call site repo-wide (siblings include the modified file itself; callers should
// pass the CURRENT text for it so a call added earlier in this same pass is not mistaken for an
// external sibling), find calls in the modified file whose method IS called elsewhere in the repo
// but whose normalized shape matches NONE of those other call sites. A method called only once
// repo-wide (no siblings) is never flagged — there is no established convention yet to diverge
// FROM, and single-caller shared methods are exactly where a first, legitimate shape is expected.
export function findRegistrationDrift(modifiedFile, modifiedText, siblingTexts) {
  const modifiedCalls = extractRegistrationCalls(modifiedText).filter((c) => !HAS_LAMBDA.test(c.args));
  if (!modifiedCalls.length) return [];
  const siblingCallsByMethod = {};
  for (const [path, text] of Object.entries(siblingTexts || {})) {
    if (path === modifiedFile) continue;
    for (const c of extractRegistrationCalls(text)) {
      if (HAS_LAMBDA.test(c.args)) continue;
      (siblingCallsByMethod[c.method] = siblingCallsByMethod[c.method] || []).push({ path, shape: normalizeShape(c.args) });
    }
  }
  const findings = [];
  for (const c of modifiedCalls) {
    const siblings = siblingCallsByMethod[c.method];
    if (!siblings || !siblings.length) continue; // no established convention to diverge from
    const shape = normalizeShape(c.args);
    if (siblings.some((s) => s.shape === shape)) continue; // matches at least one sibling call shape
    findings.push({
      method: c.method,
      file: modifiedFile,
      args: c.args.trim().replace(/\s+/g, ' ').slice(0, 200),
      siblingCount: siblings.length,
      siblingExample: siblings[0].path + ': ' + siblings[0].shape.slice(0, 160),
    });
  }
  return findings;
}
