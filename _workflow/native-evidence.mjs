import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectNativeEvidence, persistNativeAdmission, hydrateNativeEvidenceMetadata } from './lib/native-evidence.mjs';
import { assertArtifactTree, readArtifactInput } from './lib/native-artifact-guard.mjs';
import { hydrateNativeContext } from './lib/native-context.mjs';

try {
  const [worktree, input, artifactDir, ...flags] = process.argv.slice(2);
  if (!worktree || !input || !artifactDir) throw new Error('usage: node native-evidence.mjs <worktree> <metadata.json> <artifactDir>');
  const legacy = flags.length === 1 && flags[0] === '--legacy';
  const expectedDigest = flags[0] === '--expected-request' && /^[0-9a-f]{64}$/.test(flags[1] || '') && flags.length === 2 ? flags[1] : null;
  if (worktree !== '--persist-admission' && !legacy && !expectedDigest) throw new Error('native evidence requires --expected-request <sha256> (or explicit --legacy)');
  if (worktree === '--persist-admission' && !legacy) throw new Error('admission requires native-persist.mjs digest-bound checkpoint endpoint; --legacy is explicit compatibility only');
  if (!legacy) assertArtifactTree(artifactDir);
  const metadata = JSON.parse(legacy ? readFileSync(input, 'utf8') : readArtifactInput(artifactDir, input, 'evidence-input-' + expectedDigest + '.json'));
  console.log(JSON.stringify(worktree === '--persist-admission'
    ? persistNativeAdmission(artifactDir, metadata)
    : collectNativeEvidence(worktree, hydrateNativeEvidenceMetadata(hydrateNativeContext(artifactDir, metadata), {
      trustedBriefsDirectory: join(realpathSync(fileURLToPath(new URL('../', import.meta.url))), 'agents'),
    }), artifactDir, { legacy, expectedDigest })));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
