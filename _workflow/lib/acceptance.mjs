// KI-E18 (2026-07-21, improvement-analysis P1) — AcceptanceScan: deterministic acceptance-clause
// splitter. Evidence (factory-improvement-analysis-2026-07-20 §1.2): the last four band FAILs were
// ALL acceptance-clause coverage gaps — a clause delivered in letter but not behaviour, a clause
// read narrowly, a clause whose surface the lock set forbade — each discovered by the opus band at
// full price. This is the deterministic half of the KI-D12 pattern applied to that failure cause:
// split the item's `acceptance` into checkable clauses here (pure, selftest-pinned); a cheap haiku
// probe in factory.js then answers "which clause has NO corresponding evidence in the diff?" BEFORE
// any opus gate runs, feeding ONE bounded fixer amend. A malformed/unavailable probe never sinks an
// item (fail-open, mirroring LeftoverScan).
//
// The splitter is deliberately simple: semicolons + sentence boundaries, with an abbreviation guard
// (e.g./i.e./etc./vs./cf. must not split) and a path/version guard (a '.' inside `x.cs`, `1.4.2`,
// `AGENTS.md` never splits because the char before the whitespace is not a sentence ender).
// Fragments under 20 chars are dropped (not checkable clauses); output is capped (the tail merges
// into the last clause) so a probe prompt stays bounded.
//
// The factory.js copy is INLINED byte-for-byte (the Workflow runtime cannot import) — change both
// copies together; the selftest pins their parity.
export function splitAcceptanceClauses(text, cap) {
  if (cap === undefined) cap = 8
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return []
  // Abbreviation guard: swap the abbreviation's ". " for ".\u0001" (a non-whitespace placeholder
  // the sentence-boundary lookbehind cannot match), restore after splitting.
  const marked = t.replace(/\b(e\.g|i\.e|etc|vs|cf)\.\s/gi, function (m) { return m.replace('. ', '.\u0001') })
  const rough = marked.split(/;\s*|(?<=[.!?])\s+(?=[A-Z0-9`"'(])/)
  const clauses = rough.map(function (c) { return c.replace(/\u0001/g, ' ').trim() }).filter(function (c) { return c.length >= 20 })
  if (clauses.length <= cap) return clauses
  return clauses.slice(0, cap - 1).concat(clauses.slice(cap - 1).join('; '))
}
