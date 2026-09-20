import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, collect, normalizeResponse, parseClaudeResult, textMetrics, seedScore, unmeasuredQualityProjection } from './live-benchmark.mjs';
import { heldoutCases } from './fixtures/live-benchmark-heldout.mjs';
import { ttlSettings, classifyTtl, cacheScript } from './live-benchmark-cache.mjs';
import { freezeExperiment, reportExperiment } from './lib/calibration.mjs';
import { benchmarkCases, compactContract } from './fixtures/live-benchmark.mjs';

const manifest = () => freezeExperiment({ experimentId: 'test', baselineArm: 'original-complete', arms: [
  { id: 'original-complete', contract: 'complete test original', requestedModel: null },
  { id: 'compact', contract: compactContract, requestedModel: null }], cases: benchmarkCases().map(({ seeds, ...c }) => c) });
const response = () => ({ result: { cases: benchmarkCases().map(c => ({ caseId: c.caseId, verdict: 'APPROVED', findings: [] })) } });

test('real freeze/blind/report CLIs preserve six-case cohort and unresolved independent truth', () => {
  const parent = mkdtempSync(join(tmpdir(), 'benchmark-test-'));
  try {
    const dir = join(parent, 'experiment');
    const p = prepare(dir);
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.deepEqual(report.cohort.strata, { documentation: 2, 'ordinary-code': 2, 'high-risk': 2 });
    assert.deepEqual(report.cohort.originalOutcomes, { approved: 2, rejected: 2, mixed: 2 });
    assert.equal(report.arms.compact.unresolved, 6);
    assert.equal(report.arms.compact.truthCases, 0);
    assert.equal(report.automaticChanges, false);
    assert.equal(p.prompts.compact.tokens, null);
    assert.throws(() => prepare(dir), /exist/);
    assert.throws(() => collect(dir, join(dir, 'absent.json'), join(dir, 'absent.json')), /ENOENT/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('malformed, duplicate, foreign and outside-file findings fail rather than producing accepted submissions', () => {
  const m = manifest();
  const good = normalizeResponse(m, 'compact', response());
  assert.equal(good.length, 6);
  assert.equal(good[0].inputTokens, null);
  assert.equal(good[0].actualModel, null);
  const duplicate = response(); duplicate.result.cases[1] = duplicate.result.cases[0];
  assert.throws(() => normalizeResponse(m, 'compact', duplicate), /duplicate/);
  const bad = response(); bad.result.cases[0].findings.push({ findingId: 'f', rule: 'documentation', file: '../outside', line: 1, severity: 'HIGH', text: 'wrong' });
  assert.throws(() => normalizeResponse(m, 'compact', bad), /finding evidence/);
  const score = seedScore(response());
  assert.equal(score.independent, false);
  assert.equal(score.cases.flatMap(c => c.missed).length, 5);
  assert.throws(() => reportExperiment(m, good, { version: 1, experimentDigest: m.digest, findings: [], truth: [],
    outcomes: [{ blindId: good[0].blindId, outcome: 'accepted', adjudicator: 'author', blind: false, independent: false }] }), /independent and blind/);
});

test('Claude accounting preserves auxiliary models and unknown subscription charges', () => {
  const parsed = parseClaudeResult(JSON.stringify({ type: 'result', result: JSON.stringify(response().result), usage: { input_tokens: 3 },
    modelUsage: { sonnet: { inputTokens: 3 }, haiku: { inputTokens: 4000 } }, total_cost_usd: 0.02, num_turns: 1 }), 123);
  assert.equal(parsed.actualModel, null);
  assert.equal(parsed.measuredCost, null);
  assert.equal(parsed.providerRequestCount, null);
  assert.equal(parsed.providerReportedCostUSD, 0.02);
  assert.deepEqual(Object.keys(parsed.modelUsage), ['sonnet', 'haiku']);
  assert.throws(() => parseClaudeResult('{"type":"result","is_error":true}', 1), /successful/);
  assert.deepEqual(textMetrics('A😀').utf16CodeUnits, 3);
  assert.equal(textMetrics('A😀').unicodeCharacters, 2);
  assert.equal(textMetrics('A😀').utf8Bytes, 5);
});

test('heldout truth stays separate and invented labor/escape metrics cannot become measurements',()=>{
  const cases=heldoutCases();
  assert.equal(cases.length,12);
  assert.equal(cases.flatMap(c=>c.seeds).length,6);
  assert.equal(cases.filter(c=>!c.seeds.length).length,6);
  assert.equal(new Set(cases.map(c=>c.caseId)).size,12);
  const original={outcomes:[{outcome:'accepted',correctionMinutes:15,escapedDefects:0}],findings:[{outcome:'valid'}]};
  const projected=unmeasuredQualityProjection(original);
  assert.equal(projected.outcomes[0].correctionMinutes,null);
  assert.equal(projected.outcomes[0].escapedDefects,null);
  assert.equal(projected.outcomes[0].outcome,'accepted');
  assert.deepEqual(projected.findings,original.findings);
  assert.equal(original.outcomes[0].correctionMinutes,15);
});

test('TTL settings and observed worker buckets remain distinct; absent buckets never prove control',()=>{
  assert.equal(ttlSettings('1h').promptCacheTtl,'5m');
  assert.equal(ttlSettings('1h').subagentPromptCacheTtl,'1h');
  assert.throws(()=>ttlSettings('10m'),/TTL/);
  assert.equal(classifyTtl([],'1h').requestedTtlObserved,false);
  assert.equal(classifyTtl([{usage:{cache_creation_input_tokens:42}}],'1h').requestedTtlObserved,false);
  const rows=[{usage:{cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:42},cache_read_input_tokens:0}}];
  assert.equal(classifyTtl(rows,'1h').requestedTtlObserved,true);
  assert.equal(classifyTtl(rows,'5m').requestedTtlObserved,false);
  assert.equal(cacheScript('fixed').prompt,cacheScript('fixed').prompt);
  assert.notEqual(cacheScript('first').prompt,cacheScript('second').prompt);
  assert.ok(cacheScript('fixed').script.includes('i<4'));
});
