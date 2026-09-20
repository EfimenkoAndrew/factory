import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { readOnlyEvidenceGit } from './evidence-identity.mjs';
import { canonicalRepoPath, repoPathIdentity } from './repo-path.mjs';

export function driverEngineMount(repoRoot, factoryRoot, { git = readOnlyEvidenceGit } = {}) {
  const root = realpathSync(repoRoot), sourceRoot = realpathSync(factoryRoot);
  const rel = relative(root, sourceRoot);
  if (!rel || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) return null;
  const path = canonicalRepoPath(rel);
  return git.index(root).some(entry => entry.mode === '160000' && canonicalRepoPath(entry.path) === path)
    ? { path, sourceRoot } : null;
}

export function preflightProductGitlinks(worktree, engineMount, { git = readOnlyEvidenceGit } = {}) {
  const root = realpathSync(worktree), visited = new Set();
  const visit = (directory, prefix = '') => {
    const physical = realpathSync(directory);
    if (visited.has(physical)) throw new Error('recursive product submodule alias: ' + prefix);
    visited.add(physical);
    for (const entry of git.index(directory)) {
      if (entry.mode !== '160000') continue;
      const path = canonicalRepoPath(prefix + entry.path);
      if (!prefix && engineMount && path === engineMount.path) continue;
      try {
        const identity = repoPathIdentity(path, { repoRoot: root });
        if (!identity.exists || !identity.directory || lstatSync(resolve(root, path)).isSymbolicLink()
          || !existsSync(join(identity.absolute, '.git')) || realpathSync(git.root(identity.absolute)) !== realpathSync(identity.absolute)
          || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(git.head(identity.absolute))) throw new Error('missing/uninitialized worktree');
        visit(identity.absolute, path + '/');
      } catch (e) {
        throw new Error('Product submodule preflight failed for ' + path + ' in ' + worktree + ': ' + e.message
          + '. Ask the owner to initialize/update this product submodule recursively in this worktree, then rerun admission. No git mutation was performed.');
      }
    }
  };
  visit(root);
}
