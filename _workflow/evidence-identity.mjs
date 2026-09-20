import { readFileSync } from 'node:fs';
import { collectEvidenceIdentity } from './lib/evidence-identity.mjs';

try {
  const [worktree, input] = process.argv.slice(2);
  if (!worktree || !input) throw new Error('usage: node evidence-identity.mjs <worktree> <metadata.json>');
  const metadata = JSON.parse(readFileSync(input, 'utf8'));
  console.log(JSON.stringify(collectEvidenceIdentity(worktree, metadata)));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
