import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { canonicalRepoPath, repoPathIdentity } from './repo-path.mjs';

export const EVIDENCE_IDENTITY_VERSION = 3;
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}
const hash = value => createHash('sha256').update(value).digest('hex');

// entries include every tracked file (including deletions) and non-ignored untracked file.
// Content is hashed in full, independently of presentation-pack truncation/timestamps.
export function evidenceIdentity({ baseRevision, entries, acceptance, policies = {}, profile = '', reviewerContract, context = {}, inputContract = {}, engineContract = null }) {
  if (!baseRevision || !reviewerContract || !Array.isArray(entries)) throw new Error('identity requires baseRevision, entries and reviewerContract');
  const files = entries.map(e => ({ path: e.path, mode: e.mode || 'file', hash: e.deleted ? null : hash(e.content) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const contract = { version: EVIDENCE_IDENTITY_VERSION, baseRevision, acceptance, policies, profile, reviewerContract, context, inputContract, engineContract };
  return { version: EVIDENCE_IDENTITY_VERSION, hash: hash(canonicalJson({ ...contract, files })), codeHash: hash(canonicalJson({ version: EVIDENCE_IDENTITY_VERSION, baseRevision, inputContract, engineContract, files: files.filter(e => !/\.(md|rst)$/i.test(e.path) || e.mode.includes('build-input')) })), baseRevision, fileCount: files.length };
}

export const DEFAULT_GENERATED_EXCLUDES = Object.freeze(['**/.git', '**/node_modules', '**/bin', '**/obj', '**/dist', '**/build', '**/coverage', '**/.cache', '**/.venv', '**/__pycache__']);
export const DEFAULT_INPUT_GLOBS = Object.freeze([
  '**/.env', '**/.env.*', '**/global.json', '**/NuGet.Config', '**/nuget.config',
  '**/*.props', '**/*.targets', '**/packages.lock.json', '**/packages.config',
  '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml',
  '**/bun.lock', '**/bun.lockb', '**/.npmrc', '**/.yarnrc*', '**/tsconfig*.json',
  '**/appsettings*.json', '**/requirements*.txt', '**/pyproject.toml', '**/poetry.lock', '**/uv.lock',
  '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum', '**/Gemfile*', '**/composer.lock',
  '**/gradle.properties', '**/gradle.lockfile', '**/pom.xml', '**/settings*.gradle*', '**/build.gradle*',
  '**/CMakeLists.txt', '**/CMakePresets.json', '**/Makefile', '**/Dockerfile*', '**/compose*.y*ml',
]);

function globRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.includes('\\') || pattern.startsWith('/') || /^[a-z]:/i.test(pattern)
      || pattern.split('/').some(p => !p || p === '.' || p === '..') || /[\0\[\]{}!]/.test(pattern)) throw new Error('Invalid input glob: ' + pattern);
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if ((i && pattern[i - 1] !== '/') || (pattern[i + 2] && pattern[i + 2] !== '/')) throw new Error('Glob ** must occupy a segment');
      i++;
      if (pattern[i + 1] === '/') { source += '(?:.*/)?'; i++; } else source += '.*';
    } else if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$', process.platform === 'win32' ? 'i' : '');
}

function normalizedContract(metadata, options) {
  const declared = options.inputs ?? metadata.inputs ?? {};
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('Invalid declared input contract');
  const allowed = ['includePaths', 'includeGlobs', 'excludePaths', 'excludeGlobs', 'generatedExcludes', 'discoverDefaults'];
  if (Object.keys(declared).some(k => !allowed.includes(k))) throw new Error('Unknown declared input contract option');
  const list = (value, name, path = false) => {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Invalid input contract ' + name);
    return [...new Set(value.map(v => path ? canonicalRepoPath(v, process.platform) : (globRegex(v), v)))].sort();
  };
  if (declared.discoverDefaults !== undefined && typeof declared.discoverDefaults !== 'boolean') throw new Error('Invalid discoverDefaults');
  return {
    includePaths: list(declared.includePaths || [], 'includePaths', true),
    includeGlobs: list(declared.includeGlobs || [], 'includeGlobs'),
    excludePaths: [...new Set([...list(declared.excludePaths || [], 'excludePaths', true), ...list(options.excludePaths || [], 'excludePaths', true)])].sort(),
    excludeGlobs: list(declared.excludeGlobs || [], 'excludeGlobs'),
    generatedExcludes: list(declared.generatedExcludes ?? DEFAULT_GENERATED_EXCLUDES, 'generatedExcludes'),
    discoverDefaults: declared.discoverDefaults !== false,
    defaultGlobs: declared.discoverDefaults === false ? [] : [...DEFAULT_INPUT_GLOBS],
  };
}

const gitOutput = (root, args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
export const readOnlyEvidenceGit = Object.freeze({
  root: root => gitOutput(root, ['rev-parse', '--show-toplevel']).trim(),
  head: root => gitOutput(root, ['rev-parse', '--verify', 'HEAD']).trim(),
  index: root => gitOutput(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(record => {
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== '0') throw new Error('Identity requires an unconflicted index');
    return { path: match[4], mode: match[1], oid: match[2] };
  }),
  untracked: root => gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
});

export const ENGINE_SOURCE_PATHS = Object.freeze(['VERSION', '_workflow', 'agents', 'verify', 'config', 'schema']);

function engineMountContract(engineMount, reviewerContract, fs, git) {
  if (engineMount === undefined || engineMount === null) return null;
  if (typeof engineMount !== 'object' || Array.isArray(engineMount)
      || Object.keys(engineMount).some(k => !['path', 'sourceRoot'].includes(k))
      || typeof engineMount.sourceRoot !== 'string' || !isAbsolute(engineMount.sourceRoot)) throw new Error('Invalid engineMount: requires path and absolute sourceRoot');
  const path = canonicalRepoPath(engineMount.path);
  if (!reviewerContract || typeof reviewerContract !== 'object' || Array.isArray(reviewerContract)
      || !reviewerContract.briefs || typeof reviewerContract.briefs !== 'object' || Array.isArray(reviewerContract.briefs)
      || !Object.keys(reviewerContract.briefs).length
      || Object.values(reviewerContract.briefs).some(v => typeof v !== 'string' || !v.trim())) throw new Error('engineMount requires effective reviewerContract.briefs snapshot');
  const root = fs.realpathSync(engineMount.sourceRoot);
  const revision = git.head(root);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(revision)) throw new Error('Invalid live engine revision');
  const files = [];
  const generated = DEFAULT_GENERATED_EXCLUDES.map(globRegex);
  const visit = name => {
    const identity = repoPathIdentity(name, { repoRoot: root, fs });
    if (!identity.exists) throw new Error('Missing required live engine source: ' + name);
    const stat = fs.lstatSync(resolve(root, name));
    if (stat.isSymbolicLink()) throw new Error('Engine source symlinks are not supported: ' + name);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(identity.absolute).sort()) {
        const next = name + '/' + child;
        if (child.toLowerCase() !== '.git' && !generated.some(re => re.test(next))) visit(next);
      }
    } else if (stat.isFile()) files.push({ path: name, mode: stat.mode & 0o111, hash: hash(fs.readFileSync(identity.absolute)) });
    else throw new Error('Unsupported live engine source: ' + name);
  };
  for (const name of ENGINE_SOURCE_PATHS) visit(name);
  const version = fs.readFileSync(resolve(root, 'VERSION'), 'utf8').trim();
  if (!version) throw new Error('Missing live engine version');
  return { path, version, revision, sourceHash: hash(canonicalJson(files)), reviewerContractHash: hash(canonicalJson(reviewerContract)) };
}

export function collectEvidenceIdentity(worktree, metadata, options = {}) {
  const fs = options.fs || nodeFs;
  const git = options.git || readOnlyEvidenceGit;
  const inputContract = normalizedContract(metadata, options);
  if (metadata.reviewerContract?.briefsDirectory) {
    const { briefsDirectory, ...reviewerContract } = metadata.reviewerContract;
    const diskBriefs = {};
    for (const name of fs.readdirSync(briefsDirectory).filter(n => n.endsWith('.md')).sort()) diskBriefs[name.slice(0, -3)] = fs.readFileSync(resolve(briefsDirectory, name), 'utf8');
    metadata = { ...metadata, reviewerContract: { ...reviewerContract, briefs: { ...diskBriefs, ...(reviewerContract.briefs || {}) } } };
  }
  const engineContract = engineMountContract(metadata.engineMount, metadata.reviewerContract, fs, git);
  const root = fs.realpathSync(resolve(worktree));
  const entries = new Map();
  const excludedGlobs = inputContract.excludeGlobs.map(globRegex);
  const generated = inputContract.generatedExcludes.map(globRegex);
  const includedGlobs = [...inputContract.defaultGlobs, ...inputContract.includeGlobs].map(globRegex);
  const ancestors = path => path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  const enginePath = path => engineContract && (canonicalRepoPath(path) === engineContract.path || canonicalRepoPath(path).startsWith(engineContract.path + '/'));
  const excluded = path => enginePath(path) || inputContract.excludePaths.some(p => canonicalRepoPath(path) === p || canonicalRepoPath(path).startsWith(p + '/'))
    || ancestors(path).some(p => excludedGlobs.some(re => re.test(p)));
  const generatedPath = path => ancestors(path).some(p => generated.some(re => re.test(p)));
  const checkedPath = path => {
    canonicalRepoPath(path);
    if (path.split('/').some(p => p.toLowerCase() === '.git')) throw new Error('Git administrative files cannot be declared source inputs');
    return repoPathIdentity(path, { repoRoot: root, fs });
  };
  const addFile = (path, indexMode = '', buildInput = false) => {
    path = canonicalRepoPath(path);
    if (excluded(path)) return;
    const identity = checkedPath(path);
    if (!identity.exists) { entries.set(path, { path, mode: (indexMode || entries.get(path)?.mode || 'file') + (buildInput ? ':build-input' : ''), deleted: true }); return; }
    const absolute = resolve(root, path);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('Identity requires a regular source file: ' + path);
    if (identity.directory) throw new Error('Directory symlink inputs must be declared by their contained files: ' + path);
    const prior = entries.get(path);
    const mode = [indexMode || prior?.mode.split(':')[0] || 'untracked', stat.mode & 0o111 ? 'executable' : 'file',
      stat.isSymbolicLink() ? 'symlink' : '', buildInput || prior?.mode.includes('build-input') ? 'build-input' : ''].join(':');
    const content = stat.isSymbolicLink()
      ? canonicalJson({ link: fs.readlinkSync(absolute), target: hash(fs.readFileSync(identity.absolute)) })
      : fs.readFileSync(absolute);
    entries.set(path, { path, mode, content });
  };
  const visited = new Set();
  const visitRepo = (directory, prefix = '') => {
    const physical = fs.realpathSync(directory);
    if (visited.has(physical)) throw new Error('Recursive submodule worktree alias');
    visited.add(physical);
    if (fs.realpathSync(git.root(directory)) !== physical) throw new Error('Missing or uninitialized submodule worktree: ' + prefix);
    const head = git.head(directory);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) throw new Error('Invalid repository HEAD');
    const indexed = git.index(directory);
    const seen = new Set();
    for (const entry of indexed) {
      canonicalRepoPath(entry.path);
      if (seen.has(entry.path) || !['100644', '100755', '120000', '160000'].includes(entry.mode)
          || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.oid)) throw new Error('Invalid or unmerged index entry');
      seen.add(entry.path);
      const path = prefix + entry.path;
      if (enginePath(path) || (entry.mode !== '160000' && excluded(path))) continue;
      if (entry.mode === '160000') {
        const identity = checkedPath(path);
        if (!identity.exists || !identity.directory || fs.lstatSync(resolve(root, path)).isSymbolicLink()) throw new Error('Missing or invalid submodule worktree: ' + path);
        fs.lstatSync(resolve(root, path, '.git'));
        const childHead = visitRepo(identity.absolute, path + '/');
        entries.set(path, { path, mode: 'gitlink', content: canonicalJson({ index: entry.oid, head: childHead }) });
      } else addFile(path, entry.mode);
    }
    for (const path of git.untracked(directory)) {
      canonicalRepoPath(path);
      if (!seen.has(path)) addFile(prefix + path);
    }
    return head;
  };
  const baseRevision = visitRepo(root);
  const walk = (directory, prefix = '', explicit = false) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = prefix + name;
      if (name.toLowerCase() === '.git' || excluded(path) || (!explicit && generatedPath(path))) continue;
      const absolute = resolve(root, path);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, path + '/', explicit);
      else if (explicit || includedGlobs.some(re => re.test(path))) addFile(path, '', true);
    }
  };
  if (includedGlobs.length) walk(root);
  for (const path of inputContract.includePaths) {
    if (excluded(path)) throw new Error('Declared input is also excluded: ' + path);
    const identity = checkedPath(path);
    if (!identity.exists) addFile(path, '', true);
    else if (identity.directory) walk(identity.absolute, path + '/', true);
    else addFile(path, '', true);
  }
  return evidenceIdentity({ ...metadata, baseRevision, entries: [...entries.values()], inputContract, engineContract });
}
