import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBash } from '../_workflow/lib/bash.mjs';
import { runInstallerGate } from './_installer-gate.mjs';

test('installer command seam invokes portable explicitly and propagates injected command failure', () => {
  const calls = [], logs = [], errors = [];
  const options = { log: text => logs.push(text), error: text => errors.push(text), run: (command, args) => {
    calls.push({ command, args });
    throw Object.assign(new Error('command failed'), { status: 73, stderr: 'FACTORY_E2E_INJECTED_SELFTEST_FAILURE' });
  } };
  assert.equal(runInstallerGate('/fixture', options), false);
  assert.deepEqual(calls, [{ command: process.execPath, args: [join('/fixture', '_workflow/lib/_selftest.mjs'), '--suite', 'portable'] }]);
  assert.match(errors.join('\n'), /FACTORY_E2E_INJECTED_SELFTEST_FAILURE/);
  assert.match(logs.join('\n'), /integration NOT REQUESTED/);
  assert.equal(runInstallerGate('/fixture', { ...options, run: () => 'portable green' }), true);
});

test('whole E2E fixture and both installer gates really fail without running mutating Git', t => {
  const root = mkdtempSync(join(process.env.FACTORY_TEST_TMP_ROOT || tmpdir(), 'installer-fault-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const e2e = readFileSync(new URL('./_e2e.sh', import.meta.url), 'utf8');
  const failure = e2e.match(/<<'FACTORY_SELFTEST_FAILURE'\r?\n([\s\S]*?)\r?\nFACTORY_SELFTEST_FAILURE/);
  assert.ok(failure, 'whole fixture script has a named delimiter');
  const lib = join(root, '_workflow', 'lib'); mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, '_selftest.mjs'), failure[1]);
  const direct = spawnSync(process.execPath, [join(lib, '_selftest.mjs'), '--suite', 'portable'], { encoding: 'utf8' });
  assert.equal(direct.status, 73);
  assert.match(direct.stderr, /FACTORY_E2E_INJECTED_SELFTEST_FAILURE/);
  const errors = [];
  assert.equal(runInstallerGate(root, { log: () => {}, error: text => errors.push(text) }), false);
  assert.match(errors.join('\n'), /FACTORY_E2E_INJECTED_SELFTEST_FAILURE/);
  const bash = resolveBash();
  for (const name of ['install.sh', '_e2e.sh', 'release.sh']) {
    const syntax = spawnSync(bash, ['-n', fileURLToPath(new URL(name, import.meta.url))], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  const installer = readFileSync(new URL('./install.sh', import.meta.url), 'utf8');
  const gate = installer.match(/^run_selftest\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(gate);
  const shell = 'log() { printf "%s\\n" "$*"; }\n' + gate + '\nrun_selftest "$1"';
  const result = spawnSync(bash, ['-c', shell, '_', root.replace(/\\/g, '/')], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /FACTORY_E2E_INJECTED_SELFTEST_FAILURE/);
  writeFileSync(join(lib, '_selftest.mjs'), 'if (process.argv.slice(2).join(" ") !== "--suite portable") process.exit(74);\nconsole.log("PORTABLE_FIXTURE_GREEN");');
  assert.equal(runInstallerGate(root, { log: () => {} }), true);
  const green = spawnSync(bash, ['-c', shell, '_', root.replace(/\\/g, '/')], { encoding: 'utf8' });
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /PORTABLE_FIXTURE_GREEN/);
});
