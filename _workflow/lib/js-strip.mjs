// KI-E360 (2026-10-27) — JS comment stripper for the Workflow launcher channel.
//
// The Workflow script channel is capped at 512KB (KI-E127). factory.js's own source (~43% comments,
// measured 168KB of 391KB) is inlined verbatim into every launcher, so even a 1-item batch with the
// 135KB briefs snapshot no longer fits. The comments are documentation living in the wrong channel —
// the runtime never needs them. This module strips them so emitLauncherScript can inline a comment-
// free source and the batch data (briefs/docMaps/peers — all runtime-essential) stays intact.
//
// The injection marker `/*__FACTORY_BATCH_INJECT__*/` is itself a block comment, so it is swapped for
// a string-literal sentinel BEFORE stripping and swapped back by the caller (see stripFactorySource).
//
// Correctness strategy (in order of strength):
//   1. node --check on the stripped source (syntax).
//   2. execSmoke PARITY: _workflow/lib/js-strip.test.mjs executes the RAW and the STRIPPED source
//      through the same deterministic stub-agent harness and requires IDENTICAL call-label sequences,
//      checkpoint payloads and terminal states — a mangled string/regex/template changes prompt bytes,
//      which changes stub-keyed dispatch, which fails the parity assertion.
//   3. The scanner below is string/template/regex-aware: `//`, `/*` and `${` inside string literals,
//      template literals and regex literals are content, never comment starts.
//
// Regex-literal detection uses the standard "previous significant token" heuristic (the same set
// eslint's no-regex-spaces uses): a `/` opens a regex after one of ()[]{},=:;!&|?+-*<>%~^ , after the
// keywords return/typeof/instanceof/in/of/new/else/do/while/for/switch/case/throw/try/finally/catch/
// void/delete/yield/await, after `=>`, or at the start of a statement/expression context. `//` and
// `/*` are ALWAYS comments first (per spec a regex cannot start with either), and `/=` is always
// division-assignment. Comments preserve their internal newlines so line numbers stay identical
// between raw and stripped source (runtime stack traces and node --check messages line up).
//
// Deliberate non-goals: minification (no whitespace/renaming — that WOULD risk semantics), and
// stripping `"use strict"`-adjacent trivia. Idempotent: stripJsComments(stripJsComments(x)) ===
// stripJsComments(x) (pinned by test).

export const FACTORY_BATCH_MARKER = '/*__FACTORY_BATCH_INJECT__*/';
export const FACTORY_BATCH_SENTINEL = "'__FACTORY_BATCH_INJECT_SENTINEL__'";

// Strip comments from factory.js for launcher inlining, preserving the batch-injection point: the
// marker (itself a block comment) becomes a string literal the stripper leaves alone; the caller
// replaces that sentinel with the injected batch (function-replacement, so `$` in the batch JSON is
// never interpreted as a String.replace pattern).
export function stripFactorySource(src) {
  return stripJsComments(String(src).replace(FACTORY_BATCH_MARKER, FACTORY_BATCH_SENTINEL));
}

const RE_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'else', 'do', 'while', 'for',
  'switch', 'case', 'throw', 'try', 'finally', 'catch', 'void', 'delete', 'yield', 'await',
]);

const isWordChar = (ch) => /[A-Za-z0-9_$]/.test(ch);

export function stripJsComments(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let mode = 'code'; // 'code' | "'" | '"' | '`'
  const stack = []; // brace contexts inside ${} interpolations: 'tpl' | 'brace'
  let prevSig = null; // last significant char emitted in code mode ('' for none)
  let prevSig2 = null; // the significant char before prevSig (for the `=>` rule)
  let lastWord = ''; // trailing identifier-ish run in code mode (keyword rule)

  const emit = (ch) => {
    out.push(ch);
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') return; // whitespace is not significant
    prevSig2 = prevSig;
    prevSig = ch;
    lastWord = isWordChar(ch) ? lastWord + ch : '';
  };

  const regexStart = () => {
    if (prevSig === null) return true;
    if (lastWord && RE_KEYWORDS.has(lastWord)) return true;
    if (prevSig === '>' && prevSig2 === '=') return true; // `=>` then regex
    if ('()[]{},=:;!&|?+-*<>%~^'.indexOf(prevSig) >= 0) return true;
    return false;
  };

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';

    if (mode === 'code') {
      if (c === "'" || c === '"' || c === '`') { emit(c); mode = c; i++; continue; }
      if (c === '/' && d === '/') { // line comment — keep the newline, drop the text
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && d === '*') { // block comment — keep internal newlines only
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') out.push('\n');
          i++;
        }
        i = Math.min(n, i + 2);
        continue;
      }
      if (c === '/' && regexStart()) { // regex literal (never `//` or `/*` — comments already handled)
        let j = i + 1;
        let charClass = false;
        let closed = false;
        while (j < n) {
          const r = src[j];
          if (r === '\\') { j += 2; continue; }
          if (r === '\n') break; // unterminated regex — emit as-is (preserve input; node --check will flag)
          if (r === '[') charClass = true;
          else if (r === ']') charClass = false;
          else if (r === '/' && !charClass) { j++; closed = true; break; }
          j++;
        }
        if (closed) {
          while (j < n && /[A-Za-z]/.test(src[j])) j++; // flags
        }
        out.push(src.slice(i, j)); // copy the whole literal verbatim (never mangle regex content)
        i = j;
        prevSig2 = prevSig;
        prevSig = 'x'; // the literal is an atom; never treat a following `/` as regex-start via these sigs
        lastWord = '';
        continue;
      }
      if (c === '}' && stack.length) {
        const top = stack[stack.length - 1];
        stack.pop();
        if (top === 'brace') { emit(c); i++; continue; }
        mode = '`'; emit(c); i++; continue; // closed the ${...} — back to template content
      }
      if (c === '{' && stack.length) stack.push('brace');
      emit(c);
      i++;
      continue;
    }

    if (mode === "'" || mode === '"') {
      emit(c);
      if (c === '\\' && i + 1 < n) { emit(src[i + 1]); i += 2; continue; }
      if (c === mode) mode = 'code';
      i++;
      continue;
    }

    // template literal content
    if (c === '\\' && i + 1 < n) { emit(c); emit(src[i + 1]); i += 2; continue; }
    if (c === '$' && d === '{') { emit(c); emit(d); stack.push('tpl'); mode = 'code'; prevSig = null; prevSig2 = null; lastWord = ''; i += 2; continue; }
    if (c === '`') { emit(c); mode = 'code'; i++; continue; }
    emit(c);
    i++;
  }
  return out.join('');
}
