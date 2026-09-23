import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function runInstallerGate(mount, { run = execFileSync, log = console.log, error = console.error } = {}) {
  log('selftest gate: node _workflow/lib/_selftest.mjs --suite portable; integration NOT REQUESTED');
  try {
    const output = run(process.execPath, [join(mount, '_workflow', 'lib', '_selftest.mjs'), '--suite', 'portable'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    log(String(output).split('\n').filter(Boolean).slice(-4).join('\n'));
    return true;
  } catch (failure) {
    error(String((failure.stdout || '') + (failure.stderr || '') || failure.message).split('\n').filter(Boolean).slice(-15).join('\n'));
    return false;
  }
}
