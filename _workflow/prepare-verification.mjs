import { prepareVerificationOutput } from './lib/verification-output.mjs';
import { nativeVerificationContract } from './lib/native-verification-contract.mjs';
import { assertArtifactTree, readArtifactInput, exactArtifactPath } from './lib/native-artifact-guard.mjs';
import { nativeRequestJson, nativeRequestSha256 } from './lib/native-evidence-request.mjs';

try {
  const [artifactDir, hash, phase, contractFile, flag, digest, ...extra] = process.argv.slice(2);
  if (!artifactDir) throw new Error('usage: node prepare-verification.mjs <artifactDir> <identityHash>');
  assertArtifactTree(artifactDir);
  if (extra.length || (contractFile ? flag !== '--expected-request' || !/^[0-9a-f]{64}$/.test(digest || '') : flag || digest)) throw new Error('verification contract requires --expected-request <sha256>');
  const input = contractFile ? JSON.parse(readArtifactInput(artifactDir, contractFile, 'verification-contract-input.json')) : null;
  if (input && nativeRequestSha256(nativeRequestJson(input)) !== digest) throw new Error('verification contract digest mismatch');
  const contract = input ? nativeVerificationContract({ ...input, artifactDir }) : {};
  exactArtifactPath(artifactDir, 'verify-' + (phase || 'final') + '-' + hash + '.txt');
  console.log(JSON.stringify({ ...prepareVerificationOutput(artifactDir, hash, phase), ...contract }));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
