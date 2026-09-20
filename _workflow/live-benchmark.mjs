#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotHash, blindId, blindPacket, validateFrozenExperiment } from './lib/calibration.mjs';
import { benchmarkCases, compactContract, responseContract } from './fixtures/live-benchmark.mjs';
import { heldoutCases } from './fixtures/live-benchmark-heldout.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const write = (dir, name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
export const textMetrics = text => ({ utf16CodeUnits: text.length, unicodeCharacters: [...text].length, utf8Bytes: Buffer.byteLength(text), sha256: snapshotHash(text), tokens: null });

function requireModel(dir, model) {
  const manifest = read(join(dir, 'frozen.json'));
  validateFrozenExperiment(manifest);
  if (manifest.arms.some(a => a.requestedModel !== model)) throw new Error('requested model differs from frozen manifest; prepare a new directory');
  return manifest;
}

function reviewPrompt(dir, name) {
  const prompt = readFileSync(join(dir, name + '.prompt.txt'), 'utf8');
  const provenance = read(join(dir, 'provenance.json'));
  if (provenance.prompts[name]?.sha256 !== textMetrics(prompt).sha256) throw new Error('review prompt changed since preparation');
  return prompt;
}

function cli(args) {
  const result = spawnSync(process.execPath, [join(root, '_workflow/calibrate.mjs'), ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'calibration CLI failed');
  return result.stdout;
}

export function prepare(directory, model = null, heldout = false) {
  const dir = resolve(directory);
  if (!existsSync(dirname(dir)) || !statSync(dirname(dir)).isDirectory()) throw new Error('output parent must already exist');
  mkdirSync(dir);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const original = execFileSync('git', ['show', revision + ':agents/review-code.md'], { cwd: root, encoding: 'utf8' });
  const edge = execFileSync('git', ['show', revision + ':agents/review-edgecase.md'], { cwd: root, encoding: 'utf8' });
  const cases = heldout ? heldoutCases() : benchmarkCases();
  const outputContract = heldout ? responseContract.replace('all six cases', 'all supplied cases') : responseContract;
  const input = { experimentId: heldout ? 'synthetic-review-context-heldout-v1' : 'synthetic-review-context-v1', baselineArm: 'original-complete',
    arms: [{ id: 'original-complete', contract: original, requestedModel: model }, { id: 'compact', contract: compactContract, requestedModel: model },
      { id: 'original-separate', contract: 'Union of two independent requests, preserving role identity:\n' + original + '\n' + edge, requestedModel: model }],
    cases: cases.map(({ seeds, ...row }) => row) };
  write(dir, 'input.json', input);
  write(dir, 'frozen.json', cli(['freeze', join(dir, 'input.json')]));
  const frozen = read(join(dir, 'frozen.json'));
  const visible = frozen.cases.map(c => ({ caseId: c.caseId, snapshot: c.snapshot }));
  const prompts = {};
  for (const [id, contract] of [['original-complete', original], ['compact', compactContract], ['edge-independent', edge]]) {
    const prompt = [contract, outputContract, JSON.stringify(visible)].join('\n\n');
    write(dir, id + '.prompt.txt', prompt);
    prompts[id] = textMetrics(prompt);
  }
  const provenance = { version: 1, kind: 'synthetic-benchmark-preparation', revision, experimentDigest: frozen.digest,
    baselineBrief: { complete: textMetrics(original), historicalDeliveredCap: textMetrics(original.slice(0, 12000)), capCodeUnits: 12000, truncated: original.length > 12000 },
    prompts, measuredTokens: null, model, batching: `one independent request per arm containing ${cases.length} cases; not ${cases.length} independent requests`,
    automaticChanges: false, realHumanAcceptance: null };
  write(dir, 'provenance.json', provenance);
  write(dir, 'seed-reference.json', { independent: false, blind: false, source: 'fixture-author-known-seeds', cases: cases.map(c => ({ caseId: c.caseId, seeds: c.seeds })) });
  write(dir, 'empty-adjudications.json', { version: 1, experimentDigest: frozen.digest, outcomes: [], findings: [], truth: [] });
  write(dir, 'submissions.json', []);
  write(dir, 'blind.json', cli(['blind', join(dir, 'frozen.json'), join(dir, 'submissions.json')]));
  write(dir, 'report.json', cli(['report', join(dir, 'frozen.json'), join(dir, 'submissions.json'), join(dir, 'empty-adjudications.json'), '--json']));
  return { directory: dir, ...provenance };
}

export function normalizeResponse(manifest, armId, response) {
  validateFrozenExperiment(manifest);
  if (!manifest.arms.some(a => a.id === armId)) throw new Error('unknown arm');
  const result = response.result;
  if (!result || !Array.isArray(result.cases) || result.cases.length !== manifest.cases.length) throw new Error('response must contain exactly the frozen cases');
  if (new Set(result.cases.map(c => c.caseId)).size !== manifest.cases.length || result.cases.some(c => !manifest.cases.some(m => m.caseId === c.caseId))) throw new Error('duplicate or foreign case');
  const submissions = manifest.cases.map(c => {
    const output = result.cases.find(r => r.caseId === c.caseId);
    if (!['APPROVED', 'CHANGES_REQUIRED'].includes(output.verdict) || !Array.isArray(output.findings)) throw new Error('invalid review output');
    return { blindId: blindId(manifest, c.caseId, armId), caseId: c.caseId, armId, snapshotHash: c.snapshotHash,
      status: 'completed', actualModel: response.actualModel ?? null,
      measuredCost: null, currency: null, costSource: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      extraReads: null, formatFailures: null, physicalCalls: null, reusedCalls: null,
      findings: output.findings.map(f => {
        if (!['documentation', 'bounds', 'tenant', 'idempotency', 'secrets', 'other'].includes(f.rule)
          || !Object.hasOwn(c.snapshot.files, f.file) || !Number.isInteger(f.line) || f.line < 1 || f.line > c.snapshot.files[f.file].split('\n').length
          || !['HIGH', 'MEDIUM', 'LOW', 'CRITICAL'].includes(f.severity) || typeof f.text !== 'string' || !f.text.trim()) throw new Error('invalid finding evidence');
        return { findingId: f.findingId, role: armId === 'compact' ? 'consolidated' : 'review-code', text: `${f.severity} ${f.file}:${f.line}: ${f.text}` };
      }),
    };
  });
  blindPacket(manifest, submissions);
  return submissions;
}

export function seedScore(response, cases = benchmarkCases()) {
  return { independent: false, blind: false, interpretation: 'Seed-label detection proxy; no semantic adjudication or production acceptance',
    cases: cases.map(c => {
      const output = response.result?.cases?.find(r => r.caseId === c.caseId);
      if (!output) return { caseId: c.caseId, missing: true, missed: null };
      const labels = [...new Set(output.findings.map(f => f.rule + ':' + f.file))];
      return { caseId: c.caseId, seeds: c.seeds, detected: c.seeds.filter(s => labels.includes(s)), missed: c.seeds.filter(s => !labels.includes(s)), unseededLabels: labels.filter(s => !c.seeds.includes(s)) };
    }) };
}

export function collect(directory, originalPath, compactPath, edgePath) {
  const dir = resolve(directory), manifest = read(join(dir, 'frozen.json'));
  const seeds = read(join(dir, 'seed-reference.json')).cases;
  const responses = [read(originalPath), read(compactPath)];
  const submissions = responses.flatMap((r, i) => normalizeResponse(manifest, i ? 'compact' : 'original-complete', r));
  if (edgePath) {
    const edge = read(edgePath);
    const edgeSubmissions = normalizeResponse(manifest, 'original-separate', edge);
    for (const c of manifest.cases) {
      const original = submissions.find(s => s.caseId === c.caseId && s.armId === 'original-complete');
      const additional = edgeSubmissions.find(s => s.caseId === c.caseId);
      additional.actualModel = original.actualModel === additional.actualModel ? original.actualModel : null;
      additional.findings = original.findings.map(f => ({ ...f, findingId: 'code-' + f.findingId })).concat(additional.findings.map(f => ({ ...f, role: 'review-edgecase', findingId: 'edge-' + f.findingId })));
      submissions.push(additional);
    }
    const combined = { result: { cases: manifest.cases.map(c => ({ caseId: c.caseId,
      findings: responses[0].result.cases.find(r => r.caseId === c.caseId).findings.concat(edge.result.cases.find(r => r.caseId === c.caseId).findings) })) } };
    write(dir, 'portfolio-seed-summary.json', { physicalCalls: [responses[0].physicalCalls, edge.physicalCalls].every(Number.isFinite) ? responses[0].physicalCalls + edge.physicalCalls : null,
      seedScore: seedScore(combined, seeds), usage: { original: responses[0].usage ?? null, edge: edge.usage ?? null },
      interpretation: 'Original results reused analytically in union; not an additional paid original request. Do not add portfolio usage to original-arm usage.' });
  }
  write(dir, 'collected-submissions.json', submissions);
  write(dir, 'collected-blind.json', cli(['blind', join(dir, 'frozen.json'), join(dir, 'collected-submissions.json')]));
  write(dir, 'collected-report.json', cli(['report', join(dir, 'frozen.json'), join(dir, 'collected-submissions.json'), join(dir, 'empty-adjudications.json'), '--json']));
  const summary = { version: 1, experimentDigest: manifest.digest, automaticChanges: false, realHumanAcceptance: null,
    arms: Object.fromEntries(responses.map((r, i) => [i ? 'compact' : 'original-complete', { actualModel: r.actualModel ?? null,
      usage: r.usage ?? null, measuredCost: r.measuredCost ?? null, costSource: r.costSource ?? null,
      currency: r.currency ?? null, physicalCalls: r.physicalCalls ?? null, durationMs: r.durationMs ?? null, seedScore: seedScore(r, seeds) }])),
    limitations: ['Batch usage is not allocated to individual cases.', 'Fixture-author seeds are not independent truth.', 'Unseeded labels require adjudication; they are not automatically false positives.', 'No production reviewer reduction justified by this synthetic cohort.'] };
  write(dir, 'measured-summary.json', summary);
  write(dir, 'adjudication.prompt.txt', 'Independently adjudicate this blind packet without consulting any other artifact. Return JSON only with version:1, experimentDigest, outcomes, findings, truth. Every row must name adjudicator (your actual model or unknown), blind:true and independent:true only if accurate. Outcomes rows: blindId,outcome (accepted/rejected/mixed/unresolved),escapedDefects:null,correctionMinutes:null. Judge acceptance of the REVIEW: accepted when all real defects were found and no false findings; mixed when partial; rejected when wrong. Findings rows: blindId,findingId,canonicalFindingId,outcome (valid/false-positive/unresolved). Truth rows: caseId,complete,validFindingIds. Independently establish all defects from each snapshot; use the same canonical identity for equivalent findings. The source fixtures were not repaired. Outcomes are review-quality judgments, not production delivery acceptance.\n' + readFileSync(join(dir, 'collected-blind.json'), 'utf8'));
  return summary;
}

export function parseClaudeResult(raw, durationMs) {
  const envelope = JSON.parse(raw);
  if (envelope.is_error || envelope.type !== 'result' || typeof envelope.result !== 'string') throw new Error('Claude returned no successful result');
  const output = envelope.result.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const models = Object.keys(envelope.modelUsage || {});
  return { result: JSON.parse(output), actualModel: models.length === 1 ? models[0] : null,
    usage: envelope.usage ?? null, modelUsage: envelope.modelUsage ?? null,
    measuredCost: null, currency: null, costSource: null,
    providerReportedCostUSD: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
    costInterpretation: 'CLI reported API-equivalent cost; actual subscription charge unknown',
    physicalCalls: 1, providerRequestCount: null, durationMs,
    internalTurns: envelope.num_turns ?? null, permissionDenials: envelope.permission_denials ?? null };
}

async function claudeRequest(dir, name, prompt, executable, model) {
  const start = Date.now();
  const args = ['-p', '--safe-mode', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    '--output-format', 'json', '--model', model, '--effort', 'low', '--max-budget-usd', '1',
    '--system-prompt', 'You are an independent reviewer of synthetic fixtures. Follow the supplied output contract. No tools. Return JSON only.'];
  const output = await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: dir, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(name + ': request timed out after 180 seconds')); }, 180000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(name + ': Claude exited ' + code + ' (' + stderr.length + ' stderr characters; not persisted)'));
      else accept(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
  const response = parseClaudeResult(output, Date.now() - start);
  write(dir, name + '.response.json', response);
  return response;
}

export async function adjudicate(directory, executable, model) {
  const dir = resolve(directory);
  requireModel(dir, model);
  if (existsSync(join(dir, 'adjudication-retry.response.json'))) throw new Error('adjudication retry already exists');
  const prompt = 'Return only the specified JSON. CRITICAL SCHEMA RULE: EVERY individual row of outcomes, findings and truth must include adjudicator, blind:true, independent:true; top-level attestation is insufficient. Multiple reviewers reporting the same true defect are ALL VALID, not false positives: canonicalize duplicates to the same canonicalFindingId. The same canonicalFindingId cannot be both valid and false-positive. Reviewer overlap is expected and is not a review failure. For each case independently establish complete reference truth, then check every candidate.\n' + readFileSync(join(dir, 'adjudication.prompt.txt'), 'utf8');
  const response = await claudeRequest(dir, 'adjudication-retry', prompt, executable, model);
  write(dir, 'independent-adjudications-retry.json', response.result);
  write(dir, 'independent-report.json', cli(['report', join(dir, 'frozen.json'), join(dir, 'collected-submissions.json'), join(dir, 'independent-adjudications-retry.json'), '--json']));
  write(dir, 'independent-report.md', cli(['report', join(dir, 'frozen.json'), join(dir, 'collected-submissions.json'), join(dir, 'independent-adjudications-retry.json')]));
  return read(join(dir, 'independent-report.json'));
}

export async function cacheRepeat(directory, executable, model) {
  const dir = resolve(directory);
  requireModel(dir, model);
  if (['cache-repeat-1', 'cache-repeat-2'].some(n => existsSync(join(dir, n + '.response.json')))) throw new Error('cache repeat already exists');
  const prompt = reviewPrompt(dir, 'original-complete');
  const results = [];
  for (const name of ['cache-repeat-1', 'cache-repeat-2']) results.push(await claudeRequest(dir, name, prompt, executable, model));
  const report = { prompt: textMetrics(prompt), usage: results.map(r => r.usage), modelUsage: results.map(r => r.modelUsage),
    physicalCalls: 2, measuredCost: null, ttlComparison: 'Not controlled: CLI selects cache TTL. Usage reports observed bucket; no 5m/1h override or expiry claim.',
    realHumanAcceptance: null };
  write(dir, 'cache-report.json', report);
  return report;
}

export async function adjudicatePair(directory, executable, model) {
  const dir = resolve(directory), manifest = requireModel(dir, model);
  if (existsSync(join(dir, 'adjudication-pair.response.json'))) throw new Error('pair adjudication already exists');
  const submissions = read(join(dir, 'collected-submissions.json')).filter(s => s.armId !== 'original-separate');
  const packet = blindPacket(manifest, submissions);
  const prompt = `Independently review this blind packet. Return JSON only. Your result must have version:1, experimentDigest (from packet), outcomes, findings, truth. ALL individual rows in each array must include adjudicator (your actual model or unknown), blind:true, independent:true only if accurate. Each outcomes row: blindId,outcome (accepted/rejected/mixed/unresolved),escapedDefects:null,correctionMinutes:null. Accepted means the review found all defects without false positives, NOT that the defective source is accepted. Each findings row: blindId,findingId,canonicalFindingId,outcome (valid/false-positive/unresolved). Each truth row: caseId,complete,validFindingIds. Derive complete reference truth independently from the full files and acceptance. Equivalent true findings from different candidates are ALL valid, with the SAME canonicalFindingId; do not punish overlap as false positives. IDs are opaque bookkeeping and confer no validity. No other artifacts are available.\n` + JSON.stringify(packet);
  write(dir, 'adjudication-pair.prompt.txt', prompt);
  const response = await claudeRequest(dir, 'adjudication-pair', prompt, executable, model);
  write(dir, 'independent-adjudications-pair.json', response.result);
  write(dir, 'independent-pair-report.json', cli(['report', join(dir, 'frozen.json'), join(dir, 'collected-submissions.json'), join(dir, 'independent-adjudications-pair.json'), '--json']));
  write(dir, 'independent-pair-report.md', cli(['report', join(dir, 'frozen.json'), join(dir, 'collected-submissions.json'), join(dir, 'independent-adjudications-pair.json')]));
  return read(join(dir, 'independent-pair-report.json'));
}

export async function adjudicatePortfolio(directory, executable, model) {
  const dir = resolve(directory), manifest = requireModel(dir, model);
  if (existsSync(join(dir, 'adjudication-portfolio.response.json'))) throw new Error('portfolio adjudication already exists');
  const packet = blindPacket(manifest, read(join(dir, 'collected-submissions.json')));
  const mapping = new Map();
  for (const c of packet.cases) for (const candidate of c.candidates) candidate.findings = candidate.findings.map((f, i) => {
    const findingId = 'f' + (i + 1);
    mapping.set(candidate.blindId + ':' + findingId, f.findingId);
    return { ...f, findingId };
  });
  const prompt = `Independently adjudicate each candidate review against the supplied complete source and acceptance. A candidate may pool multiple reviewers: multiple reports of the SAME REAL BUG are ALL valid, not false positives. Duplicate reports do not reduce review quality. Return JSON only: version:1,experimentDigest,outcomes,findings,truth. Every individual row in all three arrays must have adjudicator (your actual model or unknown),blind:true,independent:true only if accurate. outcomes rows: blindId,outcome (accepted/rejected/mixed/unresolved),escapedDefects:null,correctionMinutes:null; accepted means all real defects reported and no false reports. findings rows: blindId,findingId,canonicalFindingId,outcome (valid/false-positive/unresolved). truth rows: caseId,complete,validFindingIds. Independently derive truth; assign matching true reports the SAME canonical identity and valid outcome everywhere. Do not refer to other artifacts.\n` + JSON.stringify(packet);
  write(dir, 'adjudication-portfolio.prompt.txt', prompt);
  const response = await claudeRequest(dir, 'adjudication-portfolio', prompt, executable, model);
  const adjudications = { ...response.result, findings: response.result.findings.map(f => {
    const findingId = mapping.get(f.blindId + ':' + f.findingId);
    if (!findingId) throw new Error('unknown opaque finding identity');
    return { ...f, findingId };
  }) };
  write(dir, 'independent-adjudications-portfolio.json', adjudications);
  const measured = unmeasuredQualityProjection(adjudications);
  write(dir, 'measurement-adjudications.json', measured);
  write(dir, 'independent-portfolio-report.json', cli(['report', join(dir, 'frozen.json'), join(dir, 'collected-submissions.json'), join(dir, 'measurement-adjudications.json'), '--json']));
  write(dir, 'independent-portfolio-report.md', cli(['report', join(dir, 'frozen.json'), join(dir, 'collected-submissions.json'), join(dir, 'measurement-adjudications.json')]));
  return read(join(dir, 'independent-portfolio-report.json'));
}

export function unmeasuredQualityProjection(adjudications) {
  return { ...adjudications, outcomes: adjudications.outcomes.map(o=>({...o,escapedDefects:null,correctionMinutes:null})) };
}

export function qualityReport(directory) {
  const dir=resolve(directory);
  const raw=read(join(dir,'independent-adjudications-portfolio.json'));
  write(dir,'measurement-adjudications.json',unmeasuredQualityProjection(raw));
  write(dir,'measurement-report.json',cli(['report',join(dir,'frozen.json'),join(dir,'collected-submissions.json'),join(dir,'measurement-adjudications.json'),'--json']));
  write(dir,'measurement-report.md',cli(['report',join(dir,'frozen.json'),join(dir,'collected-submissions.json'),join(dir,'measurement-adjudications.json')]));
  return read(join(dir,'measurement-report.json'));
}

export async function runClaude(directory, executable, model) {
  const dir = resolve(directory);
  requireModel(dir, model);
  if (['original-complete', 'compact', 'edge-independent', 'adjudication'].some(n => existsSync(join(dir, n + '.response.json')))) throw new Error('run outputs already exist; refusing repeat calls');
  const requests = ['original-complete', 'compact', 'edge-independent'].map(name => ({ name, prompt: reviewPrompt(dir, name) }));
  await Promise.all(requests.map(({ name, prompt }) => claudeRequest(dir, name, prompt, executable, model)));
  const summary = collect(dir, join(dir, 'original-complete.response.json'), join(dir, 'compact.response.json'), join(dir, 'edge-independent.response.json'));
  const independentReport = await adjudicatePortfolio(dir, executable, model);
  return { directory: dir, reviewSummary: summary, independentReport };
}

export function summarizeRun(directory) {
  const dir = resolve(directory);
  const names = ['original-complete', 'compact', 'edge-independent', 'adjudication', 'adjudication-retry', 'adjudication-pair', 'adjudication-portfolio', 'cache-repeat-1', 'cache-repeat-2'];
  const rows = names.filter(n => existsSync(join(dir, n + '.response.json'))).map(name => {
    const r = read(join(dir, name + '.response.json'));
    const totals = Object.values(r.modelUsage || {});
    const sum = key => totals.length && totals.every(m => Number.isFinite(m[key])) ? totals.reduce((s, m) => s + m[key], 0) : null;
    const inputTokens = sum('inputTokens'), cacheWriteTokens = sum('cacheCreationInputTokens'), cacheReadTokens = sum('cacheReadInputTokens');
    return { name, actualModel: r.actualModel, observedModels: Object.keys(r.modelUsage || {}), physicalCalls: r.physicalCalls,
      providerRequestCount: r.providerRequestCount, inputTokens, cacheWriteTokens, cacheReadTokens,
      totalInputTokens: [inputTokens, cacheWriteTokens, cacheReadTokens].every(Number.isFinite) ? inputTokens + cacheWriteTokens + cacheReadTokens : null,
      outputTokens: sum('outputTokens'), providerReportedCostUSD: r.providerReportedCostUSD, measuredCost: null,
      durationMs: r.durationMs, internalTurns: r.internalTurns };
  });
  const total = key => rows.length && rows.every(r => Number.isFinite(r[key])) ? rows.reduce((s, r) => s + r[key], 0) : null;
  const result = { version: 1, experimentDigest: read(join(dir, 'frozen.json')).digest,
    scope: 'All provider modelUsage entries, including auxiliary models, across every saved call and rejected adjudication', rows,
    totals: Object.fromEntries(['physicalCalls', 'providerRequestCount', 'inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'totalInputTokens', 'outputTokens', 'providerReportedCostUSD', 'measuredCost'].map(key => [key, total(key)])),
    limitations: ['A CLI invocation can make several provider requests; provider request count is unknown.', 'Multiple modelUsage entries leave singular actual model unknown rather than inferred from requested model.', 'API-equivalent list cost is not a subscription bill.', 'Calls are synthetic benchmark work, not production deliveries.'], automaticChanges: false, realHumanAcceptance: null };
  return result;
}

export function main(args) {
  if (args[0] === 'prepare' && [2, 3].includes(args.length)) return prepare(args[1], args[2] ?? null);
  if (args[0] === 'prepare-heldout' && [2, 3].includes(args.length)) return prepare(args[1], args[2] ?? null, true);
  if (args[0] === 'collect' && [4, 5].includes(args.length)) return collect(...args.slice(1));
  if (args[0] === 'run-claude' && args.length === 4) return runClaude(...args.slice(1));
  if (args[0] === 'adjudicate' && args.length === 4) return adjudicate(...args.slice(1));
  if (args[0] === 'cache-repeat' && args.length === 4) return cacheRepeat(...args.slice(1));
  if (args[0] === 'adjudicate-pair' && args.length === 4) return adjudicatePair(...args.slice(1));
  if (args[0] === 'adjudicate-portfolio' && args.length === 4) return adjudicatePortfolio(...args.slice(1));
  if (args[0] === 'summary' && args.length === 2) return summarizeRun(args[1]);
  if (args[0] === 'quality-report' && args.length === 2) return qualityReport(args[1]);
  if (args.length === 0 || args[0] === '--help') return 'node _workflow/live-benchmark.mjs prepare NEW_DIRECTORY [REQUESTED_MODEL]\nnode _workflow/live-benchmark.mjs collect DIRECTORY original.response.json compact.response.json [edge.response.json]\nnode _workflow/live-benchmark.mjs run-claude DIRECTORY CLAUDE_EXECUTABLE FROZEN_MODEL\nnode _workflow/live-benchmark.mjs {adjudicate|adjudicate-pair|adjudicate-portfolio|cache-repeat} DIRECTORY CLAUDE_EXECUTABLE FROZEN_MODEL\nnode _workflow/live-benchmark.mjs summary DIRECTORY\nprepare/collect/summary are offline. run-claude makes four real independent requests (three reviews in parallel, then blind adjudication); at most USD 1 CLI budget each, 180-second timeout each. Optional adjudication commands make one request each; cache-repeat makes two. See LIVE-BENCHMARK.md. Existing output files are never overwritten.';
  throw new Error('unknown command; use --help');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await main(process.argv.slice(2)); process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + '\n'); }
  catch (error) { process.stderr.write('live-benchmark: ' + error.message + '\n'); process.exitCode = 1; }
}
