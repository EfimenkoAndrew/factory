import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

// Lexical repository identity, not realpath/symlink resolution. Pass platform explicitly in Workflow.
export function canonicalRepoPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value.length || value.includes('\0')) throw new Error('Invalid repository path: expected a non-empty string without NUL');
  const path = value.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new Error('Invalid repository path: absolute or drive-relative path ' + value);
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Invalid repository path: escapes repository root ' + value);
      parts.pop();
    } else {
      if (platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
        throw new Error('Invalid repository path: ambiguous Windows segment ' + value);
      }
      parts.push(part);
    }
  }
  if (!parts.length) throw new Error('Invalid repository path: resolves to repository root ' + value);
  const key = parts.join('/');
  return platform === 'win32' ? key.toLowerCase() : key;
}

// Absolute host identity for transcript targets; relative inputs require an explicit absolute base.
export function normalizeHostPath(value, { platform = process.platform, base } = {}) {
  const windows = platform === 'win32';
  const prepare = (input) => {
    if (typeof input !== 'string' || !input.length || input.includes('\0')) throw new Error('Invalid host path');
    let path = input.replace(/\\/g, '/');
    if (windows) path = path.replace(/^\/([a-zA-Z])(?:\/|$)/, '$1:/');
    return path;
  };
  const absolute = (path) => windows ? /^(?:[a-zA-Z]:\/|\/\/)/.test(path) : path.startsWith('/');
  let path = prepare(value);
  if (!absolute(path)) {
    if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) throw new Error('Invalid host path: ambiguous root or drive ' + value);
    if (base === undefined) throw new Error('Invalid host path: relative path requires base ' + value);
    path = normalizeHostPath(base, { platform }) + '/' + path;
  }
  let root;
  let tail;
  if (windows) {
    const drive = /^([a-zA-Z]):\/(.*)$/.exec(path);
    if (drive) {
      root = drive[1].toLowerCase() + ':/';
      tail = drive[2];
    } else {
      const unc = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (!unc || unc[1] === '.' || unc[1] === '..' || unc[1] === '?') throw new Error('Invalid host path: UNC or device path ' + value);
      root = '//' + canonicalRepoPath(unc[1], platform) + '/' + canonicalRepoPath(unc[2], platform) + '/';
      tail = unc[3] || '';
    }
  } else {
    root = '/';
    tail = path.replace(/^\/+/, '');
  }
  const parts = [];
  for (const part of tail.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Invalid host path: escapes filesystem root ' + value);
      parts.pop();
    } else {
      parts.push(canonicalRepoPath(part, platform));
    }
  }
  return root + parts.join('/');
}

export function repoPathOptions(options = process.platform, repoRoot) {
  return typeof options === 'string' ? { platform: options, repoRoot } : { platform: process.platform, ...options };
}

export function repoPathIdentity(value, options = {}) {
  const { platform, repoRoot, fs = { lstatSync, realpathSync, statSync } } = repoPathOptions(options);
  const lexical = canonicalRepoPath(value, platform);
  const declaredDirectory = /(?:\/|(?:^|\/)\.{1,2})$/.test(value.replace(/\\/g, '/'));
  if (!repoRoot) return { path: lexical, keys: ['path:' + lexical], exists: false, directory: declaredDirectory };
  const root = fs.realpathSync(resolve(repoRoot));
  const contained = (absolute) => {
    const rel = relative(root, absolute);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Repository path resolves outside repository: ' + value);
    return rel;
  };
  let absolute = root;
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    absolute = resolve(absolute, part);
    contained(absolute);
    try {
      fs.lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    absolute = fs.realpathSync(absolute);
    contained(absolute);
  }
  let stat;
  try { stat = fs.statSync(absolute, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rel = contained(absolute);
  if (!rel) throw new Error('Invalid repository path: resolves to repository root ' + value);
  const path = canonicalRepoPath(rel, platform);
  if (declaredDirectory && stat && !stat.isDirectory()) throw new Error('Declared repository directory is a file: ' + value);
  const keys = ['path:' + path];
  if (stat?.isFile()) {
    if (!stat.ino || stat.dev === undefined) throw new Error('Filesystem does not expose a usable file identity: ' + value);
    keys.push('inode:' + stat.dev + ':' + stat.ino);
  }
  return { path, absolute, keys, exists: !!stat, directory: declaredDirectory || !!stat?.isDirectory() };
}

export function repoPathsOverlap(left, right) {
  return left.keys.some(key => right.keys.includes(key))
    || (left.directory && right.path.startsWith(left.path + '/'))
    || (right.directory && left.path.startsWith(right.path + '/'));
}
