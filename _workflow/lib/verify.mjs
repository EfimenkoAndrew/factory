// Deterministic fold-time verification (KI-D3 / KI-D1). The factory's in-Workflow verdict comes from an
// LLM runner that can over-report "pass" (the pilot witness). These PURE functions let the driver (Node)
// re-derive the build/test verdict from the machine markers build-test.sh emits — the AUTHORITATIVE check
// at fold, overriding a false-pass before it is recorded CLOSED. When no machine evidence exists (the raw
// transcript is absent), the caller FALLS BACK to the agent verdict (owner direction: deterministic, with
// an agent fallback). All functions here are pure + unit-tested in lib/_selftest.mjs.

// Return the LAST match of a regex in text (or null). The runner may RETRY a build/filter/suite with a
// corrected project path, so each marker can appear multiple times — the authoritative result is the FINAL
// attempt, never the first (cycle-8 live bug: a wrong-path FILTER exit=1 preceded the correct exit=0, and
// matching the first false-flagged a passing test). All markers below take the last occurrence.
function lastMatch(text, source) {
  const g = new RegExp(source, 'g');
  let m, last = null;
  while ((m = g.exec(text)) !== null) last = m;
  return last;
}

// Parse the FACTORY::...::RESULT markers + the dotnet "Passed!/Failed!" summary from a captured
// build-test.sh transcript. hasData=false => nothing parseable (caller trusts the agent verdict).
export function parseVerifyRaw(text) {
  const out = { hasData: false, build: null, suite: null, targetedFail: false, suiteExit: null };
  if (!text || typeof text !== 'string') return out;
  const bm = lastMatch(text, 'FACTORY::BUILD::RESULT\\s+exit=(-?\\d+)\\s+errors=(\\d+)');
  if (bm) { out.hasData = true; out.build = { exit: parseInt(bm[1], 10), errors: parseInt(bm[2], 10) }; }
  const fm = lastMatch(text, 'FACTORY::TEST::FILTER::RESULT\\s+exit=(-?\\d+)');
  if (fm) { out.hasData = true; out.targetedFail = parseInt(fm[1], 10) !== 0; }
  // dotnet: "Failed!  - Failed: 2, Passed: 10, Skipped: 1, Total: 13" / "Passed!  - Failed: 0, Passed: 13, ..."
  const sm = lastMatch(text, '(?:Passed!|Failed!)[^\\n]*?Failed:\\s*(\\d+),\\s*Passed:\\s*(\\d+)(?:,\\s*Skipped:\\s*(\\d+))?');
  if (sm) { out.hasData = true; out.suite = { failed: +sm[1], passed: +sm[2], skipped: sm[3] ? +sm[3] : 0 }; }
  const srm = lastMatch(text, 'FACTORY::TEST::SUITE::RESULT\\s+exit=(-?\\d+)');
  if (srm) { out.hasData = true; out.suiteExit = parseInt(srm[1], 10); }
  return out;
}

// Decide PASS/FAIL from a deterministic parse + the agent-reported baseline failure count. A parse with
// no machine evidence => pass:true reason 'no-machine-evidence' (the caller then trusts the agent verdict).
export function verdictFromParse(p, baselineFailures) {
  if (!p || !p.hasData) return { pass: true, reason: 'no-machine-evidence' };
  if (p.build && (p.build.exit !== 0 || p.build.errors > 0)) return { pass: false, reason: 'build failed (exit=' + p.build.exit + ', errors=' + p.build.errors + ')' };
  if (p.targetedFail) return { pass: false, reason: 'targeted regression test did not pass' };
  const base = baselineFailures || 0;
  if (p.suite && p.suite.failed - base > 0) return { pass: false, reason: (p.suite.failed - base) + ' new suite failure(s) beyond baseline ' + base };
  if (typeof p.suiteExit === 'number' && p.suiteExit !== 0 && !p.suite) return { pass: false, reason: 'suite exited non-zero (exit=' + p.suiteExit + ')' };
  return { pass: true, reason: 'machine evidence: build clean, tests green' };
}

// P1 — the RED proof marker. The test-author tees the PRE-FIX run; `FACTORY::RED::<exit>` with a NON-ZERO
// exit proves the regression test genuinely fails on old code (non-vacuous). hasData=false => no red
// transcript at all (the driver FAILs a code item that produced none — a vacuous test is the silent way a
// bad fix sails through). Pure + unit-tested.
export function parseRedRaw(text) {
  const out = { hasData: false, exit: null, red: false };
  if (!text || typeof text !== 'string') return out;
  const m = lastMatch(text, 'FACTORY::RED::(-?\\d+)');
  if (m) { out.hasData = true; out.exit = parseInt(m[1], 10); out.red = out.exit !== 0; }
  return out;
}

// P2 — the real-infra container marker. `FACTORY::REALINFRA::<kind>` proves a real Postgres/Redis container
// actually started and the targeted test bound to it; an EF in-memory green never emits this. A self-reported
// realInfraExercised=true without this marker does NOT close a money/security/concurrency/idempotency item.
export function hasRealInfraMarker(text) {
  return typeof text === 'string' && /FACTORY::REALINFRA::\S+/.test(text);
}

// P9 — did the fix touch a real (non-test) file? A fixer that greens only the test never closes the bug.
// The failure mode we deterministically catch is EXACTLY "the diff changed ONLY tests" (the line of intent):
// so the fix must change at least one NON-TEST file — of ANY kind, source (.cs) OR config. A `.yaml` / `.sh`
// / `.env` deploy manifest is the LEGITIMATE root-cause target of a `deployability-oncall`/config finding,
// which has no .cs to touch (KI-L24 — the earlier "non-test .cs only" rule false-failed ITEM-C2, a
// correct-and-gate-APPROVED k8s-secret fix, and would false-fail the whole config-fix class). `rootCauseFiles`
// (the item's predicted non-test .cs touch-set) only gates WHETHER to assert at all: an empty set = a pure
// config/doc item with nothing to require here. Matching is by "is this a non-test file", not by exact path —
// the audit files[] are repo-relative while the diff is worktree-relative, and a good fix may legitimately
// touch an adjacent file the audit did not predict. Debris is filtered by the caller (driver P9 runs AFTER
// the debris gate), so `changed` here is real work, not junk.
export function touchedRootCause(changed, rootCauseFiles) {
  if (!Array.isArray(rootCauseFiles) || !rootCauseFiles.length) return true; // not a source-file fix (config/doc) -> nothing to assert
  const isTest = (f) => /[^/]*Tests?\.cs$/i.test(f) || /(^|\/)[^/]*\.Tests?(\/|$)/i.test(f);
  return (changed || []).some((f) => !isTest(f)); // any non-test file (source OR config) proves the diff isn't test-only
}

// Debris (KI-D1): a changed worktree file that is an OBVIOUS factory artifact or scratch file. Deterministic
// via `git status --porcelain` output.
//
// CONSERVATIVE by design (flow-review false-positives, ITEM-H9 2026-06-27): the earlier "anything outside
// files[]" rule failed legitimate fixes for two reasons — (1) it matched files[] by FULL PATH while the audit
// often gives BASENAMES (the fix files looked foreign), and (2) it treated any legit tracked edit the audit
// did not predict (e.g. an `InternalsVisibleTo` .csproj line added for testability) as debris. A real
// source/.csproj/doc edit is reviewed by the 9 gates — the deterministic backstop here only catches mechanical
// junk that no gate would ever bless: a teed factory artifact misplaced into the worktree (verify.json,
// *-raw.txt) or a scratch/temp file. files[] (by basename OR path) and test files are never debris.
export function debrisFiles(changed, expectedFiles) {
  const norm = (f) => (f || '').replace(/^\.?\//, '').trim();
  const base = (f) => norm(f).split('/').pop();
  const expectedPaths = new Set((expectedFiles || []).map(norm));
  const expectedBases = new Set((expectedFiles || []).map(base));
  const isTest = (f) => /[^/]*Tests?\.cs$/i.test(f) || /(^|\/)[^/]*\.Tests?(\/|$)/i.test(f);
  const isArtifactOrScratch = (f) => {
    const n = norm(f), b = base(f);
    if (!n.includes('/')) { // a worktree-ROOT file is never source — a misplaced factory artifact
      if (/\.json$/i.test(b) || /-raw\.txt$/i.test(b)) return true;
      if (/^(verify|test|fix|plan|refute|reaudit|integrate|adjudication|decision|last-failure)\b.*\.(md|txt|json)$/i.test(b)) return true;
    }
    if (/(^|\/)(scratch|sandbox|tmp|temp)\//i.test(n)) return true;          // a scratch/temp directory
    if (/^(temp|tmp|scratch|sandbox|mock|diagnostic|debug|deleteme|delete[_-]me|junk)/i.test(b)) return true; // scratch-named file
    if (/\.(bak|orig|tmp|swp|rej)$/i.test(b)) return true;                   // editor/merge cruft
    return false;
  };
  return (changed || []).map(norm).filter((f) => f
    && !expectedPaths.has(f) && !expectedBases.has(base(f)) && !isTest(f)
    && isArtifactOrScratch(f));
}
