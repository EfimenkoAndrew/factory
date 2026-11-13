// KI-E237 — ConcurrencyScan: detects a diff that adds/modifies a lock primitive, an EF
// ChangeTracker call, or a subprocess/parallel construct inside a TEST file — the shared root
// cause behind this session's own repeated real incidents (a real wave-1 fix leaving 2 NEW
// critical races; CPS-H-11's split-brain fix itself lacking a self-reference guard AND its own
// regression test being flaky; CONFIG-H12's outbox TOCTOU; MSG-CR-3's `Process.Start("chmod",...)`
// race in the fix's OWN new regression test). Individual reviewers this session ran the affected
// suite 9, 15, 18, 20, 25, or 30+ times, inconsistently, per their own judgment — this scan feeds a
// uniform, mandatory repetition requirement (injected into the relevant gate/review prompts by
// factory.js's compose(), see the KI-E237 block there) instead of leaving run-count to chance.
// Pure, selftest-covered; the CLI wrapper is concurrency-scan-lint.mjs. Advisory input only — this
// never gates pass/fail on its own, it only decides whether to inject the repetition mandate.
const LOCK_RE = /\b(lock\s*\(|SemaphoreSlim|Monitor\.Enter|Mutex\s*\(|AcquireAdvisoryXactLockAsync|Interlocked\.|ChangeTracker\.)/;
const TEST_RACE_RE = /\b(Process\.Start\s*\(|Task\.Run\s*\(|Task\.WhenAll\s*\(|Parallel\.For)/;
// Deliberately a function, not a single regex: this repo's real test projects are named
// "{Service}.Tests" (a PERIOD before "Tests", e.g. "ExampleService.Tests/Foo.cs"), not a bare
// "Tests/" directory — an earlier regex-only version (`(^|[/\\])Tests?[/\\]`) required "Tests" be
// preceded by a path separator or string-start, which never matches ".Tests" and silently never
// fired on this repo's own real test-project layout. Segment-based check is unambiguous: does any
// DIRECTORY segment end in "Test"/"Tests", or does the FILENAME itself end in "Test.cs"/"Tests.cs".
function isTestPath(path) {
  const segments = String(path || '').split(/[/\\]/);
  const filename = segments[segments.length - 1] || '';
  if (/Tests?\.cs$/i.test(filename)) return true;
  return segments.slice(0, -1).some((seg) => /Tests?$/i.test(seg));
}

export function scanConcurrencyTouch(diffText) {
  const hits = [];
  let currentFile = null;
  for (const rawLine of String(diffText || '').split('\n')) {
    const gitHeader = rawLine.match(/^diff --git a\/.+ b\/(.+)$/);
    if (gitHeader) { currentFile = gitHeader[1]; continue; }
    const plusHeader = rawLine.match(/^\+\+\+ b\/(.+)$/);
    if (plusHeader) { currentFile = plusHeader[1]; continue; }
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;
    const line = rawLine.slice(1);
    if (LOCK_RE.test(line)) {
      hits.push({ file: currentFile || '?', pattern: 'lock-or-shared-state', line: line.trim().slice(0, 200) });
    } else if (TEST_RACE_RE.test(line) && currentFile && isTestPath(currentFile)) {
      hits.push({ file: currentFile, pattern: 'subprocess-or-parallel-in-test', line: line.trim().slice(0, 200) });
    }
  }
  return hits;
}
