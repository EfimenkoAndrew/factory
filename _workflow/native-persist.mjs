import { persistNativeCheckpoint } from './lib/native-persistence.mjs';

try {
  const [artifactDir, input, flag, digest, ...extra] = process.argv.slice(2);
  if (!artifactDir || !input || flag !== '--expected-request' || extra.length) throw new Error('usage: native-persist.mjs <artifactDir> <checkpoint-input.json> --expected-request <sha256>');
  console.log(JSON.stringify(persistNativeCheckpoint(artifactDir, input, digest)));
} catch (error) { console.error(error.message); process.exitCode = 1; }
