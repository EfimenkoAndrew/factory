import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function resolveBash({ env = process.env, platform = process.platform, spawn = spawnSync } = {}) {
  const candidates = [env.OPENCODE_FACTORY_BASH];
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (root) candidates.push(join(root, 'Git', 'bin', 'bash.exe'), join(root, 'Git', 'usr', 'bin', 'bash.exe'));
    }
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  candidates.push('bash');
  const failures = [];
  for (const candidate of new Set(candidates.filter(Boolean))) {
    const result = spawn(candidate, ['-c', 'exit 0'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
    failures.push(candidate + ': ' + (result.error?.message || String(result.stderr || '').trim() || 'exit ' + result.status));
  }
  throw new Error('No usable Bash executable: ' + failures.join('; '));
}
