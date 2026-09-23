// KI-E182 (2026-09-18) — deterministic test-count-claim linter for doc/ledger prose, mirroring
// doclint.mjs's phantom-path linter (KI-E11) exactly, but for "N/M passed"-style test-count claims
// instead of file-path claims. Live incident: during EGS-4-3's direct recovery, a fixer round
// added a new test (changing a suite's real count from 2257/2282 to 2258/2283) but left the OLD
// count standing in 3 prose locations (STANDARDS-DIVERGENCE-LEDGER.md, VERIFICATION-REPORT.md x2) —
// caught only by a fresh, expensive gate-developer re-dispatch, not for free. This lint catches the
// SAME class mechanically: any "N/M passed" claim in ADDED .md lines must match a REAL
// `Passed!|Failed! ... Failed: F, Passed: P, ..., Total: T` summary line (or the keyed
// `FACTORY::SUMMARY::suite ... passed=P ...` marker) actually present in the item's OWN
// explicitly selected current evidence transcripts — the exact machine-authoritative source
// build-test.sh's own `suite` subcommand already produces. A claim with no matching evidence entry
// is flagged; this does NOT judge whether the NUMBER is "good", only whether it is REAL.
//
// Deliberately narrower than a general fact-checker: it verifies arithmetic/evidence correspondence
// for ONE well-evidenced failure shape (a stale or invented pass-count), not qualitative claims
// about what a test proves (that remains the review band's job — see KI-E181's retry-prompt fix for
// the sibling "my own fix mischaracterized the code" failure mode, which this lint does not cover).
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeTranscript } from './verify.mjs';
import { classifyArtifact, verificationArtifactName } from './artifacts.mjs';

// "N/M" immediately followed by whitespace + "passed" (the shape every real incident used:
// "23/23 passed", "2258/2283 passed") OR "N/M" followed later on the SAME line by "passed"
// somewhere (the shape "(2258/2283, 25 Docker-gated pre-existing)" needs — the checklist prose
// splits the ratio from the word with a trailing clause). Captured separately so the caller can
// require N <= M (a "passed out of total" ratio is never backwards) without re-parsing.
const RATIO_RE = /\b(\d{1,7})\s*\/\s*(\d{1,7})\b/g;

// Ported pattern from doclint.mjs's NOT_YET_EXISTS_RE: a line HONESTLY citing a SUPERSEDED count
// for historical context ("2258/2283 passed (was 2257/2282; +1 from the new test)") must not be
// flagged — the whole point of such a line is to correctly distinguish the old count from the
// current one, the opposite of the stale-claim-presented-as-current class this linter exists to
// catch. Deliberately line-granular, same as its sibling: a genuine stale claim on a DIFFERENT line
// in the same diff still catches; only the line that itself narrates the history is skipped.
const HISTORICAL_RE = /\bwas\b|\bpreviously\b|\bup from\b|\bdown from\b|\bincreased from\b|\bdecreased from\b|\bchanged from\b|\bold(?:er)? count\b|\bbefore (?:this|the) (?:fix|recovery|change)\b/i;

export function extractCountClaims(line) {
  const s = String(line || '');
  if (!/\bpassed\b/i.test(s)) return []; // KI-E182: only lines that actually claim a pass-count at all
  if (HISTORICAL_RE.test(s)) return []; // the line itself honestly narrates a superseded count
  const out = [];
  for (const m of s.matchAll(RATIO_RE)) {
    const passed = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    if (!(passed <= total)) continue; // a backwards ratio is never a pass-count claim (date, version, etc.)
    out.push({ passed, total, text: m[0] });
  }
  return out;
}

// Every real "Passed!/Failed! ... Failed: F, Passed: P, ..., Total: T" dotnet-test summary line
// (the SAME shape build-test.sh's own `suite`/`filter`/`red` subcommands already emit and tee),
// PLUS the keyed `FACTORY::SUMMARY::suite exit=.. failed=F passed=P skipped=S ..` marker — either
// is machine-authoritative; a transcript may carry many (one per dotnet invocation), not just one.
const DOTNET_SUMMARY_RE = /(?:Passed!|Failed!)[^\n]*?Failed:\s*(\d+),\s*Passed:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?(?:,\s*Total:\s*(\d+))?/g;
const KEYED_SUMMARY_RE = /FACTORY::SUMMARY::suite\s+exit=-?\d+\s+failed=(-?\d+)\s+passed=(-?\d+)(?:\s+skipped=(-?\d+))?/g;

// Pure core: every distinct {passed, total} pair actually evidenced in one transcript's text.
export function extractEvidencePairs(text) {
  const pairs = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(DOTNET_SUMMARY_RE)) {
    const failed = parseInt(m[1], 10), passed = parseInt(m[2], 10), skipped = m[3] ? parseInt(m[3], 10) : 0;
    const total = m[4] ? parseInt(m[4], 10) : failed + passed + skipped;
    if (Number.isFinite(passed) && Number.isFinite(total)) pairs.add(passed + '/' + total);
  }
  for (const m of s.matchAll(KEYED_SUMMARY_RE)) {
    const failed = parseInt(m[1], 10), passed = parseInt(m[2], 10), skipped = m[3] ? parseInt(m[3], 10) : 0;
    if (Number.isFinite(passed) && passed >= 0 && failed >= 0 && skipped >= 0) pairs.add(passed + '/' + (passed + failed + skipped));
  }
  return pairs;
}

// Pure core (selftest-covered): claims from added lines whose {passed,total} matches NO evidenced
// pair. `evidencePairs` is a Set of "P/T" strings (see extractEvidencePairs) — a caller with
// multiple transcripts unions their pair-sets before calling this.
export function findUnevidencedCountClaims(addedLines, evidencePairs, cap = 10) {
  const missing = [];
  const seen = new Set();
  for (const line of addedLines || []) {
    for (const claim of extractCountClaims(line)) {
      const key = claim.passed + '/' + claim.total;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!evidencePairs.has(key)) { missing.push(claim.text); if (missing.length >= cap) return missing; }
    }
  }
  return missing;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => relative(resolve(a), resolve(b)) === '';
function containedFile(root, path) {
  const inside = (base, file) => {
    const rel = relative(base, file);
    if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('path outside allowed directory: ' + path);
  };
  inside(resolve(root), resolve(path));
  const physical = realpathSync(path);
  inside(realpathSync(root), physical);
  if (!statSync(physical).isFile()) throw new Error('not a regular file: ' + path);
  return physical;
}

// The caller supplies the current trusted claim and checkpoint, never a directory-wide history.
// Explicit refs are a caller-owned selection; when a checkpoint is supplied they must be an exact
// subset of its current contract. A stale checkpoint cannot select legacy evidence by omission.
export function resolveCountClaimTranscripts({ itemDir, transcripts, progress, claim, legacy = false, noActiveContract = false, repoRoot } = {}) {
  const fail = reason => ({ status: 'unavailable', reason, references: [] });
  const missing = reason => ({ status: 'missing-evidence', reason, references: [] });
  try {
    if (!itemDir) return missing('item artifact directory not supplied');
    const p = progress?.res ? { ...progress.res, ...progress } : progress;
    const identity = claim?.attemptIdentity || claim;
    const active = !!(p || identity);
    if (legacy && (!noActiveContract || active)) return fail('legacy fallback requires explicit no-active-contract and no claim/checkpoint');
    if (identity && !p) return fail('current claim requires its checkpoint transcript contract');
    if (p && (!identity || !identity.runId || !identity.claimId || !Number.isSafeInteger(identity.attemptNumber))) return fail('checkpoint requires trusted current claim identity');
    if (p && ((p.id || p.itemId) !== (claim.id || identity.itemId)
      || p.runId !== identity.runId || p.claimId !== identity.claimId || p.attemptNumber !== identity.attemptNumber)) return fail('checkpoint does not match current item/run/claim/attempt');
    const since = identity ? Date.parse(identity.reservedAt || identity.startedAt || identity.claimAt) : null;
    if (identity && !Number.isFinite(since)) return fail('current claim timestamp unavailable');
    const pathFor = ref => {
      if (typeof ref !== 'string' || !ref) throw new Error('invalid transcript reference');
      return isAbsolute(ref) ? resolve(ref) : resolve(repoRoot && /[\\/]/.test(ref) ? repoRoot : itemDir, ref);
    };
    let allowed;
    const add = (ref, hash) => {
      if (hash !== undefined && !/^[0-9a-f]{64}$/.test(hash)) throw new Error('malformed transcript hash');
      allowed.push({ path: pathFor(ref), ...(hash ? { sha256: hash } : {}) });
    };
    if (p) {
      allowed = [];
      if (p.initialVerification || p.finalVerification || p.integrationVerification || Object.hasOwn(p, 'nativeEvidenceVersion')
        || p.evidenceIdentity?.request || p.runtime === 'native' || p.runtime === 'claude-workflow') {
        if (Object.hasOwn(p, 'nativeEvidenceVersion') && p.nativeEvidenceVersion !== 1) return fail('unsupported native evidence version');
        const passId = String(identity.runId).replace(/[^A-Za-z0-9._-]/g, '_') + '-' + String(identity.claimId).replace(/[^A-Za-z0-9._-]/g, '_');
        const initial = p.initialVerification, final = p.finalVerification, integration = p.integrationVerification;
        if (!initial || initial.passId !== passId || basename(pathFor(initial.transcript)) !== verificationArtifactName('initial', passId)) return fail('native initial reference does not match current claim');
        const selected = final || initial;
        if (final && (final.refreshed !== true || typeof final.codeChanged !== 'boolean' || !/^[0-9a-f]{64}$/.test(final.evidenceHash)
          || final.evidenceHash !== p.evidenceIdentity?.hash
          || (final.codeChanged ? basename(pathFor(final.transcript)) !== verificationArtifactName('final', final.evidenceHash)
            : !samePath(pathFor(final.transcript), pathFor(initial.transcript))))) return fail('native final reference mismatch');
        const requested = p.evidenceIdentity?.request?.verificationTranscript;
        if (requested && !samePath(pathFor(requested), pathFor(selected.transcript))) return fail('native request transcript mismatch');
        add(selected.transcript);
        if (integration) {
          if (integration.passId !== passId || basename(pathFor(integration.transcript)) !== verificationArtifactName('integrate', passId)) return fail('native integration reference does not match current claim');
          add(integration.transcript);
        }
      } else if (p.portableEvidence && !p.evidence) {
        const e = p.portableEvidence;
        if (e.version !== 1 || e.runtime !== 'opencode' || e.runId !== identity.runId || e.claimId !== identity.claimId
          || e.attemptNumber !== identity.attemptNumber || !e.identity?.hash) return fail('portable evidence claim mismatch');
        for (const [kind, name] of [['verification', 'verify-raw.txt'], ['integration', 'integrate-raw.txt']]) {
          const proof = e[kind];
          if (kind === 'integration' && !proof) continue;
          if (!proof?.complete || proof.identityHash !== e.identity.hash || proof.transcript !== name || !proof.rawHash) return fail('portable ' + kind + ' contract incomplete');
          add(proof.transcript, proof.rawHash);
        }
      } else if (p.evidence) {
        if (!p.evidence.complete || !p.content?.hash || p.evidence.hash !== p.content.hash || !p.evidence.rawHash) return fail('OpenCode current verification contract incomplete');
        add('verify-raw.txt', p.evidence.rawHash);
        if (p.integrationEvidence) {
          if (!p.integrationEvidence.complete || p.integrationEvidence.hash !== p.content.hash || !p.integrationEvidence.rawHash) return fail('OpenCode current integration contract incomplete');
          add('integrate-raw.txt', p.integrationEvidence.rawHash);
        }
      } else return missing('active checkpoint has no current transcript contract');
    }
    let references;
    if (transcripts !== undefined) {
      if (!Array.isArray(transcripts)) return fail('transcripts must be explicit references');
      references = transcripts.map(ref => {
        const path = pathFor(typeof ref === 'string' ? ref : ref?.path);
        const match = allowed?.find(a => samePath(a.path, path));
        if (allowed && !match) throw new Error('transcript is not in current checkpoint contract: ' + path);
        const hash = typeof ref === 'object' ? ref.sha256 : undefined;
        if (hash !== undefined && !/^[0-9a-f]{64}$/.test(hash)) throw new Error('malformed explicit transcript hash');
        if (match?.sha256 && hash && match.sha256 !== hash) throw new Error('explicit transcript hash disagrees with checkpoint');
        return { path, ...(hash ? { sha256: hash } : {}), ...match };
      });
    } else if (allowed) references = allowed;
    else if (legacy) references = ['verify-raw.txt', 'integrate-raw.txt'].map(n => ({ path: pathFor(n), optional: true }));
    else return missing('explicit current transcript references required');
    if (!references.length) return missing('no current transcript references');
    for (const ref of references) {
      const artifact = classifyArtifact(basename(ref.path));
      const name = basename(ref.path);
      if (!artifact.canonical || ['archive', 'control'].includes(artifact.kind)
        || !/^(?:verify-(?!red-raw\.txt$).+|integrate-raw)\.txt$/.test(name)) return fail('not a current machine transcript: ' + ref.path);
      if (since !== null) ref.sinceMs = since;
    }
    return { status: 'ready', references, legacy };
  } catch (e) { return fail(e.message); }
}

export function lintItemCountClaims(worktree, itemDir, options = {}, deps = {}) {
  if (typeof options === 'number') options = { cap: options };
  const report = { version: 1, status: 'unavailable', missing: [], sources: [], errors: [], evidenceStatus: 'unavailable' };
  const command = deps.execFileSync || execFileSync;
  try {
    const diff = command('git', ['-C', worktree, 'diff', 'HEAD', '--unified=0', '--', '*.md'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const added = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
    const untracked = command('git', ['-C', worktree, 'ls-files', '-z', '--others', '--exclude-standard', '--', '*.md'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const f of untracked) {
      if (!/\.md$/i.test(f)) throw new Error('unexpected untracked Markdown path: ' + f);
      added.push(...decodeTranscript(readFileSync(containedFile(worktree, resolve(worktree, f)))).split('\n'));
    }
    const selection = resolveCountClaimTranscripts({ ...options, itemDir });
    if (selection.status !== 'ready') return { ...report, status: selection.status, evidenceStatus: selection.status, errors: [selection.reason] };
    const evidencePairs = new Set();
    for (const ref of selection.references) {
      try {
        const path = containedFile(itemDir, ref.path);
        if (ref.sinceMs !== undefined && statSync(path).mtimeMs < ref.sinceMs) throw new Error('transcript predates current claim: ' + ref.path);
        const bytes = readFileSync(path);
        if (ref.sha256 && sha256(bytes) !== ref.sha256) throw new Error('transcript hash mismatch: ' + ref.path);
        const pairs = extractEvidencePairs(decodeTranscript(bytes));
        report.sources.push({ path: ref.path, sha256: sha256(bytes), pairs: [...pairs] });
        for (const pair of pairs) evidencePairs.add(pair);
      } catch (e) {
        if (e.code === 'ENOENT' && ref.optional) continue;
        report.errors.push(e.message);
        report.evidenceStatus = e.code === 'ENOENT' && report.evidenceStatus !== 'unavailable-error' ? 'missing-evidence' : 'unavailable-error';
      }
    }
    if (report.errors.length) return { ...report, status: report.evidenceStatus === 'missing-evidence' ? 'missing-evidence' : 'unavailable', evidenceStatus: report.evidenceStatus === 'missing-evidence' ? 'missing-evidence' : 'unavailable' };
    if (!evidencePairs.size) return { ...report, status: 'missing-evidence', evidenceStatus: 'missing-evidence', errors: ['selected transcripts contain no machine test counts'] };
    report.missing = findUnevidencedCountClaims(added, evidencePairs, options.cap || 10);
    return { ...report, status: report.missing.length ? 'mismatch' : 'clean', evidenceStatus: 'available' };
  } catch (e) { return { ...report, errors: [e.message] }; }
}
