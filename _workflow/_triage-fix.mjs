// One-off triage correction for the pilot: the normalizer over-escalated SEARCH-FIND-H7
// (an EmbeddingDimensionGuard boot-guard hardening + test) to autonomyTier=escalate. The
// blast-radius escalate rule (factory.config.json blastRadius.escalateThemes) is for
// auth/money/crypto/cross-service FUND-or-CREDENTIAL paths; a Postgres dimension-probe guard
// is none of those. Correct it to `auto` so the pilot can drive a genuinely non-trivial item
// fully autonomously to CLOSED. This is the triager's call (documented here, not silent).
// SEARCH-FIND-C1 (monetised ranking boost, CRITICAL) is LEFT escalate on purpose — it
// exercises the human-sign-off path.
import { readFileSync, writeFileSync } from 'node:fs';
const p = '_bmad-output/ai-factory/state/normalized/ExampleService.json';
const a = JSON.parse(readFileSync(p, 'utf8'));
let changed = 0;
for (const w of a) {
  if (w.id === 'SEARCH-FIND-H7' && w.autonomyTier !== 'auto') {
    w.autonomyTier = 'auto';
    w._triageNote = 'tier corrected escalate->auto: boot-guard hardening is not an auth/money/crypto/cross-service blast-radius path';
    changed++;
  }
}
writeFileSync(p, JSON.stringify(a, null, 2) + '\n');
console.log('triage-fix: updated', changed, 'item(s) (SEARCH-FIND-H7 -> auto)');
