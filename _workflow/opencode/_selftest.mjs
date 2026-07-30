// tools/ai-factory/_workflow/opencode/_selftest.mjs
//
// OPENCODE ADAPTER (KI-O1) self-test — mirrors the parent repo's own `_workflow/lib/_selftest.mjs`
// convention. Exercises the pure modules (schemas/routing/compose) directly, drives the runtime.mjs
// CLI end-to-end against synthetic --fixture items (see selftest-fixture*.json), and pins the pure
// lifecycle helpers IN-PROCESS (runtime.mjs guards its CLI entry point, so importing it runs no
// command) — zero real agent calls, zero real product code touched, zero git mutations.
//
// Run: node tools/ai-factory/_workflow/opencode/_selftest.mjs

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, validateNamed, PLAN_SCHEMA } from './schemas.mjs';
import * as schemasMod from './schemas.mjs';
import { bandFor, flowsFor, routesFor, needsRealInfra, gateRolesFor, realInfraLikely } from './routing.mjs';
import { compose } from './compose.mjs';
import { extractJson, lastMarkerCount, defaultCycleFor, runCommentGate, effectiveBaselineFor, applyPhaseResults, planNext } from './runtime.mjs';
import { parseVerifyRaw, verdictFromParse, effectiveBaseline } from './buildtest.mjs';
import { loadPolicies, POLICY_TEXT } from '../lib/policy.mjs';
import { PROFILE_CAP } from '../lib/promptpack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, 'runtime.mjs');
const FIXTURE = join(HERE, 'selftest-fixture.json');
const FACTORY_ROOT = join(HERE, '..', '..');
const SELFTEST_ITEM_DIR = join(FACTORY_ROOT, 'state', 'items', 'SELFTEST-ITEM');

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL: ' + msg); } }
function run(args) {
  try {
    return { code: 0, out: execFileSync('node', [RUNTIME, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
function tmpJson(obj) {
  const p = join(mkdtempSync(join(tmpdir(), 'oc-adapter-')), 'payload.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function itemsDirOf(id) { return join(FACTORY_ROOT, 'state', 'items', id); }
function progressFileOf(id) { return join(itemsDirOf(id), 'opencode-progress.json'); }
function surgery(id, mutate) {
  const p = progressFileOf(id);
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  mutate(obj);
  writeFileSync(p, JSON.stringify(obj, null, 2));
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === 'object') {
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join('\u0000') !== kb.join('\u0000')) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
// Minimal in-memory progress skeleton for in-process applyPhaseResults/planNext pins (the same shape
// cmdInit persists; ctx.factoryRoot points at a throwaway tmp dir so writeArtifact lands in tmp).
function mkProgress(id, item, over = {}) {
  const artRoot = mkdtempSync(join(tmpdir(), 'oc-inproc-')).replace(/\\/g, '/');
  const band = over.band || bandFor(item);
  return {
    id, item,
    ctx: { repoRoot: 'C:/fake/repo', worktreePath: 'C:/fake/host/worktree', factoryRoot: artRoot, templatesDir: join(FACTORY_ROOT, 'agents').replace(/\\/g, '/') },
    cycle: 1, band,
    res: { id, resultId: id + '#1', attemptsDelta: 1, transitions: [], toState: 'FAILED', band, artifacts: {}, gates: {}, gateDetails: {}, cost: {}, worktree: 'C:/fake/host/worktree', branch: 'fixture', note: '', codeChange: true, needsRealInfra: false, rootCauseFiles: [] },
    phase: 'gates', verificationOnly: null, pending: null, pendingSet: null, edgeFinal: null, reFix: false,
    initAtMs: Date.now(), checkpointed: false, history: [],
    ...over,
  };
}
const GATE_OK = (g) => ({ gate: g, verdict: 'APPROVED', headline: 'clean' });
function gatesPendingSet(received) {
  return { phaseKey: 'gates', keys: Object.keys(received), received, calls: Object.keys(received).map((k) => ({ role: k, key: k, extra: null })) };
}

console.log('=== pure module tests ===');
{
  const v1 = validate(PLAN_SCHEMA, { rootCause: 'x', approach: 'y', recommendScopeStop: false, recommendEscalate: false });
  assert(v1.ok, 'PLAN_SCHEMA accepts a minimal valid plan: ' + JSON.stringify(v1));
  const v2 = validate(PLAN_SCHEMA, { rootCause: 'x' });
  assert(!v2.ok && v2.errors.some((e) => e.includes('approach')), 'PLAN_SCHEMA rejects missing required fields');
  const v3 = validate(PLAN_SCHEMA, { rootCause: 'x', approach: 'y', recommendScopeStop: false, recommendEscalate: false, bogus: 1 });
  assert(!v3.ok && v3.errors.some((e) => e.includes('bogus')), 'PLAN_SCHEMA rejects additional properties');
  const v4 = validateNamed('GATE_SCHEMA', { gate: 'developer', verdict: 'MAYBE', headline: 'h' });
  assert(!v4.ok && v4.errors.some((e) => e.includes('enum')), 'GATE_SCHEMA enforces verdict enum');
}
{
  const light = { theme: 'test-coverage', fixType: 'mechanical' };
  const full = { theme: 'idempotency-dataflow', fixType: 'non-trivial' };
  assert(bandFor(light) === 'LIGHT', 'bandFor: mechanical/test-coverage -> LIGHT');
  assert(bandFor(full) === 'FULL', 'bandFor: idempotency-dataflow theme forces FULL regardless of fixType');
  assert(needsRealInfra(full, true) === true || needsRealInfra(full, true) === false, 'needsRealInfra returns a boolean'); // theme alone isn't realInfra; just shape-check
  const flows = flowsFor({ files: ['a.cs'] });
  assert(flows.some((f) => f.routeKey === 'review.edgecase'), 'flowsFor: a .cs-touching item includes the edge-case flow');
  assert(!flows.some((f) => f.band === 'editorial'), 'flowsFor: a non-doc item has no editorial flows');
  const routes = routesFor({ fixType: 'mechanical', files: ['a.cs'] });
  assert(routes.planner === null, 'routesFor: mechanical fixType skips the planner route');
  // Real-world dry-run gap closed: FULL band must run all 5 role gates (architect/security/po
  // included); LIGHT drops to developer+qa only. Never exercised via the state machine directly
  // in the earlier fixture runs (all used LIGHT items) — validated live against a FULL+realInfra
  // fixture separately; this pins the pure selection logic permanently.
  const fullGates = gateRolesFor({}, 'FULL', null);
  assert(JSON.stringify(fullGates.slice().sort()) === JSON.stringify(['architect', 'developer', 'po', 'qa', 'security'].sort()), 'gateRolesFor: FULL band runs all 5 role gates: ' + JSON.stringify(fullGates));
  const lightGates = gateRolesFor({}, 'LIGHT', null);
  assert(JSON.stringify(lightGates) === JSON.stringify(['developer', 'qa']), 'gateRolesFor: LIGHT band drops to developer+qa only: ' + JSON.stringify(lightGates));
}
{
  // Fix #5 — realInfraLikely parity with factory.js (lowercased haystack + `!item.realInfra` pureCoverage).
  assert(realInfraLikely({ title: 'Race condition in payment settlement', theme: 'money-correctness', acceptance: '', regressionTest: '', fixHint: '' }) === true,
    'realInfraLikely: capitalized "Race condition" text trips the keyword floor (haystack lowercased like factory.js)');
  assert(realInfraLikely({ title: 'Add deadlock coverage tests for the queue processor', theme: 'test-coverage' }) === false,
    'realInfraLikely: a test-coverage item with realInfra ABSENT is pure coverage — "deadlock" in its coverage-subject text must NOT re-open the KI-L39 false-fail class');
  assert(realInfraLikely({ title: 'deadlock coverage', theme: 'test-coverage', realInfra: true }) === true,
    'realInfraLikely: a coverage item the normalizer flagged realInfra=true keeps the requirement');
  assert(realInfraLikely({ title: 'Wrong sum in report', theme: 'money-correctness' }) === false,
    'realInfraLikely: no flag + no keyword -> false (pure query-logic bugs stay in-memory-provable)');
}
{
  // Fix #2 — resultId cycle stamp: canonical is ledger.cycle + 1 (driver.mjs cmdSelect/cmdGroup).
  assert(defaultCycleFor(4, undefined) === 5, 'defaultCycleFor: no --cycle flag -> ledger.cycle + 1 (driver group parity; bare ledger.cycle minted an already-folded resultId on re-fix)');
  assert(defaultCycleFor(4, '2') === 2, 'defaultCycleFor: an explicit --cycle override still wins');
}
{
  // Fix #11 — extractJson takes the LAST fenced block that parses (agents quote example JSON early).
  assert(deepEqual(extractJson('reasoning ```json\n{"a":1}\n``` more ```json\n{"b":2}\n``` done'), { b: 2 }),
    'extractJson: LAST parseable fence wins (a quoted example before the real final answer is ignored)');
  assert(deepEqual(extractJson('```json\nnot json {{{\n``` prose ```json\n{"ok":true}\n```'), { ok: true }),
    'extractJson: an unparseable early fence never poisons the result');
  assert(deepEqual(extractJson('```json\n{"ok":1}\n``` trailing ```\nplain prose, not json\n```'), { ok: 1 }),
    'extractJson: a non-JSON trailing fence falls back to the nearest earlier parseable fence');
  assert(deepEqual(extractJson('  {"bare":3} '), { bare: 3 }), 'extractJson: bare unfenced JSON still parses');
}
{
  // Fix #9 — anchored multiline LAST-match marker parsing + the embedded-literal defeat case.
  const defeat = 'FACTORY::LEFTOVER-HIT::a.cs::TODO::// docs mention FACTORY::LEFTOVER::0 explicitly\nFACTORY::LEFTOVER::3\n';
  assert(lastMarkerCount(defeat, 'LEFTOVER') === 3,
    'lastMarkerCount: a hit line QUOTING the literal cannot defeat the count (anchored ^...$; unanchored first-match read 0 here)');
  assert(lastMarkerCount('FACTORY::LEFTOVER::2\nretry...\nFACTORY::LEFTOVER::0\n', 'LEFTOVER') === 0,
    'lastMarkerCount: LAST occurrence is authoritative (retry semantics, mirrors lib/verify.mjs lastMatch)');
  assert(lastMarkerCount('FACTORY::COMMENT::4\r\n', 'COMMENT') === 4, 'lastMarkerCount: CRLF line endings accepted');
  assert(lastMarkerCount('usage: build-test.sh leftovers <worktree>', 'LEFTOVER') === null,
    'lastMarkerCount: NO marker (spawn/usage failure) -> null, never a silent 0/clean');
}
{
  // Fix #10 — policy-gated mechanical comment gate (injectable scanner; no git needed).
  let called = 0;
  const offRes = runCommentGate('/tmp/nowhere', { noNewComments: false }, () => { called++; return []; });
  assert(offRes.skipped === true && called === 0, 'runCommentGate: policy OFF -> skipped entirely, scanner never invoked');
  const hitRes = runCommentGate('/tmp/nowhere', { noNewComments: true }, () => [{ file: 'a.cs', kind: 'line', line: '// new comment' }]);
  assert(hitRes.count === 1 && hitRes.hits[0].file === 'a.cs' && !hitRes.unavailable, 'runCommentGate: policy ON + a hit -> count=1 (the caller FAILs the item)');
  const cleanRes = runCommentGate('/tmp/nowhere', { noNewComments: true }, () => []);
  assert(cleanRes.count === 0 && !cleanRes.unavailable && !cleanRes.skipped, 'runCommentGate: policy ON + zero hits -> count=0 (APPROVED)');
  const throwRes = runCommentGate('/tmp/nowhere', { noNewComments: true }, () => { throw new Error('git exploded'); });
  assert(throwRes.unavailable === true && /git exploded/.test(throwRes.error), 'runCommentGate: a THROWING scan -> GATE-UNAVAILABLE (caller records NO gate verdict — never APPROVED, never a fold-visible fail)');
}
{
  // Fix #12 — KI-E43 effective-baseline: the integrate/verify verdict baseline comes from the
  // RECORDED pre-fix baseline (baseline-raw.txt / reported array), NEVER the run's own parse.
  const d1 = mkdtempSync(join(tmpdir(), 'oc-basel-'));
  writeFileSync(join(d1, 'baseline-raw.txt'), 'FACTORY::SUMMARY::suite exit=1 failed=6 passed=100 skipped=0\n');
  const pDisk = mkProgress('SELFTEST-INPROC-BL', { files: ['a.cs'], theme: 'x', severity: 'HIGH' });
  pDisk.res.baselineFailures = [];
  const rDisk = effectiveBaselineFor(pDisk, d1);
  assert(rDisk.baseline === 6 && rDisk.fromDisk === true, 'effectiveBaselineFor: pre-fix baseline-raw.txt transcript counts (6) even when the run-reported array is empty (driver fold parity, cycle-47 ITEM-H15 class)');
  const d2 = mkdtempSync(join(tmpdir(), 'oc-basel-'));
  const pRep = mkProgress('SELFTEST-INPROC-BL2', { files: ['a.cs'], theme: 'x', severity: 'HIGH' });
  pRep.res.baselineFailures = ['T1', 'T2'];
  const rRep = effectiveBaselineFor(pRep, d2);
  assert(rRep.baseline === 2 && rRep.fromDisk === false, 'effectiveBaselineFor: no transcript -> run-reported array only');
  // reFix fence: a baseline (re)captured DURING this attempt is distrusted.
  const d3 = mkdtempSync(join(tmpdir(), 'oc-basel-'));
  writeFileSync(join(d3, 'baseline-raw.txt'), 'FACTORY::SUMMARY::suite exit=1 failed=6 passed=100 skipped=0\n');
  const pFence = mkProgress('SELFTEST-INPROC-BL3', { files: ['a.cs'], theme: 'x', severity: 'HIGH' });
  pFence.reFix = true; pFence.initAtMs = Date.now() - 3600 * 1000; pFence.res.baselineFailures = ['T1'];
  const rFence = effectiveBaselineFor(pFence, d3);
  assert(rFence.baseline === 1 && rFence.ignoredReFixRecapture === true, 'effectiveBaselineFor: reFix fence — a transcript younger than this attempt is IGNORED (would launder the prior fix\'s breakage)');
  const pOld = mkProgress('SELFTEST-INPROC-BL4', { files: ['a.cs'], theme: 'x', severity: 'HIGH' });
  pOld.reFix = true; pOld.initAtMs = Date.now() + 3600 * 1000; pOld.res.baselineFailures = [];
  const rOld = effectiveBaselineFor(pOld, d3);
  assert(rOld.baseline === 6 && rOld.fromDisk === true, 'effectiveBaselineFor: reFix with a FIRST-round (pre-attempt) transcript keeps it');
  // The self-feed regression itself: an integrate transcript with 3 suite failures and NO recorded
  // baseline must FAIL — the old code fed the integrate parse in as its own baseline (3-3=0) and
  // could structurally never report a suite regression.
  const integParse = parseVerifyRaw('FACTORY::SUMMARY::build exit=0 errors=0\nFACTORY::SUMMARY::suite exit=1 failed=3 passed=50 skipped=0\n');
  const honest = verdictFromParse(integParse, effectiveBaselineFor(pRep, mkdtempSync(join(tmpdir(), 'oc-basel-'))).baseline);
  assert(honest.pass === false, 'integrate verdict: 3 new suite failures beyond a 2-strong recorded baseline FAILS honestly');
  const selfFed = verdictFromParse(integParse, effectiveBaseline([], integParse));
  assert(selfFed.pass === true, '(defeat demo) feeding the integrate run\'s OWN parse as baseline reads every regression as pre-existing — exactly the bug fix #12 removes');
}
{
  // Fix #20 — mechanical schema-parity: extract every `const <NAME>_SCHEMA = {...}` object literal
  // from factory.js source (brace-scan + safe eval; factory.js is not importable) and deep-equal it
  // against the same-named schemas.mjs export. COMMENT_SCHEMA is the ONLY sanctioned one-sided schema.
  const factorySrc = readFileSync(join(FACTORY_ROOT, '_workflow', 'factory.js'), 'utf8');
  function readObjectLiteral(src, startIdx) {
    let depth = 0, inStr = null;
    for (let i = startIdx; i < src.length; i++) {
      const c = src[i];
      if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1); }
    }
    return null;
  }
  function grabConst(name) {
    const m = new RegExp('const\\s+' + name + '\\s*=\\s*').exec(factorySrc);
    if (!m) return null;
    return readObjectLiteral(factorySrc, factorySrc.indexOf('{', m.index));
  }
  const FINDING_F = new Function('return (' + grabConst('FINDING') + ')')();
  const STRARR_F = new Function('return (' + grabConst('STRARR') + ')')();
  const factoryNames = [...new Set([...factorySrc.matchAll(/const\s+([A-Z][A-Za-z0-9_]*_SCHEMA)\s*=/g)].map((m) => m[1]))];
  assert(factoryNames.length >= 15, 'schema-parity: extractor finds the factory.js schema consts (' + factoryNames.length + ')');
  const portNames = Object.keys(schemasMod).filter((k) => /_SCHEMA$/.test(k));
  const ALLOWED_ONE_SIDED = ['COMMENT_SCHEMA']; // the comment probe is agent-dispatched only in factory.js; the port's mechanical gate needs no schema
  for (const n of factoryNames) {
    if (ALLOWED_ONE_SIDED.includes(n)) continue;
    const lit = grabConst(n);
    const obj = new Function('FINDING', 'STRARR', 'return (' + lit + ')')(FINDING_F, STRARR_F);
    assert(!!schemasMod[n], 'schema-parity: schemas.mjs exports ' + n);
    assert(deepEqual(obj, schemasMod[n]), 'schema-parity: ' + n + ' is deep-equal between factory.js and schemas.mjs (mechanical drift protection)');
  }
  const factoryOnly = factoryNames.filter((n) => !portNames.includes(n));
  assert(deepEqual(factoryOnly.sort(), ALLOWED_ONE_SIDED.slice().sort()), 'schema-parity: COMMENT_SCHEMA is the ONLY factory-side-only schema (got: ' + JSON.stringify(factoryOnly) + ')');
  const portOnly = portNames.filter((n) => !factoryNames.includes(n));
  assert(portOnly.length === 0, 'schema-parity: no port-only schemas exist (got: ' + JSON.stringify(portOnly) + ')');
}
{
  const ctx = { repoRoot: 'C:/fake/repo', worktreePath: 'C:/fake/wt', factoryRoot: FACTORY_ROOT.replace(/\\/g, '/'), templatesDir: join(FACTORY_ROOT, 'agents').replace(/\\/g, '/') };
  const item = { id: 'X1', target: 'T', severity: 'HIGH', fixType: 'non-trivial', autonomyTier: 'auto', title: 't', theme: 'th', realInfra: false, files: ['a.cs'], acceptance: 'acc', regressionTest: 'rt', source: 'src' };
  const prompt = compose('planner', item, null, ctx);
  assert(prompt.includes('WORK ITEM: X1'), 'compose: includes the item id');
  assert(prompt.includes('## Role: planner'), 'compose: inlines the real planner.md brief content');
  assert(prompt.includes('FINAL ANSWER FORMAT'), 'compose: appends the JSON-fence instruction');
  const probePrompt = compose('marker-probe', item, 'x', ctx);
  assert(!probePrompt.includes('YOUR ROLE BRIEF'), 'compose: -probe roles get no brief section (none exists on disk)');
  // Fix #15 — KI-D7 probe-etiquette line rides on review roles (factory.js compose parity).
  const gatePrompt = compose('gate-developer', item, null, ctx);
  assert(gatePrompt.includes('PARALLEL REVIEW STAGE — LIVE-PROBE ETIQUETTE (KI-D7)'), 'compose: review roles carry the KI-D7 parallel-review probe-etiquette line');
  assert(!prompt.includes('LIVE-PROBE ETIQUETTE'), 'compose: non-review roles (planner) do NOT carry the KI-D7 line');
}
{
  // Fix #16 — compose: HOST POLICY blocks (exact factory.js header strings), PROFILE_CAP, profile
  // for ALL roles incl. probes, exact injection label, and the #17 target-traversal guard.
  const tpl = mkdtempSync(join(tmpdir(), 'oc-tpl-')).replace(/\\/g, '/');
  mkdirSync(join(tpl, 'repo-profiles'), { recursive: true });
  writeFileSync(join(tpl, 'repo-profiles', 'SAFE.md'), 'PROFILE-FACT-ALPHA: this repo uses xUnit.');
  writeFileSync(join(tpl, 'SAFE.md'), 'LEAKED-PARENT-PROFILE'); // what a `../SAFE` traversal would reach
  writeFileSync(join(tpl, 'repo-profiles', 'BIG.md'), 'HEAD-MARK ' + 'x'.repeat(PROFILE_CAP) + ' TAIL-SENTINEL-BEYOND-CAP');
  const polRoot = mkdtempSync(join(tmpdir(), 'oc-polroot-')).replace(/\\/g, '/');
  mkdirSync(join(polRoot, 'config'), { recursive: true });
  writeFileSync(join(polRoot, 'config', 'factory.config.json'), JSON.stringify({ policies: { noNewComments: true, noSchemaChanges: true } }));
  const offRoot = mkdtempSync(join(tmpdir(), 'oc-polroot-')).replace(/\\/g, '/'); // no config -> engine defaults (both off)
  const baseItem = { id: 'X2', target: 'SAFE', severity: 'HIGH', fixType: 'non-trivial', autonomyTier: 'auto', title: 't', theme: 'th', realInfra: false, files: ['a.cs'], acceptance: 'acc', regressionTest: 'rt', source: 'src' };
  const onPrompt = compose('fixer', baseItem, null, { repoRoot: 'C:/fake/repo', worktreePath: 'C:/fake/wt', factoryRoot: polRoot, templatesDir: tpl });
  assert(onPrompt.includes('HOST POLICY — NO NEW COMMENTS (binding):'), 'compose: policies.noNewComments=on injects the exact factory.js NO NEW COMMENTS header');
  assert(onPrompt.includes('HOST POLICY — NO DB/SCHEMA CHANGES (binding):'), 'compose: policies.noSchemaChanges=on injects the exact factory.js NO DB/SCHEMA CHANGES header');
  assert(onPrompt.includes('reverted to its exact original text'), 'compose: the comments policy block carries the binding revert-to-original mandate');
  // Canonical-source parity: the injected blocks ARE lib/policy.mjs's POLICY_TEXT verbatim — the
  // same constants the driver's recover prompts push and factory.js inlines byte-identically (its
  // main-selftest pin), so the two runtimes structurally cannot drift on policy text.
  assert(onPrompt.includes(POLICY_TEXT.noNewComments) && onPrompt.includes(POLICY_TEXT.noSchemaChanges), 'compose: policy blocks are byte-identical to the canonical POLICY_TEXT constants');
  const fsrcPol = readFileSync(join(FACTORY_ROOT, '_workflow', 'factory.js'), 'utf8');
  assert(fsrcPol.includes(POLICY_TEXT.noNewComments), 'cross-runtime: factory.js carries the SAME noNewComments block text this port injects');
  const offPrompt = compose('fixer', baseItem, null, { repoRoot: 'C:/fake/repo', worktreePath: 'C:/fake/wt', factoryRoot: offRoot, templatesDir: tpl });
  // (check the exact block headers — the profile label legitimately mentions "HOST POLICY block")
  assert(!offPrompt.includes('HOST POLICY — NO NEW COMMENTS (binding):') && !offPrompt.includes('HOST POLICY — NO DB/SCHEMA CHANGES (binding):'),
    'compose: shipped-engine defaults (policies off) inject NO policy block — prompt unchanged');
  assert(offPrompt.includes('PROFILE-FACT-ALPHA'), 'compose: repo profile injected for a normal role');
  assert(offPrompt.includes('host-local overlay derived from that repo\'s own real merged PRs'), 'compose: profile injection label matches factory.js\'s exact parenthetical');
  const probeProfilePrompt = compose('marker-probe', baseItem, null, { repoRoot: 'C:/fake/repo', worktreePath: 'C:/fake/wt', factoryRoot: offRoot, templatesDir: tpl });
  assert(probeProfilePrompt.includes('PROFILE-FACT-ALPHA'), 'compose: profile injected for probe roles too (factory.js injects it for ALL roles)');
  const bigPrompt = compose('fixer', { ...baseItem, target: 'BIG' }, null, { repoRoot: 'C:/fake/repo', worktreePath: 'C:/fake/wt', factoryRoot: offRoot, templatesDir: tpl });
  assert(bigPrompt.includes('HEAD-MARK'), 'compose: oversized profile head survives');
  assert(!bigPrompt.includes('TAIL-SENTINEL-BEYOND-CAP'), 'compose: profile content capped at PROFILE_CAP (identical bound to the driver\'s readRepoProfiles)');
  // #17 — a traversal-shaped target must NOT resolve a profile outside repo-profiles/.
  const evilPrompt = compose('fixer', { ...baseItem, target: '../SAFE' }, null, { repoRoot: 'C:/fake/repo', worktreePath: 'C:/fake/wt', factoryRoot: offRoot, templatesDir: tpl });
  assert(!evilPrompt.includes('LEAKED-PARENT-PROFILE') && !evilPrompt.includes('REPO-SPECIFIC STYLE PROFILE'), 'compose: a target containing ".."/separator skips the profile lookup entirely (no traversal)');
}
{
  // Fix #1 — a standing CHANGES_REQUIRED edge-scan verdict must BLOCK at the gate band (factory.js
  // splices edgeFinal into blocking+brRes). MEDIUM severity: no adjudication -> straight FAILED.
  const p = mkProgress('SELFTEST-INPROC-EDGE1', { id: 'SELFTEST-INPROC-EDGE1', severity: 'MEDIUM', theme: 'th', title: 't', files: ['a.cs'] }, { band: 'LIGHT' });
  p.pendingSet = gatesPendingSet({ 'gate-developer': GATE_OK('developer'), 'gate-qa': GATE_OK('qa') });
  p.edgeFinal = { gate: 'edge-case-hunter', verdict: 'CHANGES_REQUIRED', headline: 'unhandled boundary', findings: [{ severity: 'HIGH', title: 'null path' }] };
  applyPhaseResults(p);
  assert(p.res.toState === 'FAILED' && p.phase === 'done', 'edge-CR blocks: all in-band gates APPROVED + standing CR edge verdict -> FAILED (was: reached CLOSED)');
  assert(/review:review-edge-case-hunter/.test(p.res.note), 'edge-CR blocks: the FAILED note names review:review-edge-case-hunter');
}
{
  // Fix #1 — HIGH severity: the standing CR edge verdict is a genuine SPLIT -> adjudication path,
  // exactly like an in-band dissent (factory.js failedBlk membership).
  const p = mkProgress('SELFTEST-INPROC-EDGE2', { id: 'SELFTEST-INPROC-EDGE2', severity: 'HIGH', theme: 'th', title: 't', files: ['a.cs'] }, { band: 'LIGHT' });
  p.pendingSet = gatesPendingSet({ 'gate-developer': GATE_OK('developer'), 'gate-qa': GATE_OK('qa') });
  p.edgeFinal = { gate: 'edge-case-hunter', verdict: 'CHANGES_REQUIRED', headline: 'unhandled boundary', findings: [{ severity: 'HIGH', title: 'race' }] };
  applyPhaseResults(p);
  assert(p.phase === 'gates_adjudicate', 'edge-CR on HIGH: split verdict routes to the adjudicator');
  assert(p._failedForRegate.length === 1 && p._failedForRegate[0].key === 'review:review-edge-case-hunter', 'edge-CR on HIGH: the edge reviewer is the dissenting entry for the P8 re-gate');
  assert(/review:review-edge-case-hunter/.test(p._adjudicateExtra) && /1 other\(s\)|2 other\(s\)/.test(p._adjudicateExtra), 'edge-CR on HIGH: adjudicator brief names the dissent and counts the edge reviewer in the band size');
  assert(typeof p._failedForRegate[0].extra === 'string' && /EARLY SCAN \(pre-band, KI-E12\)/.test(p._failedForRegate[0].extra), 'edge-CR on HIGH: the re-gate call will carry the original edge extra (factory.js b.extra parity)');
  // Complete the P8 loop: adjudicator OVERRULED -> the EDGE reviewer itself is re-gated (original
  // extra + the RE-GATE mandate), and its fresh APPROVED lets the band pass.
  p.pendingSet = { phaseKey: 'gates_adjudicate', keys: ['adjudicator'], received: { adjudicator: { verdict: 'OVERRULED', headline: 'dissent wrong on the merits' } }, calls: [{ role: 'adjudicator', key: 'adjudicator' }] };
  applyPhaseResults(p);
  assert(p.phase === 'gates_regate' && p._regateCalls.length === 1 && p._regateCalls[0].role === 'review-edgecase', 'edge-CR on HIGH: OVERRULED re-gates the edge reviewer itself');
  assert(/RE-GATE: adjudication OVERRULED/.test(p._regateCalls[0].extra) && /EARLY SCAN \(pre-band, KI-E12\)/.test(p._regateCalls[0].extra), 'edge re-gate call = original edge extra + the RE-GATE mandate (factory.js `(b.extra || ...) + RE-GATE` parity)');
  p.pendingSet = { phaseKey: 'gates_regate', keys: ['review-edgecase'], received: { 'review-edgecase': { gate: 'edge-case-hunter', verdict: 'APPROVED', headline: 'boundaries now guarded' } }, calls: p._regateCalls.map((c) => ({ ...c, key: c.role })) };
  applyPhaseResults(p);
  assert(p.phase === 'refute_reaudit' && p.res.gates['review:review-edge-case-hunter'] === 'APPROVED', 'edge re-gate APPROVED overwrites the standing verdict and the band proceeds (LIGHT -> po skipped)');
}
{
  // Fix #1 (scope parity) — an edge scopeViolation with a non-APPROVED verdict hard-stops like an
  // in-band gate's (factory.js loops scopeViolation over ALL blocking incl. the spliced edge entry).
  const p = mkProgress('SELFTEST-INPROC-EDGE3', { id: 'SELFTEST-INPROC-EDGE3', severity: 'HIGH', theme: 'th', title: 't', files: ['a.cs'] }, { band: 'LIGHT' });
  p.pendingSet = gatesPendingSet({ 'gate-developer': GATE_OK('developer'), 'gate-qa': GATE_OK('qa') });
  p.edgeFinal = { gate: 'edge-case-hunter', verdict: 'CHANGES_REQUIRED', headline: 'adds a tax column', scopeViolation: true, findings: [] };
  applyPhaseResults(p);
  assert(p.phase === 'decision_frame' && p._blockReason && /scopeViolation/.test(p._blockReason), 'edge scopeViolation + CR routes to the decision-framer (product-scope hard stop), not the adjudicator');
}
{
  // Fix #7 — the PO gate runs ONLY when the band's gateRoles include po: LIGHT skips it (straight
  // to refute_reaudit with GATED), FULL routes to the po phase. Both after a clean band.
  const pl = mkProgress('SELFTEST-INPROC-POBAND1', { id: 'SELFTEST-INPROC-POBAND1', severity: 'MEDIUM', theme: 'th', title: 't', files: ['a.cs'] }, { band: 'LIGHT' });
  pl.pendingSet = gatesPendingSet({ 'gate-developer': GATE_OK('developer'), 'gate-qa': GATE_OK('qa') });
  applyPhaseResults(pl);
  assert(pl.phase === 'refute_reaudit' && pl.res.transitions.includes('GATED'), 'PO band parity: LIGHT band skips the po phase entirely (developer+qa only) and still records GATED');
  const pf = mkProgress('SELFTEST-INPROC-POBAND2', { id: 'SELFTEST-INPROC-POBAND2', severity: 'CRITICAL', theme: 'idempotency-dataflow', title: 't', files: ['a.cs'] }, { band: 'FULL' });
  pf.pendingSet = gatesPendingSet({ 'gate-architect': GATE_OK('architect'), 'gate-developer': GATE_OK('developer'), 'gate-qa': GATE_OK('qa'), 'gate-security': GATE_OK('security') });
  applyPhaseResults(pf);
  assert(pf.phase === 'po' && !pf.res.transitions.includes('GATED'), 'PO band parity: FULL band routes to the po phase after the technical band (GATED lands after PO)');
}
{
  // Fix #8 — P10 codeChange refinement: a .cs regression test on a doc item widens codeChange.
  const p = mkProgress('SELFTEST-INPROC-P10', { id: 'SELFTEST-INPROC-P10', severity: 'MEDIUM', theme: 'doc-drift', title: 't', files: ['README.md'] }, { band: 'LIGHT', phase: 'test' });
  p.res.codeChange = false;
  p.pendingSet = { phaseKey: 'test', keys: ['test-author'], received: { 'test-author': { red: true, note: 'n', testFiles: ['src/Tests/DocGuardTests.cs'] } }, calls: [{ role: 'test-author', key: 'test-author' }] };
  applyPhaseResults(p);
  assert(p.res.codeChange === true && p.phase === 'fix', 'P10: test-author\'s .cs testFiles widen codeChange on a doc item (factory.js `filesHaveCs || testFiles.some(.cs)`)');
  const p2 = mkProgress('SELFTEST-INPROC-P10B', { id: 'SELFTEST-INPROC-P10B', severity: 'MEDIUM', theme: 'doc-drift', title: 't', files: ['README.md'] }, { band: 'LIGHT', phase: 'test' });
  p2.res.codeChange = false; p2.res.needsRealInfra = false;
  p2.pendingSet = { phaseKey: 'test', keys: ['test-author'], received: { 'test-author': { red: true, note: 'n', testFiles: ['docs/check.md'] } }, calls: [{ role: 'test-author', key: 'test-author' }] };
  applyPhaseResults(p2);
  assert(p2.res.codeChange === false, 'P10: non-.cs testFiles leave codeChange false');
}
{
  // Fix #6 — escalate check runs AFTER refute+re-audit: the parked ESCALATED result carries
  // REFUTE_OK + REAUDITED (factory.js ~958), and the terminal immediately demands a checkpoint (#13).
  const id = 'SELFTEST-INPROC-ESC';
  try { rmSync(itemsDirOf(id), { recursive: true, force: true }); } catch { /* ignore */ }
  const p = mkProgress(id, { id, severity: 'HIGH', theme: 'th', title: 't', files: ['a.cs'], autonomyTier: 'auto' }, { band: 'LIGHT', phase: 'refute_reaudit' });
  p._escalate = true; // planner recommended escalate
  p.pendingSet = { phaseKey: 'refute_reaudit', keys: ['re-auditor:code'], received: { 're-auditor:code': { converged: true, findingGone: true, headline: 'ok' } }, calls: [{ role: 're-auditor', key: 're-auditor:code', lens: 'code' }] };
  applyPhaseResults(p);
  assert(p.phase === 'escalatecheck', 'escalate position: refute_reaudit pass advances to escalatecheck (NOT integrate, NOT parked before refute)');
  const out = planNext(p);
  assert(p.res.toState === 'ESCALATED', 'escalate position: the escalate-tier park happens after REFUTE_OK/REAUDITED');
  const ti = p.res.transitions;
  assert(ti.indexOf('REFUTE_OK') >= 0 && ti.indexOf('REAUDITED') >= 0 && ti.indexOf('ESCALATED') > ti.indexOf('REAUDITED'), 'escalate position: transitions carry REFUTE_OK+REAUDITED BEFORE ESCALATED — the "fully verified" note is now true');
  assert(out && out.mechanical === 'checkpoint', 'terminal checkpoint: an ESCALATED terminal demands `mech checkpoint` (result.json) instead of reporting done');
  try { rmSync(itemsDirOf(id), { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`pure module tests: ${pass} passed, ${fail} failed`);

console.log('=== runtime.mjs CLI end-to-end (fixture, no real agent calls) ===');
try { rmSync(SELFTEST_ITEM_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

{
  // Fix #17 — id sanitization at init: traversal-shaped ids are rejected before any path join.
  for (const bad of ['../evil', 'a/b', '..', '.hidden', '_LEADING']) {
    const r = run(['init', bad, '--fixture', FIXTURE]);
    assert(r.code !== 0 && /unsafe item id/.test(r.out), `init rejects unsafe id ${JSON.stringify(bad)} loudly`);
  }
  assert(!existsSync(join(FACTORY_ROOT, 'state', 'evil')), 'init: a rejected traversal id created NO directory outside state/items/');
}
{
  const r = run(['init', 'SELFTEST-ITEM', '--fixture', FIXTURE]);
  assert(r.code === 0, 'init --fixture succeeds: ' + r.out);
  assert(r.out.includes('band=FULL') === false, 'fixture item (test-coverage, non-trivial) is NOT force-FULL by theme'); // theme=test-coverage isn't in BAND_FULL_THEMES
}
{
  const r = run(['next', 'SELFTEST-ITEM']);
  const parsed = JSON.parse(r.out);
  assert(parsed.agents && parsed.agents[0].role === 'planner', 'next after init: planner is first (non-mechanical fixType)');
  assert(parsed.agents[0].schema === 'PLAN_SCHEMA', 'next: planner call carries PLAN_SCHEMA');
}
{
  // Reject path: missing required field must NOT advance the phase.
  const bad = tmpJson({ rootCause: 'incomplete' });
  const r = run(['submit', 'SELFTEST-ITEM', '--role', 'planner', '--json', bad]);
  assert(r.code !== 0, 'submit rejects a schema-invalid payload (nonzero exit)');
  const s = run(['status', 'SELFTEST-ITEM']);
  const status = JSON.parse(s.out);
  assert(status.phase === 'plan', 'a rejected submit does NOT advance the phase');
}
{
  const plan = tmpJson({ rootCause: 'root', approach: 'approach', files: ['src/Foo.cs'], recommendScopeStop: false, recommendEscalate: false });
  const r = run(['submit', 'SELFTEST-ITEM', '--role', 'planner', '--json', plan]);
  assert(r.code === 0, 'submit accepts a valid plan: ' + r.out);
  assert(existsSync(join(SELFTEST_ITEM_DIR, 'plan.md')), 'submit writes plan.md artifact');
  const s = run(['status', 'SELFTEST-ITEM']);
  const status = JSON.parse(s.out);
  assert(status.phase === 'test', 'a valid plan submit advances phase plan -> test');
}
{
  // Fix #15 — the Test-phase brief carries the KI-E43 Docker-less baseline instruction.
  const n = run(['next', 'SELFTEST-ITEM']);
  const parsed = JSON.parse(n.out);
  assert(parsed.agents && /FULL-SUITE BASELINE \(KI-E43\)/.test(parsed.agents[0].prompt), 'test-phase brief carries the KI-E43 pre-fix full-suite baseline instruction');
  assert(/docker info/.test(parsed.agents[0].prompt) && /baseline-raw\.txt/.test(parsed.agents[0].prompt), 'KI-E43 instruction names the docker probe + the baseline-raw.txt tee path');
}
{
  const test = tmpJson({ red: true, note: 'fails on old code', testFiles: ['src/Tests/FooTests.cs'] });
  const r = run(['submit', 'SELFTEST-ITEM', '--role', 'test-author', '--json', test]);
  assert(r.code === 0, 'submit accepts a valid red-proof test result: ' + r.out);
  const s = JSON.parse(run(['status', 'SELFTEST-ITEM']).out);
  assert(s.phase === 'fix', 'red:true (non-verificationOnly) advances phase test -> fix');
  assert(s.transitions.includes('RED'), 'RED transition recorded on res.transitions');
}
{
  const fix = tmpJson({ applied: true, scopeStop: false, summary: 'applied the fix', filesChanged: ['src/Foo.cs'] });
  const r = run(['submit', 'SELFTEST-ITEM', '--role', 'fixer', '--json', fix]);
  assert(r.code === 0, 'submit accepts a valid fix result: ' + r.out);
  const s = JSON.parse(run(['status', 'SELFTEST-ITEM']).out);
  assert(s.phase === 'verify', 'applied:true advances phase fix -> verify (mechanical, fixture stops here — no real project to build)');
}
{
  // Fix #4 — a stale re-submit of a COMPLETED phase's role is rejected loudly with no state change
  // (previously accepted: it re-ran the fix phase's side effects — a live probe drove an accepted
  // item to FAILED this way).
  const fixAgain = tmpJson({ applied: false, scopeStop: false, summary: 'stale duplicate' });
  const r = run(['submit', 'SELFTEST-ITEM', '--role', 'fixer', '--json', fixAgain]);
  assert(r.code !== 0 && /no pending call/.test(r.out), 'stale submit of a completed phase\'s role is REJECTED (loud error)');
  const s = JSON.parse(run(['status', 'SELFTEST-ITEM']).out);
  // (res.toState starts as 'FAILED' by design — factory.js parity — so pin the PATH: phase intact,
  // no new transitions, i.e. the fix-phase side effects did NOT re-run)
  assert(s.phase === 'verify' && s.transitions.join(',') === 'RED', 'the rejected stale submit changed NOTHING (phase + transitions intact)');
}
{
  const n = run(['next', 'SELFTEST-ITEM']);
  const parsed = JSON.parse(n.out);
  assert(parsed.mechanical === 'verify', 'next at the verify phase correctly reports a MECHANICAL step, not an agent call');
}
{
  // Fix #10 (CLI wiring) + #9: mech leftover on the fixture worktree — leftover-lint is best-effort
  // (a bogus worktree yields FACTORY::LEFTOVER::0), the anchored-last-match parse accepts it, and
  // the comment gate obeys the HOST policy (this clone ships policies OFF, so the check is skipped
  // and NO mech:comment-scan key may appear; assert against the actual effective policy so a host
  // overlay cannot false-fail this pin).
  surgery('SELFTEST-ITEM', (o) => { o.phase = 'leftover'; o.pendingSet = null; });
  const r = run(['mech', 'SELFTEST-ITEM', 'leftover']);
  assert(r.code === 0, 'mech leftover completes on the fixture worktree (leftover-lint best-effort 0): ' + r.out.slice(0, 300));
  const s = JSON.parse(run(['status', 'SELFTEST-ITEM']).out);
  assert(s.gates['probe:leftover-scan'] === 'APPROVED', 'leftover-scan: 0 candidates -> APPROVED');
  assert(s.phase === 'gates', 'leftover pass advances through editorial (no doc flows on a code-only item) to gates');
  const commentPolicyOn = loadPolicies(FACTORY_ROOT).noNewComments;
  assert(commentPolicyOn ? ('mech:comment-scan' in s.gates) : !('mech:comment-scan' in s.gates),
    'comment gate runs (and records a verdict) ONLY when the host enables policies.noNewComments (effective=' + commentPolicyOn + ')');
}
{
  // Fix #15 — gate-band briefs carry staleGuard (reFix) + voGuard (verificationOnly) + the method
  // flows' BMAD-methodology line (factory.js parity).
  surgery('SELFTEST-ITEM', (o) => { o.reFix = true; o.verificationOnly = true; });
  const n = run(['next', 'SELFTEST-ITEM']);
  const parsed = JSON.parse(n.out);
  const dev = parsed.agents.find((a) => a.role === 'gate-developer');
  const adv = parsed.agents.find((a) => a.role === 'review-adversarial');
  assert(dev && /RE-FIX ROUND:/.test(dev.prompt), 'gate briefs carry the KI-L35 staleGuard on a reFix round ("prior findings are hypotheses")');
  assert(dev && /VERIFICATION-ONLY ITEM:/.test(dev.prompt), 'gate briefs carry the KI-L55 voGuard (flipped-gate mandate) on a verificationOnly item');
  assert(adv && /BMAD review methodology/.test(adv.prompt) && /RE-FIX ROUND:/.test(adv.prompt), 'method review flows carry the methodology line + guards');
}
{
  // scope-stop path, tested independently on a second fixture item id so it doesn't disturb the happy-path item above.
  const dir2 = join(FACTORY_ROOT, 'state', 'items', 'SELFTEST-ITEM-SCOPESTOP');
  try { rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ }
  run(['init', 'SELFTEST-ITEM-SCOPESTOP', '--fixture', FIXTURE]);
  run(['next', 'SELFTEST-ITEM-SCOPESTOP']);
  const plan = tmpJson({ rootCause: 'root', approach: 'crosses a red line', recommendScopeStop: true, recommendEscalate: false });
  run(['submit', 'SELFTEST-ITEM-SCOPESTOP', '--role', 'planner', '--json', plan]);
  // KI-O1 fix: scope-stop now dispatches a REAL decision-framer call before reaching BLOCKED
  // (previously skipped) — the item must NOT be BLOCKED yet, it must be awaiting that call.
  const mid = JSON.parse(run(['status', 'SELFTEST-ITEM-SCOPESTOP']).out);
  assert(mid.phase === 'decision_frame', 'scope-stop routes through a REAL decision-framer dispatch, not straight to BLOCKED');
  assert(mid.toState !== 'BLOCKED', 'BLOCKED is not reached until the decision-framer response lands');
  const dn = run(['next', 'SELFTEST-ITEM-SCOPESTOP']);
  const dnParsed = JSON.parse(dn.out);
  assert(dnParsed.agents && dnParsed.agents[0].role === 'decision-framer', 'next at decision_frame dispatches the decision-framer role');
  assert(dnParsed.agents[0].schema === 'DECISION_SCHEMA', 'decision-framer call carries DECISION_SCHEMA');
  const framed = tmpJson({ decision: 'Proceed despite the scope-stop, or halt?', options: [{ option: 'Halt', consequence: 'No forbidden surface added' }], recommendation: 'Halt', headline: 'Only viable fix crosses a red line' });
  run(['submit', 'SELFTEST-ITEM-SCOPESTOP', '--role', 'decision-framer', '--json', framed]);
  const s = JSON.parse(run(['status', 'SELFTEST-ITEM-SCOPESTOP']).out);
  assert(s.toState === 'BLOCKED', 'planner.recommendScopeStop=true ends the item BLOCKED (after the framer dispatch), not FAILED or advancing');
  // Fix #13 — the BLOCKED terminal must demand a checkpoint before reporting done.
  const tn = JSON.parse(run(['next', 'SELFTEST-ITEM-SCOPESTOP']).out);
  assert(tn.mechanical === 'checkpoint', 'a BLOCKED terminal returns the mech checkpoint step (result.json must exist for fold/reconstruct)');
  try { rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ }
}
{
  // mech verify safety guard (KI-O1 fix): a codeChange item on a non-FULL band with NO filter
  // must refuse loudly rather than silently reporting "tests green" from build-only evidence.
  const dir3 = join(FACTORY_ROOT, 'state', 'items', 'SELFTEST-ITEM-NOFILTER');
  try { rmSync(dir3, { recursive: true, force: true }); } catch { /* ignore */ }
  run(['init', 'SELFTEST-ITEM-NOFILTER', '--fixture', FIXTURE]);
  run(['next', 'SELFTEST-ITEM-NOFILTER']);
  run(['submit', 'SELFTEST-ITEM-NOFILTER', '--role', 'planner', '--json', tmpJson({ rootCause: 'r', approach: 'a', recommendScopeStop: false, recommendEscalate: false })]);
  run(['submit', 'SELFTEST-ITEM-NOFILTER', '--role', 'test-author', '--json', tmpJson({ red: true, note: 'n' })]);
  run(['submit', 'SELFTEST-ITEM-NOFILTER', '--role', 'fixer', '--json', tmpJson({ applied: true, scopeStop: false, summary: 's' })]);
  const noFilterAttempt = run(['mech', 'SELFTEST-ITEM-NOFILTER', 'verify', '--', 'some.sln']);
  assert(noFilterAttempt.code !== 0, 'mech verify REFUSES a codeChange/non-FULL item with no filter (would otherwise silently read build-only as "tests green")');
  assert(/MUST run its targeted test/.test(noFilterAttempt.out), 'the refusal names the actual risk, not a generic error');
  try { rmSync(dir3, { recursive: true, force: true }); } catch { /* ignore */ }
}
{
  // KI-O1 regression test for a live 2026-07-28 bug on a real production item: a FULL-band item
  // with no filter used to fall through to a suite-ONLY run. dotnet test's default verbosity
  // suppresses test stdout (KI-L22), so suite's own transcript can NEVER carry a realInfra Console
  // marker, regardless of band — a FULL-band realInfra item verified via suite-only would be
  // STRUCTURALLY unable to ever close. The guard must fire for FULL band too, not just LIGHT.
  const dir3b = join(FACTORY_ROOT, 'state', 'items', 'SELFTEST-ITEM-FULLBAND');
  try { rmSync(dir3b, { recursive: true, force: true }); } catch { /* ignore */ }
  const FULLBAND_FIXTURE = join(HERE, 'selftest-fixture-fullband.json');
  run(['init', 'SELFTEST-ITEM-FULLBAND', '--fixture', FULLBAND_FIXTURE]);
  run(['next', 'SELFTEST-ITEM-FULLBAND']);
  run(['submit', 'SELFTEST-ITEM-FULLBAND', '--role', 'planner', '--json', tmpJson({ rootCause: 'r', approach: 'a', recommendScopeStop: false, recommendEscalate: false })]);
  run(['submit', 'SELFTEST-ITEM-FULLBAND', '--role', 'test-author', '--json', tmpJson({ red: true, note: 'n' })]);
  run(['submit', 'SELFTEST-ITEM-FULLBAND', '--role', 'fixer', '--json', tmpJson({ applied: true, scopeStop: false, summary: 's' })]);
  const s = JSON.parse(run(['status', 'SELFTEST-ITEM-FULLBAND']).out);
  assert(s.band === 'FULL', 'fixture item is genuinely FULL band (idempotency-dataflow theme): ' + s.band);
  const fullNoFilterAttempt = run(['mech', 'SELFTEST-ITEM-FULLBAND', 'verify', '--', 'some.sln']);
  assert(fullNoFilterAttempt.code !== 0, 'mech verify REFUSES a FULL-band codeChange item with no filter too (the KI-O1 bug: suite-only can never carry a realInfra marker) — this must NOT be LIGHT-band-only');
  assert(/MUST run its targeted test/.test(fullNoFilterAttempt.out), 'the FULL-band refusal names the actual risk too');

  // Fix #3 — `next` idempotence on a POOLED phase: re-printing prompts must not reset received
  // verdicts. Surgery to the refute_reaudit phase (FULL band: refuter + 3 lenses = 4 pooled calls).
  surgery('SELFTEST-ITEM-FULLBAND', (o) => { o.phase = 'refute_reaudit'; o.pendingSet = null; });
  const n1 = JSON.parse(run(['next', 'SELFTEST-ITEM-FULLBAND']).out);
  assert(n1.agents && n1.agents.length === 4, 'refute_reaudit on FULL/CRITICAL idempotency theme pools 4 calls (refuter + code/edge-case/architecture lenses): ' + (n1.agents && n1.agents.length));
  assert(n1.agents.some((a) => /audit lens ONLY/.test(a.prompt)), 're-auditor briefs carry factory.js\'s scoped-lens mandate (not a bare "LENS:" tag)');
  run(['submit', 'SELFTEST-ITEM-FULLBAND', '--role', 'refuter', '--json', tmpJson({ refuted: false, headline: 'fix holds' })]);
  const n2 = JSON.parse(run(['next', 'SELFTEST-ITEM-FULLBAND']).out);
  assert(Array.isArray(n2.pendingKeys) && n2.pendingKeys.length === 3 && !n2.pendingKeys.includes('refuter'), 'a re-printed next KEEPS the already-received refuter verdict (idempotent — was: wiped received{} on every call)');
  const sMid = JSON.parse(run(['status', 'SELFTEST-ITEM-FULLBAND']).out);
  assert(sMid.pendingSet && sMid.pendingSet.received.includes('refuter'), 'status confirms the refuter submission survived the second next');
  for (const lens of ['code', 'edge-case', 'architecture']) {
    run(['submit', 'SELFTEST-ITEM-FULLBAND', '--role', 're-auditor:' + lens, '--json', tmpJson({ converged: true, findingGone: true, headline: 'ok' })]);
  }
  const sEnd = JSON.parse(run(['status', 'SELFTEST-ITEM-FULLBAND']).out);
  assert(sEnd.phase === 'integrate', 'all 4 pooled verdicts in -> refute_reaudit completes -> escalatecheck passes through -> integrate (CLI-level pin of the #6 reposition)');
  assert(sEnd.transitions.includes('REFUTE_OK') && sEnd.transitions.includes('REAUDITED'), 'REFUTE_OK + REAUDITED recorded');
  try { rmSync(dir3b, { recursive: true, force: true }); } catch { /* ignore */ }
}
{
  // Fix #13 (terminal checkpoint, FAILED path): a no-red FAILED terminal demands mech checkpoint,
  // mech checkpoint writes result.json + ends the loop, next then reports done.
  const id = 'SELFTEST-TERMFAIL';
  try { rmSync(itemsDirOf(id), { recursive: true, force: true }); } catch { /* ignore */ }
  run(['init', id, '--fixture', FIXTURE]);
  run(['next', id]);
  run(['submit', id, '--role', 'planner', '--json', tmpJson({ rootCause: 'r', approach: 'a', recommendScopeStop: false, recommendEscalate: false })]);
  run(['submit', id, '--role', 'test-author', '--json', tmpJson({ red: false, note: 'no red produced' })]);
  const s1 = JSON.parse(run(['status', id]).out);
  assert(s1.toState === 'FAILED', 'red:false (non-verificationOnly) fails the item');
  const n1 = JSON.parse(run(['next', id]).out);
  assert(n1.mechanical === 'checkpoint', 'a FAILED terminal returns {mechanical:"checkpoint"} until result.json exists (was: {done:true} with no result.json — the ledger row stayed CLAIMED forever)');
  const ck = run(['mech', id, 'checkpoint']);
  assert(ck.code === 0 && /CHECKPOINT-OK/.test(ck.out), 'mech checkpoint writes + self-verifies result.json');
  const resPath = join(itemsDirOf(id), 'result.json');
  assert(existsSync(resPath) && JSON.parse(readFileSync(resPath, 'utf8')).toState === 'FAILED', 'result.json persisted with the FAILED terminal');
  const n2 = JSON.parse(run(['next', id]).out);
  assert(n2.done === true && !n2.mechanical, 'after the checkpoint, next reports done (the checkpoint loop ENDS — no infinite {mechanical:"checkpoint"})');
  try { rmSync(itemsDirOf(id), { recursive: true, force: true }); } catch { /* ignore */ }
}
{
  // Fix #14 + #7 + #6 + #13 — full doc-only e2e to CLOSED with ZERO dotnet: doc verify (no build),
  // editorial band, LIGHT gate band (NO po), refute covered by the adversarial flow, escalatecheck
  // pass-through, doc integrate (no build), integrator judgment, checkpoint, done.
  const id = 'SELFTEST-DOC-E2E';
  try { rmSync(itemsDirOf(id), { recursive: true, force: true }); } catch { /* ignore */ }
  const docFixture = tmpJson({
    item: {
      id, target: 'SelfTest', layer: 'service', title: 'Stale doc claims the removed endpoint still exists',
      severity: 'MEDIUM', theme: 'doc-drift', fixType: 'mechanical',
      files: ['README.md', 'docs/guide.md'],
      acceptance: 'Documentation reflects the shipped behaviour end to end.',
      regressionTest: 'A grep assertion proving the stale claim is gone.',
      realInfra: false, autonomyTier: 'auto', fixHint: '(none)', source: 'opencode-adapter self-test (doc-only)',
    },
    worktreePath: 'C:/fake/host/worktree', branch: 'fixture/none', cycle: 1, state: 'READY', prevState: null,
  });
  run(['init', id, '--fixture', docFixture]);
  const s0 = JSON.parse(run(['status', id]).out);
  assert(s0.phase === 'test', 'doc e2e: mechanical fixType skips the planner');
  run(['next', id]);
  run(['submit', id, '--role', 'test-author', '--json', tmpJson({ red: true, note: 'grep shows the stale claim present' })]);
  run(['submit', id, '--role', 'fixer', '--json', tmpJson({ applied: true, scopeStop: false, summary: 'docs corrected' })]);
  const v = run(['mech', id, 'verify']);
  assert(v.code === 0 && /doc-only/.test(v.out), 'doc e2e: mech verify takes the NO-BUILD path for !codeChange (factory.js runner-brief parity: "do NOT run dotnet build/test")');
  const rawPath = join(itemsDirOf(id), 'verify-raw.txt');
  assert(existsSync(rawPath) && /doc-only item: no build required/.test(readFileSync(rawPath, 'utf8')), 'doc e2e: verify-raw.txt records HONEST no-build evidence (never a fabricated green)');
  const s1 = JSON.parse(run(['status', id]).out);
  assert(s1.transitions.includes('GREEN') && s1.transitions.includes('TESTED'), 'doc e2e: GREEN/BUILT/TESTED recorded (factory.js pushes them for doc items after runner verify)');
  assert(s1.phase === 'editorial', 'doc e2e: edgescan/acceptance(single-clause)/leftover all skip for a doc item -> editorial');
  const en = JSON.parse(run(['next', id]).out);
  assert(en.agents && en.agents.length === 2 && /Advisory editorial pass/.test(en.agents[0].prompt) && /REGENERATE the review pack/.test(en.agents[0].prompt),
    'doc e2e: editorial briefs carry factory.js\'s advisory + claims-lint + pack-regeneration + don\'t-break-the-test mandate');
  run(['submit', id, '--role', 'review-editorial-structure', '--json', tmpJson({ gate: 'editorial-structure', verdict: 'APPROVED', headline: 'clean' })]);
  run(['submit', id, '--role', 'review-editorial-prose', '--json', tmpJson({ gate: 'editorial-prose', verdict: 'APPROVED', headline: 'clean' })]);
  const gs = JSON.parse(run(['status', id]).out);
  assert(gs.phase === 'gates', 'doc e2e: editorial done -> gates');
  for (const g of [['gate-developer', 'developer'], ['gate-qa', 'qa'], ['review-adversarial', 'adversarial'], ['review-testreview', 'testreview']]) {
    run(['submit', id, '--role', g[0], '--json', tmpJson({ gate: g[1], verdict: 'APPROVED', headline: 'clean' })]);
  }
  const afterGates = JSON.parse(run(['status', id]).out);
  assert(afterGates.phase === 'refute_reaudit', 'doc e2e (fix #7): LIGHT band SKIPS the po phase — gates pass straight to refute_reaudit');
  assert(!('gate:po' in afterGates.gates), 'doc e2e: no gate:po verdict recorded on a LIGHT item');
  assert(afterGates.transitions.includes('GATED'), 'doc e2e: GATED recorded without a PO run (factory.js pushes it after the band)');
  const rn = JSON.parse(run(['next', id]).out);
  assert(rn.agents && rn.agents.length === 1 && rn.agents[0].key === 're-auditor:code', 'doc e2e: LIGHT + adversarial flow present -> refuter covered, single code-lens re-audit');
  run(['submit', id, '--role', 're-auditor:code', '--json', tmpJson({ converged: true, findingGone: true, headline: 'doc claim gone' })]);
  const ri = JSON.parse(run(['status', id]).out);
  assert(ri.phase === 'integrate' && ri.transitions.includes('REFUTE_OK') && ri.transitions.includes('REAUDITED'), 'doc e2e (fix #6): refute/re-audit pass -> escalatecheck (not escalate) -> integrate');
  const ig = run(['mech', id, 'integrate']);
  assert(ig.code === 0 && /doc-only/.test(ig.out), 'doc e2e: mech integrate takes the NO-BUILD path for !codeChange (factory.js integrator-brief parity)');
  run(['submit', id, '--role', 'integrator', '--json', tmpJson({ globalGreen: true, regressionDelta: 0, handoff: 'branch ready for human commit', branch: 'fixture/none' })]);
  const cs = JSON.parse(run(['status', id]).out);
  assert(cs.toState === 'CLOSED' && cs.phase === 'checkpoint', 'doc e2e: integrator globalGreen -> CLOSED, awaiting checkpoint');
  const cn = JSON.parse(run(['next', id]).out);
  assert(cn.mechanical === 'checkpoint', 'doc e2e: CLOSED path demands the checkpoint');
  run(['mech', id, 'checkpoint']);
  const dn = JSON.parse(run(['next', id]).out);
  assert(dn.done === true && dn.toState === 'CLOSED', 'doc e2e: checkpoint ends the loop; next reports done CLOSED');
  const resObj = JSON.parse(readFileSync(join(itemsDirOf(id), 'result.json'), 'utf8'));
  assert(resObj.toState === 'CLOSED' && resObj.transitions.includes('INTEGRATED') && !('gate:po' in (resObj.gates || {})), 'doc e2e: persisted result.json carries the CLOSED path with no PO gate');
  try { rmSync(itemsDirOf(id), { recursive: true, force: true }); } catch { /* ignore */ }
}
{
  // finalize (KI-O1 fix): wraps a bare per-item result.json into the {mode,cycle,results:[...]}
  // envelope `driver.mjs fold` actually requires — this is the exact gap a real validation run hit.
  const dir4 = join(FACTORY_ROOT, 'state', 'items', 'SELFTEST-ITEM-FINALIZE');
  try { rmSync(dir4, { recursive: true, force: true }); } catch { /* ignore */ }
  run(['init', 'SELFTEST-ITEM-FINALIZE', '--fixture', FIXTURE]);
  writeFileSync(join(dir4, 'result.json'), JSON.stringify({ id: 'SELFTEST-ITEM-FINALIZE', resultId: 'SELFTEST-ITEM-FINALIZE#1', toState: 'CLOSED', transitions: ['CLOSED'] }));
  const fin = run(['finalize', 'SELFTEST-ITEM-FINALIZE']);
  assert(fin.code === 0, 'finalize succeeds given a checkpointed result.json: ' + fin.out);
  const outPath = join(FACTORY_ROOT, 'state', 'results-cycle-1-SELFTEST-ITEM-FINALIZE.json');
  assert(existsSync(outPath), 'finalize writes a results-cycle-<N>-<id>.json file');
  const wrapped = JSON.parse(readFileSync(outPath, 'utf8'));
  assert(Array.isArray(wrapped.results) && wrapped.results.length === 1 && wrapped.results[0].id === 'SELFTEST-ITEM-FINALIZE', 'finalize wraps the bare result into {results:[...]} — the shape driver.mjs fold requires (a bare object folds as ZERO results)');
  try { rmSync(dir4, { recursive: true, force: true }); rmSync(outPath, { force: true }); } catch { /* ignore */ }
}

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
try { rmSync(SELFTEST_ITEM_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fail ? 1 : 0;
