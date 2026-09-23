import { lstatSync, readdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, relative, dirname, basename, isAbsolute, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export function instructionBearingPath(path) {
  return String(path).replaceAll('\\', '/').split('/').some(part =>
    /^(?:claude(?:\.local)?\.md|agents\.md|gemini\.md|copilot-instructions\.md|\.claude|\.opencode|\.github|\.cursor|\.cursorrules|\.windsurfrules|opencode\.jsonc?)$/i.test(part.replace(/[ .]+$/, '').split(':')[0]));
}

export function assertRegularPath(path, { directory = false, missing = false } = {}) {
  const full = resolve(path);
  const parent = dirname(full);
  if (parent !== full) assertRegularPath(parent, { directory: true });
  let stat;
  try { stat = lstatSync(full); } catch (error) { if (missing && error.code === 'ENOENT') return full; throw error; }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('unsafe artifact path: ' + full);
  return full;
}

export function assertArtifactTree(artifactDir) {
  const root = assertRegularPath(artifactDir, { directory: true });
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (instructionBearingPath(name)) throw new Error('instruction-bearing artifact: ' + path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('unsafe artifact path: ' + path);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  return root;
}

export function exactArtifactPath(artifactDir, name, { missing = true } = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || instructionBearingPath(name)) throw new Error('invalid artifact name');
  const root = assertRegularPath(artifactDir, { directory: true });
  return assertRegularPath(join(root, name), { missing });
}

export function readArtifactInput(artifactDir, input, expectedName) {
  const path = exactArtifactPath(artifactDir, expectedName, { missing: false });
  if (!isAbsolute(input) || relative(path, resolve(input)) !== '') throw new Error('artifact input path mismatch');
  return readFileSync(path, 'utf8');
}

export function writeArtifactAtomic(artifactDir, name, bytes, { immutable = false } = {}) {
  assertArtifactTree(artifactDir);
  const path = exactArtifactPath(artifactDir, name);
  try {
    const previous = readFileSync(path, 'utf8');
    if (previous === bytes) return { written: true };
    if (immutable) throw new Error('immutable artifact already exists with different bytes');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = join(dirname(path), basename(path) + '.tmp-' + randomUUID());
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    exactArtifactPath(artifactDir, name);
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { written: true };
}

export function artifactToolDecision(event, policy) {
  const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  try {
    if (policy?.version !== 1 || !Array.isArray(policy.artifactRoots) || !policy.artifactRoots.length || !policy.artifactRoots.every(root => typeof root === 'string' && isAbsolute(root))) throw new Error('invalid artifact guard policy');
    for (const root of policy.artifactRoots) assertArtifactTree(root);
    const input = event.tool_input || {};
    const writing = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(event.tool_name);
    if (writing) {
      const path = input.file_path || input.notebook_path;
      if (typeof path !== 'string' || !isAbsolute(event.cwd || '')) throw new Error('missing tool path/cwd');
      const full = resolve(event.cwd, path);
      const within = policy.artifactRoots.some(root => { const rel = relative(resolve(root), full); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))); });
      if (instructionBearingPath(full) && (within || policy.mechanical === true)) throw new Error('instruction-bearing writes forbidden');
      if (within) assertRegularPath(full, { missing: true });
      if (policy.mechanical === true) {
        const entry = policy.allowedWrites?.find(entry => resolve(entry.path) === full);
        if (!within || event.tool_name !== 'Write' || !entry || !/^[0-9a-f]{64}$/.test(entry.digest || '') || typeof input.content !== 'string' || createHash('sha256').update(input.content).digest('hex') !== entry.digest) throw new Error('write outside exact mechanical payload contract');
        assertRegularPath(full, { missing: true });
      }
    }
    if (policy.mechanical === true && !writing) {
      if (event.tool_name === 'Bash') {
        if (!policy.allowedCommands?.includes(input.command)) throw new Error('command outside exact mechanical contract');
      } else if (event.tool_name === 'Read') {
        if (typeof input.file_path !== 'string' || !isAbsolute(event.cwd || '') || !policy.allowedReads?.includes(resolve(event.cwd, input.file_path))) throw new Error('read outside exact mechanical contract');
      } else throw new Error('tool outside mechanical contract');
    }
    return {};
  } catch (error) { return deny(error.message); }
}
