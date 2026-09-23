import { readFileSync } from 'node:fs';
import { artifactToolDecision, assertArtifactTree, assertRegularPath } from './lib/native-artifact-guard.mjs';

try {
  const [mode, path, ...extra] = process.argv.slice(2);
  if (extra.length || !path || !['--hook', '--scan'].includes(mode)) throw new Error('usage: artifact-guard.mjs --hook <trusted-policy.json> | --scan <artifactDir>');
  if (mode === '--scan') { assertArtifactTree(path); console.log(JSON.stringify({ clean: true })); }
  else {
    const policy = JSON.parse(readFileSync(assertRegularPath(path), 'utf8'));
    console.log(JSON.stringify(artifactToolDecision(JSON.parse(readFileSync(0, 'utf8')), policy)));
  }
} catch (error) { console.error(error.message); process.exitCode = 2; }
