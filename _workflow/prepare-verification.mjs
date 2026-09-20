import { prepareVerificationOutput } from './lib/verification-output.mjs';
import { readFileSync } from 'node:fs';
import { nativeVerificationContract } from './lib/native-verification-contract.mjs';

try {
  const [artifactDir, hash, phase, contractFile] = process.argv.slice(2);
  if (!artifactDir) throw new Error('usage: node prepare-verification.mjs <artifactDir> <identityHash>');
  const contract = contractFile ? nativeVerificationContract({ ...JSON.parse(readFileSync(contractFile, 'utf8')), artifactDir }) : {};
  console.log(JSON.stringify({ ...prepareVerificationOutput(artifactDir, hash, phase), ...contract }));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
