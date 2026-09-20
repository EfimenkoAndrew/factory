import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, pruneStaleBranch } from './worktree.mjs';
import { dirtyMainPaths, filesOverlapDirty, unclaimedMainDrift, splitDriftByStatus } from './mainguard.mjs';
import { findComments } from './comment-scan.mjs';

function withGit(replies, action, eq) {
  const original = childProcess.execFileSync;
  let calls = 0;
  const unexpected = [];
  childProcess.execFileSync = (file, args) => {
    const reply = replies[calls++];
    if (file !== 'git' || !reply || JSON.stringify(args) !== JSON.stringify(reply.args)) {
      unexpected.push([file, args]);
      throw new Error('Unexpected fixture process: ' + JSON.stringify([file, args]));
    }
    if (reply.error) throw new Error(reply.error);
    return reply.output || '';
  };
  syncBuiltinESMExports();
  try { return action(); }
  finally {
    childProcess.execFileSync = original;
    syncBuiltinESMExports();
    eq(calls, replies.length, 'every expected git process boundary was exercised');
    eq(unexpected, [], 'no unexpected process request was swallowed by production error handling');
  }
}

const status = (root, output, error) => ({ args: ['--no-optional-locks', '-C', root, 'status', '--porcelain=v1', '--untracked-files=normal', '-z'], output, error });

export function runGitFixture(name, { ok, eq }) {
  const root = tmpdir();
  if (name === 'changedFiles porcelain integration') {
    withGit([{ args: ['-C', root, 'status', '--porcelain'], output: ' M kfile.cs\n?? new.cs\n' }], () => {
      eq(changedFiles(root), ['kfile.cs', 'new.cs'], 'changedFiles preserves leading character of unstaged modified path');
    }, eq);
    withGit([{ args: ['-C', root, 'status', '--porcelain'] }], () => eq(changedFiles(root), [], 'clean porcelain has no changed files'), eq);
  } else if (name === 'KI-E100 pruneStaleBranch integration') {
    const verify = name => ({ args: ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/' + name], output: 'fixture-oid\n' });
    const ancestor = name => ({ args: ['-C', root, 'merge-base', '--is-ancestor', name, 'HEAD'] });
    const deletion = name => ({ args: ['-C', root, 'branch', '-D', name] });
    for (const branch of ['factory/safe', 'refs/heads/factory/prefixtest']) {
      const name = branch.replace(/^refs\/heads\//, '');
      withGit([verify(name), ancestor(name), deletion(name)], () => {
        eq(pruneStaleBranch(branch, root), { deleted: true, branch: name }, 'ancestor-only branch requests deletion after both read checks (in-memory process boundary)');
      }, eq);
    }
    withGit([verify('factory/unsafe'), { ...ancestor('factory/unsafe'), error: 'not ancestor' }], () => {
      const result = pruneStaleBranch('factory/unsafe', root);
      eq(result.deleted, false, 'branch with unique history never requests deletion');
      ok(/not reachable from HEAD/.test(result.reason), 'unique-history refusal explains manual review');
    }, eq);
    withGit([], () => eq(pruneStaleBranch(null, root), { deleted: false, reason: 'no-branch-given' }, 'missing branch never calls git'), eq);
    withGit([{ ...verify('factory/missing'), error: 'missing' }], () => {
      const result = pruneStaleBranch('factory/missing', root);
      eq(result.deleted, false, 'nonexistent branch never requests deletion');
      ok(/does not exist/.test(result.reason), 'missing branch has a distinct refusal reason');
    }, eq);
    withGit([verify('factory/locked'), ancestor('factory/locked'), { ...deletion('factory/locked'), error: 'branch is checked out' }], () => {
      eq(pruneStaleBranch('factory/locked', root), { deleted: false, reason: 'branch is checked out' }, 'failed deletion is not reported as successful');
    }, eq);
  } else if (name === 'KI-E14 dirtyMainPaths integration') {
    withGit([status(root, ' M tracked.cs\0?? newdir/\0R  renamed.cs\0old.cs\0')], () => {
      const dirty = dirtyMainPaths(root);
      eq(dirty.paths, ['tracked.cs', 'renamed.cs', 'old.cs'], 'dirty paths include unstaged edit and both rename endpoints');
      eq(dirty.dirs, ['newdir/'], 'untracked directory remains a prefix boundary');
      eq(filesOverlapDirty(['newdir/new.cs', 'clean.cs', 'old.cs'], dirty), ['newdir/new.cs', 'old.cs'], 'overlap includes untracked descendants and rename sources');
    }, eq);
  } else if (name === 'KI-E89 unclaimedMainDrift integration') {
    withGit([status(root, ' M _bmad-output/ai-factory/state/ledger.json\0 M Svc/tracked.cs\0?? Svc/Tests/Helpers/\0')], () => {
      const dirty = dirtyMainPaths(root);
      eq(unclaimedMainDrift(dirty, '_bmad-output/ai-factory', new Set(['Svc/tracked.cs'])), ['Svc/Tests/Helpers/'], 'only unclaimed outside-mount leaked directory surfaces');
      eq(unclaimedMainDrift(dirty, '_bmad-output/ai-factory', new Set(['Svc/tracked.cs', 'Svc/Tests/Helpers/Skip.cs'])), [], 'claiming a child accounts for the whole untracked directory');
    }, eq);
  } else if (name === 'KI-E89 quoted-path porcelain integration') {
    withGit([status(root, '?? café.cs\0?? name with spaces.cs\0?? dash - name.cs\0')], () => {
      eq(dirtyMainPaths(root).paths, ['café.cs', 'name with spaces.cs', 'dash - name.cs'], 'NUL porcelain preserves UTF-8, spaces and punctuation');
    }, eq);
    if (process.platform !== 'win32') {
      withGit([status(root, '?? weird"quote.cs\0?? back\\slash.cs\0')], () => {
        eq(dirtyMainPaths(root).paths, ['weird"quote.cs', 'back\\slash.cs'], 'POSIX raw NUL porcelain preserves quote and backslash bytes');
      }, eq);
    } else {
      withGit([status(root, '?? weird"quote.cs\0')], () => {
        let rejected = false;
        try { dirtyMainPaths(root); } catch { rejected = true; }
        ok(rejected, 'Windows rejects a reserved quote filename instead of accepting ambiguous identity');
      }, eq);
    }
  } else if (name === 'KI-E35 splitDriftByStatus integration') {
    const drift = [{ file: 'committed.txt' }, { file: 'modified.txt' }, { file: 'untracked-new.txt' }];
    withGit([status(root, ' M modified.txt\0?? untracked-new.txt\0')], () => {
      const result = splitDriftByStatus(root, drift);
      eq(result.committed, [drift[0]], 'committed clean drift is human delivery');
      eq(result.dirty, drift.slice(1), 'both uncommitted edit and untracked stray remain contamination');
    }, eq);
    withGit([status(root, '', 'git unavailable')], () => {
      eq(splitDriftByStatus(root, drift), { committed: [], dirty: drift }, 'status failure conservatively classifies all drift as dirty');
    }, eq);
  } else if (name === 'KI-E59 comment move/untracked integration') {
    const directory = mkdtempSync(join(tmpdir(), 'comment-readonly-'));
    try {
      writeFileSync(join(directory, 'NewTests.cs'), 'public class T {\n    // untracked comment in new test file\n}\n');
      const replies = [
        { args: ['-C', directory, 'diff', 'HEAD', '--unified=0'], output: '--- a/Move.cs\n+++ b/Move.cs\n@@ -1,5 +1,5 @@\n-namespace Old.Ns\n-{\n-    // pre-existing invariant comment\n-    class A { }\n-}\n+namespace New.Ns;\n+\n+// pre-existing invariant comment\n+class A { }\n+// BRAND NEW comment\n' },
        { args: ['-C', directory, 'ls-files', '--others', '--exclude-standard'], output: 'NewTests.cs\n' },
      ];
      withGit(replies, () => {
        const hits = findComments(directory, 50);
        eq(hits.map(h => h.line).sort(), ['// BRAND NEW comment', '// untracked comment in new test file'], 'moved comment suppressed; new and real untracked-file comments detected');
        eq(hits.skipped, 0, 'real filesystem untracked reads complete without cat');
      }, eq);
      withGit([replies[0], { ...replies[1], output: 'Missing.cs\n' }], () => eq(findComments(directory).skipped, 1, 'unreadable untracked file is counted, never silently green'), eq);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } else throw new Error('Unknown read-only fixture group: ' + name);
}

export function runCheckoutCoverage(root, { ok, eq }) {
  const output = childProcess.execFileSync('git', ['--no-optional-locks', '-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trimEnd();
  eq(changedFiles(root), output ? output.split('\n').map(line => line.slice(3)) : [], 'real current checkout changedFiles matches read-only porcelain');
  const dirty = dirtyMainPaths(root);
  ok(Array.isArray(dirty.paths) && Array.isArray(dirty.dirs), 'real current checkout NUL porcelain parses successfully');
  const drift = dirty.paths.map(file => ({ file }));
  eq(splitDriftByStatus(root, drift).dirty, drift, 'real checkout dirty paths are never labeled committed delivery');
  const tracked = childProcess.execFileSync('git', ['--no-optional-locks', '-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const clean = tracked.find(file => filesOverlapDirty([file], dirty).length === 0);
  ok(Boolean(clean), 'current checkout supplies a real clean tracked path');
  if (clean) eq(splitDriftByStatus(root, [{ file: clean }]).committed, [{ file: clean }], 'real checkout clean tracked path classifies as committed');
}
