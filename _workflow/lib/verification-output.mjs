import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function prepareVerificationOutput(artifactDir, hash, phase = 'final') {
  if (!['initial', 'final', 'integrate'].includes(phase)) throw new Error('invalid verification phase');
  if (phase === 'final' ? !/^[0-9a-f]{64}$/.test(hash) : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/.test(hash)) throw new Error('invalid verification identity');
  const path = join(artifactDir, 'verify-' + phase + '-' + hash + '.txt');
  if (existsSync(path)) {
    let suffix = 1;
    while (existsSync(path + '.prior-' + suffix)) suffix++;
    renameSync(path, path + '.prior-' + suffix);
  }
  writeFileSync(path, '', { flag: 'wx' });
  return { written: true };
}
