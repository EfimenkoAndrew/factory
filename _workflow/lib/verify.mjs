// Deterministic fold-time verification (KI-D3 / KI-D1). The factory's in-Workflow verdict comes from an
// LLM runner that can over-report "pass" (the pilot witness). These PURE functions let the driver (Node)
// re-derive the build/test verdict from the machine markers build-test.sh emits — the AUTHORITATIVE check
// at fold, overriding a false-pass before it is recorded CLOSED. When no machine evidence exists (the raw
// transcript is absent), the caller FALLS BACK to the agent verdict (owner direction: deterministic, with
// an agent fallback). All functions here are pure + unit-tested in lib/_selftest.mjs.
import { compareSuiteBaseline, suiteInvocations } from './baseline.mjs';

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
  const out = { hasData: false, build: null, suite: null, targetedFail: false, targetedFailClass: null, suiteExit: null };
  // (ported from a host-mount session, 2026-09-20 reconcile): verdictFromParse's target/test-identity
  // comparison (suiteInvocations/compareSuiteBaseline, baseline.mjs) needs the RAW transcript text, not
  // just the summary counts this function extracts — a non-enumerable property so it rides along on
  // every parse result without showing up in a casual console.log/JSON.stringify of the parsed shape.
  Object.defineProperty(out, 'rawTranscript', { value: text });
  if (!text || typeof text !== 'string') return out;
  const bm = lastMatch(text, 'FACTORY::BUILD::RESULT\\s+exit=(-?\\d+)\\s+errors=(\\d+)');
  if (bm) { out.hasData = true; out.build = { exit: parseInt(bm[1], 10), errors: parseInt(bm[2], 10) }; }
  // KI-E70 — FILTER::START names the test CLASS this invocation targets (build-test.sh:
  // `FACTORY::TEST::FILTER::START $target :: $filter`). A runner legitimately running SEVERAL
  // different classes in one verify pass (not always a same-class retry — ITEM-H1 live, 2026-08-07:
  // 5 distinct classes filtered in sequence, the last one failing on an unrelated Testcontainers
  // connection error) emits one START+RESULT pair per class, strictly in order. Pairing the LAST
  // RESULT with the LAST START (by count, not by trusting a single "the" targeted test) lets the
  // override name the SPECIFIC class that failed instead of a misleading singular "the targeted
  // regression test".
  const classNames = [...text.matchAll(/FACTORY::TEST::FILTER::START\s+\S+\s*::\s*([^\r\n]+)/g)].map((m) => m[1].trim());
  const fm = lastMatch(text, 'FACTORY::TEST::FILTER::RESULT\\s+exit=(-?\\d+)');
  if (fm) {
    out.hasData = true; out.targetedFail = parseInt(fm[1], 10) !== 0;
    if (out.targetedFail && classNames.length) out.targetedFailClass = classNames[classNames.length - 1];
  }
  // dotnet: "Failed!  - Failed: 2, Passed: 10, Skipped: 1, Total: 13" / "Passed!  - Failed: 0, Passed: 13, ..."
  const sm = lastMatch(text, '(?:Passed!|Failed!)[^\\n]*?Failed:\\s*(\\d+),\\s*Passed:\\s*(\\d+)(?:,\\s*Skipped:\\s*(\\d+))?');
  if (sm) { out.hasData = true; out.suite = { failed: +sm[1], passed: +sm[2], skipped: sm[3] ? +sm[3] : 0 }; }
  const srm = lastMatch(text, 'FACTORY::TEST::SUITE::RESULT\\s+exit=(-?\\d+)');
  if (srm) { out.hasData = true; out.suiteExit = parseInt(srm[1], 10); }
  // KI-E19 (improvement-analysis P5) — evidence-manifest markers. build-test.sh now trails every
  // subcommand with a KEYED `FACTORY::SUMMARY::<sub> ...` line; when present these OVERRIDE the
  // heuristic parses above. The load-bearing case: the ambient dotnet "Passed!/Failed!" summary
  // line is TYPE-AGNOSTIC — a `filter` run appended AFTER `suite` in the same transcript leaves
  // the LAST dotnet line describing the 1-test filter, silently shadowing the suite's real counts
  // (the near-miss on a live recovery transcript that motivated this). The suite's own keyed
  // marker carries its counts, so append order can no longer misattribute them. Legacy
  // transcripts (no SUMMARY lines) parse exactly as before.
  const kb = lastMatch(text, 'FACTORY::SUMMARY::build\\s+exit=(-?\\d+)\\s+errors=(\\d+)');
  if (kb) { out.hasData = true; out.build = { exit: parseInt(kb[1], 10), errors: parseInt(kb[2], 10) }; }
  const kf = lastMatch(text, 'FACTORY::SUMMARY::filter\\s+exit=(-?\\d+)');
  if (kf) { out.hasData = true; out.targetedFail = parseInt(kf[1], 10) !== 0; }
  // KI-E477 — an OPTIONAL trailing `dockerfail=N` on the SAME keyed suite marker: the machine-authoritative
  // count of THIS run's own Docker/Testcontainers-unavailable failures, computed by build-test.sh from the
  // FULL untruncated output before the display-only grep trims it. Absent on any transcript produced by a
  // build-test.sh/build-test.local.sh that predates KI-E477 — out.suite.dockerFail stays undefined, and the
  // caller falls back to dockerEnvironmentalFailureCount's text-scraping heuristic on the transcript itself.
  const ks = lastMatch(text, 'FACTORY::SUMMARY::suite\\s+exit=(-?\\d+)\\s+failed=(-?\\d+)\\s+passed=(-?\\d+)(?:\\s+skipped=(-?\\d+))?(?:\\s+dockerfail=(-?\\d+))?');
  if (ks) {
    out.hasData = true; out.suiteExit = parseInt(ks[1], 10);
    if (parseInt(ks[2], 10) >= 0) {
      out.suite = { failed: parseInt(ks[2], 10), passed: Math.max(0, parseInt(ks[3], 10)), skipped: ks[4] ? Math.max(0, parseInt(ks[4], 10)) : 0 };
      if (ks[5] !== undefined && parseInt(ks[5], 10) >= 0) out.suite.dockerFail = parseInt(ks[5], 10);
    }
  }
  return out;
}

// KI-E108 (2026-09-02) — FLAKE SUSPICION. Nothing in the factory distinguished a genuinely-failing
// test from an intermittently-failing one, and the cost of that confusion is a whole band: a flaky
// failure re-bands the item (up to maxItemRetries), while a flaky PASS is worse — KI-E65 records an
// item folded CLOSED while carrying a newly-introduced flaky test, caught only because the operator
// cross-checked the note against the ledger by hand.
//
// The one flake signal that is DETERMINISTIC and free: the SAME test class appearing with BOTH a
// passing and a failing filter result in the same transcript. `build-test.sh` emits one
// `FILTER::START <target> :: <class>` + `FILTER::RESULT exit=<n>` pair per invocation, strictly in
// order (the 1:1 pairing KI-E70 already relies on), so a class carrying two different outcomes has
// demonstrably behaved non-deterministically on this host, in this run.
//
// Deliberately ADVISORY, and this bound is the design: a fail-then-pass sequence is ALSO the
// legitimate cycle-8 retry shape (fix, re-run, green), which `lastMatch` intentionally resolves as
// "the last one wins". This must never change that verdict — it only NAMES the class so a human
// reading the fold output can tell "retried after a fix" from "this test is unstable". Promoting it
// to a blocking signal would fail the very retry shape the engine explicitly supports.
export function flakeSuspects(text) {
  if (!text || typeof text !== 'string') return [];
  const starts = [...text.matchAll(/FACTORY::TEST::FILTER::START\s+\S+\s*::\s*([^\r\n]+)/g)];
  const results = [...text.matchAll(/FACTORY::TEST::FILTER::RESULT\s+exit=(-?\d+)/g)];
  const n = Math.min(starts.length, results.length);
  const outcomes = new Map(); // class -> Set of 'pass' | 'fail'
  for (let i = 0; i < n; i++) {
    const cls = starts[i][1].trim();
    const ok = parseInt(results[i][1], 10) === 0;
    if (!outcomes.has(cls)) outcomes.set(cls, new Set());
    outcomes.get(cls).add(ok ? 'pass' : 'fail');
  }
  const out = [];
  for (const [cls, seen] of outcomes) if (seen.size > 1) out.push(cls);
  return out.sort();
}

// Decide PASS/FAIL from machine output and target/test baseline identities. A parse with no machine
// evidence => pass:true reason 'no-machine-evidence' (the caller then trusts the agent verdict).
//
// (ported from a host-mount session, 2026-09-20 reconcile): SUPERSEDES the prior flat-count model
// (`baselineFailures` as a bare number, `opts.dockerDown`/`opts.envFailureCount` — KI-E477's
// Docker/Testcontainers-environmental exclusion). That model could only ever compare COUNTS, which
// cannot distinguish "the same pre-existing failure recurred" from "a different test newly broke" when
// both leave the total unchanged, and needed a separate, narrower live-Docker-probe carve-out for the
// specific case of an environment flipping mid-band. `captureBaseline` (baseline.mjs) now captures the
// pre-fix run's failing test IDENTITIES per target, not just a count, and this function's `baseline`
// parameter is that captured object (or, from a caller with no captured baseline, `undefined`/absent) —
// `compareSuiteBaseline` requires the CURRENT failing set to be an exact subset of the captured one, so
// an environmental flap that produces a genuinely NEW failure identity is caught precisely, and a
// re-occurrence of an already-captured failure never needs a separate live-Docker carve-out to explain
// away. `options` (e.g. `{worktree}`) is forwarded to `compareSuiteBaseline` unchanged.
export function verdictFromParse(p, baseline, options = {}) {
  if (!p || !p.hasData) return { pass: true, reason: 'no-machine-evidence' };
  if (p.build && (p.build.exit !== 0 || p.build.errors > 0)) return { pass: false, reason: 'build failed (exit=' + p.build.exit + ', errors=' + p.build.errors + ')' };
  if (p.targetedFail) return { pass: false, reason: p.targetedFailClass ? ('targeted regression test did not pass (' + p.targetedFailClass + ')') : 'targeted regression test did not pass' };
  const runs = suiteInvocations(p.rawTranscript);
  for (const run of runs) {
    const completions = [...run.text.matchAll(/^FACTORY::SUMMARY::suite exit=(-?\d+) failed=(\d+) passed=(\d+)[^\r\n]*\r?$/gm)];
    if (completions.length !== 1) return { pass: false, reason: 'suite completion missing or duplicated' };
    const [, code, failed, passed] = completions[0];
    if (+failed + +passed <= 0 || +code !== (+failed ? 1 : 0)) return { pass: false, reason: 'suite completion inconsistent or vacuous' };
    const comparison = compareSuiteBaseline(run.text, run.target, +failed, baseline, options);
    if (!comparison.pass) return comparison;
  }
  if (!runs.length && p.suite?.failed > 0) return { pass: false, reason: 'suite failures lack target/test baseline evidence; legacy count allowance refused' };
  if (typeof p.suiteExit === 'number' && p.suiteExit !== 0 && !p.suite) return { pass: false, reason: 'suite exited non-zero (exit=' + p.suiteExit + ')' };
  return { pass: true, reason: 'machine evidence: build clean, tests green' };
}

// KI-E477 — counts how many of a transcript's per-test failure blocks are individually, textually
// attributable to a Docker/Testcontainers-unavailable exception (Docker vanishing mid-band produces a
// wall of Postgres/Redis-Testcontainers failures no count-based baseline could explain; live-caught
// 2026-08-23, a prior item's cycle 69).
//
// STILL LOAD-BEARING (2026-09-20 reconcile): this function no longer feeds `verdictFromParse`'s
// pass/fail decision directly — `captureBaseline`/`compareSuiteBaseline`'s target/test-identity system
// (see verdictFromParse above) supersedes that specific role, since a genuinely NEW Docker-flap failure
// identity is now caught precisely and a recurrence of an already-captured one needs no separate
// carve-out. But `_workflow/docker-envfail-count.mjs` — invoked directly by `verify/build-test.sh`
// (`suite` subcommand) against the FULL, untruncated `dotnet test` output, BEFORE the display-only
// `grep | tail` trims it to disk — imports this SAME function to compute the `dockerfail=<N>` value
// baked into the keyed `FACTORY::SUMMARY::suite ... dockerfail=N` marker every transcript now carries
// (parsed back by parseVerifyRaw above into `out.suite.dockerFail`). Removing this export would break
// that CLI at import time (`does not provide an export named 'dockerEnvironmentalFailureCount'`) and
// silently stop the marker from ever being computed — keep it exported even though no in-repo caller
// reads its return value as a pass/fail input anymore.
export function dockerEnvironmentalFailureCount(text) {
  if (!text || typeof text !== 'string') return 0;
  const lines = text.split(/\r?\n/);
  const sig = /Docker endpoint unreachable|Failed to connect to Docker endpoint|DockerUnavailableException|POSTGRES-SKIP/i;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/Error Message:/.test(lines[i]) && sig.test(lines.slice(i, i + 6).join('\n'))) count++;
  }
  return count;
}

// KI-E43 — integrate/verify baseline parity. `r.baselineFailures` is the RUN-reported environmental
// baseline (RED-stage capture preferred, verify-stage fallback); `baseline-raw.txt` is the DISK
// transcript of the pre-fix full-suite run (build-test.sh suite teed at RED time — auditable, and it
// survives a killed run). The effective baseline is the LARGER of the two counts: a runner that
// under-reported (the cycle-47 ITEM-H15 false regression — the LIGHT-band verify skips the full
// suite, so baselineFailures folded empty while integrate's full suite saw 6 pre-existing
// Docker-unavailable Testcontainers failures) is corrected by its own transcript; a transcript-less
// run keeps the reported array exactly as before. This is NOT a general weakening of the override:
// the count still only OFFSETS pre-existing failures — any failure beyond it stays a regression.
export function effectiveBaseline(baselineArr, baselineParse) {
  const reported = (Array.isArray(baselineArr) && baselineArr.length) || 0
  const fromDisk = (baselineParse && baselineParse.suite && typeof baselineParse.suite.failed === 'number' && baselineParse.suite.failed > 0) ? baselineParse.suite.failed : 0
  return Math.max(reported, fromDisk)
}

// KI-E490 (2026-09-12, a live incident) — is an effective baseline of 0 a REAL measurement or a
// PHANTOM default? `effectiveBaseline`'s Math.max(0, 0) cannot tell the two apart: a baseline run that
// genuinely found zero pre-existing failures and a baseline that was simply NEVER captured or reported
// both read as the same "0". A phantom 0 is exactly what let a deterministic override deterministically
// FAIL an item three times on failures independently reproduced on a completely clean checkout with zero
// relation to the item's own diff — the override's own message presented "beyond baseline 0" with the
// same unqualified confidence whether the 0 was measured or defaulted. KI-E489 closes the upstream gap
// (a reFix round now captures a baseline when none exists); this is the downstream, defense-in-depth
// half for when that prompt instruction doesn't take on some item shape.
export function isPhantomBaseline(baseline, baselineArr, baselineParse) {
  return baseline === 0 && !(Array.isArray(baselineArr) && baselineArr.length) && !baselineParse;
}

// Appends the KI-E490 caveat to a verdictFromParse `reason` string ONLY when it names an actual
// "beyond baseline 0" comparison AND that 0 is phantom (per isPhantomBaseline) — a real, unrelated
// failure reason (build failed, targeted test didn't pass, a genuinely non-zero baseline) is returned
// byte-identical, never touched.
export function annotateBaselineReason(reason, isPhantom) {
  return (isPhantom && /beyond baseline 0\b/.test(String(reason || '')))
    ? reason + ' (⚠ KI-E490: baseline=0 here is a DEFAULT, not a measurement — no baseline-raw.txt exists and no baselineFailures were ever reported for this item; if these failures are genuinely pre-existing, capturing a real baseline resolves this, not the diff)'
    : reason;
}

// P1 — the RED proof marker. The test-author tees the PRE-FIX run; `FACTORY::RED::<exit>` with a NON-ZERO
// exit proves the regression test genuinely fails on old code (non-vacuous). hasData=false => no red
// transcript at all (the driver FAILs a code item that produced none — a vacuous test is the silent way a
// bad fix sails through). Pure + unit-tested.
// KI-E482 — prefer the KEYED `FACTORY::SUMMARY::red exit=N` line over a bare `FACTORY::RED::N`.
// Only build-test.sh emits the keyed form; the bare marker is plain text an agent can type, and
// `lastMatch` makes the LAST occurrence win. So an agent appending a narrative after the transcript
// ("...DETAILED FAILURE: ... FACTORY::RED::0") silently INVERTED a genuine red into "vacuous test",
// failing the item and poisoning its re-fix feedback with the opposite of the truth. Live: a prior
// item (cycle 82), whose underlying test was an exemplary double-counting repro. This is precisely the
// shadowing KI-E19's keyed build/suite markers already exist to prevent — the red path just never
// used its own. Bare-marker parsing is retained as the fallback so a transcript from a build-test.sh
// predating the keyed line still parses exactly as before.
export function parseRedRaw(text) {
  const out = { hasData: false, exit: null, red: false };
  if (!text || typeof text !== 'string') return out;
  const keyed = lastMatch(text, 'FACTORY::SUMMARY::red\\s+exit=(-?\\d+)');
  const m = keyed || lastMatch(text, 'FACTORY::RED::(-?\\d+)');
  if (m) { out.hasData = true; out.exit = parseInt(m[1], 10); out.red = out.exit !== 0; out.keyed = !!keyed; }
  return out;
}

// P2 — the real-infra container marker. `FACTORY::REALINFRA::<kind>` proves a real Postgres/Redis container
// actually started and the targeted test bound to it; an EF in-memory green never emits this. A self-reported
// realInfraExercised=true without this marker does NOT close a money/security/concurrency/idempotency item.
export function hasRealInfraMarker(text) {
  return typeof text === 'string' && /FACTORY::REALINFRA::\S+/.test(text);
}

// KI-E54 — every fold-time transcript read (verify/integrate/verify-red/baseline -raw.txt) hardcoded
// readFileSync(p,'utf8') with ZERO defense: a producer that emits UTF-16 instead of UTF-8/ASCII (e.g. a
// dispatched subagent's `| tee <file>` command crossing into a PowerShell-hosted shell, where PowerShell's
// `tee`/`Tee-Object` alias and `>`/Out-File all default to UTF-16LE) silently mis-decodes under a plain
// 'utf8' read — every FACTORY:: marker regex in this file then finds nothing in the mojibake, degrading to
// hasData:false / "no-machine-evidence" with NO error or warning anywhere in the fold path (live-caught
// 2026-07-28 on a real production item: a genuine FACTORY::RED::1 proof existed in the subagent's own
// transcript, but the teed verify-red-raw.txt landed as UTF-16LE bytes and read back unparseable,
// triggering a false deterministic-override FAILED on real, correctly-produced evidence). Pure
// BOM-sniffing decode: the driver
// calls this on the raw Buffer instead of assuming 'utf8'. A plain UTF-8/ASCII file with no BOM (the common
// case, unchanged) decodes byte-identically to the old `readFileSync(p,'utf8')` — additive only, never a
// behaviour change on the path that already worked.
export function decodeTranscript(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le'); // UTF-16LE BOM
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) { // UTF-16BE BOM — byte-swap, then decode as LE
    const swapped = Buffer.from(buf.slice(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t; }
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8'); // UTF-8 BOM
  return buf.toString('utf8');
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
// KI-E104: the "is this a test file" predicate, defined ONCE. It was previously written out
// byte-identically inside both `touchedRootCause` and `debrisFiles` below; hoisting it removes the
// standing risk that a future refinement lands in one copy only — the same silent-divergence class
// KI-E103 found between factory.js and its opencode port. Both call sites keep their exact prior
// behaviour (the selftest pins the equivalence).
export function isTestPath(f) {
  // KI-E104: the FILENAME arm is case-SENSITIVE on `Test`, the directory arm is not. The filename arm
  // used to carry /i, which made `[^/]*Tests?\.cs$` match any source file whose name merely ENDS in
  // those letters — `Contests.cs`, `Manifests.cs`, `Protests.cs` were all classified as tests. That is
  // a real false-positive in two shipped deterministic checks: P9 would read a fix touching only such
  // a file as "tests-only" and FAIL a correct fix, and `debrisFiles` (which never flags a test file)
  // would let a same-named scratch file through. .NET test types are PascalCase by universal
  // convention (`OrderServiceTests.cs`), so requiring the capital T costs nothing real; a repo using
  // lowercase test filenames is still covered by the directory arm below, which stays /i because
  // project-directory casing genuinely varies.
  return /[^/]*Tests?\.cs$/.test(f) || /(^|\/)[^/]*\.Tests?(\/|$)/i.test(f);
}

// KI-E104: the non-test subset of a diff. `touchedRootCause` only ever needed the BOOLEAN "is any of
// this non-test", but the pre-band P9 hoist (below/factory.js) needs to SHOW the operator which
// files it found — "the diff touched only tests" is far more actionable when it can also say what
// the diff did touch. One derivation, two consumers, no second isTest predicate.
export function nonTestChanged(changed) {
  return (changed || []).filter((f) => !isTestPath(f));
}

// KI-E471 — PHANTOM MANIFEST. `fix.json`'s `filesChanged` is the fixer's own claim about what it
// edited, and until now NOTHING deterministic ever compared it to reality. The only cross-check that
// existed was the runner AGENT's (agents/runner.md), and it looks the OTHER way: it flags real edits
// missing from the manifest ("a late/undocumented edit"), never a manifest entry with no edit behind
// it. So the claim "I changed A, B and C" while having touched only A passed every gate — and
// `touchedRootCause` (P9) passes too, because SOME non-test file did change.
//
// That is exactly this pipeline's most expensive observed failure: partial work reported as
// complete. KI-E93 covered 1 of 3 named controllers; KI-E94 fixed one switch arm and left its twin;
// KI-E96 forwarded a token at some call sites and not others; the 2026-08-09 haiku batch closed 1/17
// with three fixers reporting "all acceptance criteria met". KI-E470's stepwise execution makes the
// claim PER STEP and therefore checkable per step — this is the check.
//
// Returns the claimed paths with NO counterpart in the real worktree diff. Matching is
// suffix-tolerant in both directions (the manifest may be repo-relative while `changed` is
// worktree-relative, or vice versa) so a path-shape mismatch is never reported as a phantom —
// deliberately conservative: a false FAIL costs a whole re-band, so only a claim with no plausible
// counterpart at all counts.
export function phantomManifest(changed, claimedFiles) {
  if (!Array.isArray(claimedFiles) || !claimedFiles.length) return [];
  if (!Array.isArray(changed)) return [];
  const norm = (f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const real = changed.map(norm);
  // KI-E225 (2026-09-21, live: a live false-FAIL incident): `git status --porcelain` collapses
  // a WHOLLY NEW untracked directory into ONE line naming the directory itself (trailing slash), never
  // the files inside it — `changedFiles()` (lib/worktree.mjs) passes that line straight through as a
  // `real` entry. A fixer creating its first file in a brand-new directory (e.g.
  // "Observability/ServiceMetrics.cs") then has its claim compared against a bare
  // "Observability/" real entry: `r` is SHORTER than `n` here, so neither existing suffix check
  // (`r.endsWith('/'+n)`, `n.endsWith('/'+r)`) can ever match a file living INSIDE a newly-created
  // directory — every such claim reported phantom even though the diff genuinely, entirely contains
  // it. `driver.mjs`'s `deriveTestArtifactFallback` already special-cases this exact git behavior
  // (KI-E215) by recursing into a trailing-slash entry; this is the same shape reaching a different,
  // pure function with no filesystem access of its own — a directory-prefix match needs no recursion,
  // since ANY path inside a git-reported wholly-new directory is, by construction, part of the diff.
  const inNewDir = (r, n) => r.endsWith('/') && n.startsWith(r);
  return claimedFiles.filter((c) => {
    const n = norm(pathToken(c));
    if (!n) return false;
    return !real.some((r) => r === n || r.endsWith('/' + n) || n.endsWith('/' + r) || inNewDir(r, n));
  });
}

// KI-E471 follow-up (found 2026-09-02 on the first live inspection of real fix.json files, BEFORE it
// could fail a fold): `filesChanged` is NOT reliably a clean path list. Real fixers write annotated
// entries — e.g. `deployment/k3s/infrastructure/prometheus/prometheus-rules.yaml (lock set): removed
// 3 stale MinIO alert rules ...` — because the schema types the field as an array of strings and the
// brief asks for rationale. Treating the whole string as a path meant it could never match the diff,
// so the P11 phantom check would have reported a genuine, correctly-changed file as a phantom and
// FAILED the item: a wrong FAIL costing a full re-band, on the exact check added to catch dishonesty.
// The annotation always FOLLOWS the path (path first, prose after), so the leading whitespace-
// delimited token is the path. Trailing punctuation is stripped; a clean path is returned unchanged.
//
// KI-E134 (2026-09-04, live: CPS-H-15): a stepwise-consolidated fixer sometimes returns structured
// `{path, change}` objects instead of the FIX_SCHEMA-documented plain string (FIX_SCHEMA types
// `filesChanged` as `items: {type:'string'}`, but nothing downstream enforced it against what the
// KI-E470 consolidation step actually assembles). `String(entry)` on an object silently produces the
// literal text "[object Object]" — a token that matches NOTHING in the real diff — so EVERY entry in
// an object-shaped filesChanged reports as phantom, even when the worktree diff genuinely contains
// all of them (confirmed live: CPS-H-15's 6 claimed files were ALL present in `git diff HEAD`). Pull
// a `.path`/`.file` property out first when entry is an object, before falling through to the
// existing string-annotation handling.
export function pathToken(entry) {
  if (entry && typeof entry === 'object') entry = entry.path || entry.file || '';
  const raw = String(entry == null ? '' : entry).trim();
  if (!raw) return '';
  const first = raw.split(/\s+/)[0];
  return first.replace(/[),;:]+$/, '');
}

export function touchedRootCause(changed, rootCauseFiles) {
  if (!Array.isArray(rootCauseFiles) || !rootCauseFiles.length) return true; // not a source-file fix (config/doc) -> nothing to assert
  return nonTestChanged(changed).length > 0; // any non-test file (source OR config) proves the diff isn't test-only
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
  const isTest = isTestPath; // KI-E104: the shared predicate (was a byte-identical local copy)
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
