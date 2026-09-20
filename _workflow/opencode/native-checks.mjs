import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { driftAgainstSnapshot, splitDriftByStatus } from '../lib/mainguard.mjs';
import { writeRaw } from './buildtest.mjs';
import { limitedBuildTest as runBuildTest } from './build-lease.mjs';
import { priorFindingPrompt } from './shadow-scan.mjs';

export function serviceRoots(files) {
  return [...new Set(files.filter(f => /\.cs$/i.test(f)).map(f => /^(.*?([^/]+))\/src\/\2\.(?:Core|Persistence|Infrastructure|Api)\//i.exec(f.replace(/\\/g, '/'))?.[1]).filter(Boolean))];
}

export function mainDrift(progress, dir) {
  const path = join(dir, 'main-snapshot.json');
  if (!existsSync(path)) return { unavailable: true, reason: 'claim main snapshot missing' };
  const snap = JSON.parse(readFileSync(path, 'utf8'));
  return splitDriftByStatus(progress.ctx.repoRoot, driftAgainstSnapshot(progress.ctx.repoRoot, snap.files));
}

export function efProbe(progress, files, dir, run = runBuildTest) {
  const results = [];
  for (const root of serviceRoots(files)) {
    const service = root.split('/').at(-1);
    const api = join(progress.ctx.worktreePath, root, 'src', service + '.Api');
    const persistence = '../' + service + '.Persistence';
    if (!existsSync(join(api, persistence))) { results.push({ service: root, verdict: 'inconclusive', reason: 'expected persistence project missing' }); continue; }
    const r = run(progress.ctx.factoryRoot, 'efmigration', [api.replace(/\\/g, '/'), persistence]);
    writeRaw(join(dir, 'efmigration-' + service + '-raw.txt'), r.output);
    const marker = /^FACTORY::SUMMARY::efmigration exit=(-?\d+) verdict=(clean|dirty|inconclusive)\r?$/m.exec(r.output);
    results.push({ service: root, verdict: marker && Number(marker[1]) === r.code ? marker[2] : 'inconclusive' });
  }
  return results;
}

export function nativeProbeCalls(progress, feedback = '') {
  const calls = [];
  if (progress.reFix && !feedback.trim()) throw new Error('required prior-finding feedback missing for reFix');
  if (progress.reFix && feedback.trim()) calls.push({ role: 'prior-finding-probe', schema: 'PLAN_COMMITMENT_SCHEMA', field: 'honored', extra: priorFindingPrompt(feedback) });
  if (progress.res.codeChange) calls.push({ role: 'red-coverage-probe', schema: 'RED_COVERAGE_SCHEMA', field: 'covered', extra: 'Compare test.json testFiles/runCmd and verify-red-raw.txt with evidence.json target/filter and current test files. Missing runCmd is not permission to skip this check: derive coverage from the actual RED transcript or return covered=false. covered=true only when the FINAL targeted regression was actually covered by the pre-fix RED proof (or the passing verification-only proof). A later new test is not covered by an inherited convention test. Read the transcripts; do not trust reported evidence strings.' });
  if (/\b(every|all|none|no\s+\w+|any|each)\b/i.test(progress.item.acceptance || '')) calls.push({ role: 'breadth-claim-probe', schema: 'ACCEPT_SCHEMA', field: 'covered', extra: 'Independently verify the universal acceptance claim against the actual test scan roots, regex/call shapes and sibling directories. Enumerate missed consumers and boundary shapes. covered=false even when tests pass if the proof has the same blind spot as the fix.\nCLAIM: ' + progress.item.acceptance });
  return calls;
}
