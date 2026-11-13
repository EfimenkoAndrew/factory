// KI-E305 — runtime guard for the durable fold push (orchestrator/durable-push.sh).
// Reproduces the exact failure that an 82-minute live run took to surface (KI-E304): an ADVANCED
// remote + a DIRTY working tree. A string-presence selftest pin cannot catch a dirty-tree rebase;
// this exercises the real script against a real (local, no-network) git topology.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./durable-push.sh', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const cfg = (dir) => { git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'commit.gpgsign', 'false'); };

test('durable-push lands the fold commit onto an ADVANCED remote despite a DIRTY tree (KI-E304 regression)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dpush-'));
  try {
    const remote = join(root, 'remote.git');
    const A = join(root, 'A'); const B = join(root, 'B'); const C = join(root, 'C');
    git(root, 'init', '--bare', '-q', '-b', 'master', remote);

    git(root, 'clone', '-q', remote, A); cfg(A);
    writeFileSync(join(A, 'base.txt'), 'base\n');
    writeFileSync(join(A, 'tracked.txt'), 'v1\n');
    git(A, 'add', '-A'); git(A, 'commit', '-q', '-m', 'base'); git(A, 'push', '-q', 'origin', 'master');

    // Remote advances from a sibling clone (so A is behind at push time).
    git(root, 'clone', '-q', remote, B); cfg(B);
    writeFileSync(join(B, 'other.txt'), 'from-B\n');
    git(B, 'add', '-A'); git(B, 'commit', '-q', '-m', 'remote advance'); git(B, 'push', '-q', 'origin', 'master');

    // A makes the "fold" commit, then leaves a DIRTY tree (untracked state + a modified tracked file
    // = the factory's uncommitted leftovers + main-drift).
    writeFileSync(join(A, 'fold.txt'), 'the fold\n');
    git(A, 'add', 'fold.txt'); git(A, 'commit', '-q', '-m', 'fold: ledger+feedback');
    writeFileSync(join(A, 'dirty.txt'), 'uncommitted state\n');
    writeFileSync(join(A, 'tracked.txt'), 'v2-main-drift\n');

    // Precondition: a BARE rebase refuses the dirty tree — the KI-E304 bug.
    tryGit(A, 'fetch', 'origin', 'master');
    const bare = tryGit(A, 'rebase', 'origin/master');
    assert.match(bare, /unstaged changes|cannot rebase/i, 'precondition: bare rebase refuses the dirty tree');
    tryGit(A, 'rebase', '--abort');

    // The real script succeeds.
    const out = execFileSync('bash', [SCRIPT, 'master'], { cwd: A, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(out, /durable-push: pushed to master/, 'script reports a successful push');

    git(root, 'clone', '-q', remote, C);
    assert.ok(existsSync(join(C, 'fold.txt')), 'the fold commit reached the remote');
    assert.ok(existsSync(join(C, 'other.txt')), 'the remote advance was preserved (rebase, not force-overwrite)');
    assert.equal(readFileSync(join(C, 'fold.txt'), 'utf8'), 'the fold\n');

    // The dirty tree survived in A (autostash restored it) — no work lost.
    assert.ok(existsSync(join(A, 'dirty.txt')), 'untracked dirty file restored by --autostash');
    assert.match(readFileSync(join(A, 'tracked.txt'), 'utf8'), /v2-main-drift/, 'modified tracked file restored by --autostash');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable-push.sh uses --autostash, never a silent `|| true`, and fails loud', () => {
  const src = readFileSync(fileURLToPath(new URL('./durable-push.sh', import.meta.url)), 'utf8');
  assert.match(src, /git rebase --autostash "origin\/\$\{base\}"/, 'rebases with --autostash');
  assert.doesNotMatch(src, /git push origin HEAD \|\| true/, 'no silent-swallow push command');
  assert.match(src, /exit 1/, 'loud exit 1 on persistent failure');
});
