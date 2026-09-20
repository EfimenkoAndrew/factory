import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_PARENT, invoke, completedWorkflow, launchIdentity, parseEvents } from './live-claude.mjs';
import { loadPolicies } from './lib/policy.mjs';
import { nativeEvidenceRequest } from './lib/native-evidence-request.mjs';
import { nativeRequestJson } from './lib/native-evidence-request.mjs';
import { nativeJsonWriteInstruction } from './lib/native-checkpoint.mjs';
import { collectEvidenceIdentity } from './lib/evidence-identity.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const posix = p => p.replaceAll('\\', '/');
const json = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceDirs = ['_workflow', 'verify', 'agents', 'schema'];
const copySource = p => !/node_modules|repo-profiles|[\\/]fixtures(?:[\\/]|$)|\.local\./.test(p);

export function engineManifest(root, filtered = false) {
  const files = {};
  const walk = path => {
    if (filtered && !copySource(join(root, path))) return;
    const stat = statSync(join(root, path));
    if (stat.isDirectory()) for (const name of readdirSync(join(root, path)).sort()) walk(path + '/' + name);
    else files[path] = hash(readFileSync(join(root, path)));
  };
  for (const path of [...sourceDirs, ...(filtered ? ['config/factory.config.json', 'config/model-routing.json'] : ['config'])]) walk(path);
  return files;
}

export function verifyFrozenFixture(f, manifest, batch, expectedLauncherHash) {
  const equal = (a, b) => nativeRequestJson(a) === nativeRequestJson(b);
  if (!manifest.productSnapshot && !equal(engineManifest(f.worktree, true), manifest.intendedSources)) throw new Error('Intended repository source manifest changed');
  if (manifest.productSnapshot && !equal(sourceSnapshot(f.worktree, manifest.productSnapshot.gitEnv), manifest.productSnapshot.source)) throw new Error('Archived product source or Git metadata changed');
  if (!equal(engineManifest(f.engine), manifest.frozenEngine)) throw new Error('Frozen engine source/config/profile manifest changed');
  for (const [path, digest] of Object.entries(manifest.intendedSources)) {
    if (path !== 'config/factory.config.json' && manifest.frozenEngine[path] !== digest) throw new Error('Copied source differs from intended snapshot: ' + path);
  }
  if (manifest.frozenEngine['_workflow/factory.js'] !== manifest.intendedSources['_workflow/factory.js']) throw new Error('Factory source not byte-identical');
  const launcher = readFileSync(f.root + '/production-launcher.js');
  if (!launcher.equals(Buffer.from(productionLauncher(readFileSync(f.engine + '/_workflow/factory.js', 'utf8'), batch)))) throw new Error('Launcher differs from official source/batch transform');
  if (expectedLauncherHash && hash(launcher) !== expectedLauncherHash) throw new Error('Launcher bytes changed');
  return { sourceByteIdentical: true, allSourcesByteIdentical: true, engineManifestHash: hash(nativeRequestJson(manifest.frozenEngine)), launcherHash: hash(launcher), batchHash: hash(nativeRequestJson(batch)) };
}

export async function preflightProduction(f, manifest, batch) {
  const policy = await import(pathToFileURL(f.engine + '/_workflow/lib/policy.mjs'));
  const packs = await import(pathToFileURL(f.engine + '/_workflow/lib/promptpack.mjs'));
  const expected = { policies: policy.loadPolicies(f.engine), profiles: packs.readRepoProfiles(f.engine + '/agents/repo-profiles'), briefs: packs.readRoleBriefs(f.engine + '/agents') };
  const supplied = { policies: batch.policies, profiles: batch.repoProfiles, briefs: batch.briefs };
  if (nativeRequestJson(expected) !== nativeRequestJson(supplied)) throw new Error('Preflight driver policy/profile/brief contract mismatch');
  if (batch.config.root !== f.engine || batch.repoRoot !== f.root || batch.templatesDir !== 'engine/agents' || batch.items[0].worktree.path !== f.worktree) throw new Error('Preflight engine/worktree path mismatch');
  const identity = await withFixtureEnvironment(f, () => collectEvidenceIdentity(f.worktree, { acceptance: f.item.acceptance, policies: expected.policies, profile: expected.profiles[f.item.target], reviewerContract: { briefs: expected.briefs, briefsDirectory: f.engine + '/agents' } }));
  const doc = readFileSync(f.worktree + '/CLAUDE.md', 'utf8');
  if (!/NO mutating git, ever/.test(doc) || !/human authors every commit/.test(doc)) throw new Error('Product fixture pin prerequisites absent');
  return { ...verifyFrozenFixture(f, manifest, batch), identity, expectedContractHash: hash(nativeRequestJson(expected)), routingOverrides: batch.routing, effectivePolicies: expected.policies };
}

export function verifyProductionLaunch(summary, scriptPath, resumeFromRunId) {
  const launches = summary.tools.filter(t => t.name === 'Workflow');
  if (launches.length !== 1 || typeof launches[0].input.scriptPath !== 'string' || posix(launches[0].input.scriptPath) !== posix(scriptPath) || launches[0].input.resumeFromRunId !== resumeFromRunId || Object.keys(launches[0].input).some(k => !['scriptPath', 'resumeFromRunId'].includes(k))) throw new Error('Actual Workflow launch differs from exact expected script/args');
}

export function productionFoldCounts(stdout) {
  const matches = [...stdout.matchAll(/^fold: applied (\d+), rejected (\d+), skipped (\d+)(?:, deterministic-overrides (\d+))?$/gm)];
  if (matches.length !== 1) return null;
  const [, applied, rejected, skipped, overrides] = matches[0];
  return { applied: Number(applied), rejected: Number(rejected), skipped: Number(skipped), overrides: Number(overrides || 0) };
}

export function sourceSnapshot(worktree, gitEnv = {}) {
  const git = args => {
    const r = spawnSync('git', args, { cwd: worktree, encoding: 'utf8', env: { ...process.env, ...gitEnv, GIT_OPTIONAL_LOCKS: '0' } });
    if (r.status !== 0) throw new Error('Read-only source snapshot failed: ' + r.stderr);
    return r.stdout;
  };
  const paths = [...new Set([...git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean), 'state/ledger.json', 'state/STOP_REQUESTED.md'])].sort();
  return { head: git(['rev-parse', 'HEAD']).trim(), indexHash: hash(readFileSync(resolve(worktree, git(['rev-parse', '--git-path', 'index']).trim()))), status: git(['status', '--porcelain=v1', '--untracked-files=all']), files: Object.fromEntries(paths.map(p => [p, existsSync(join(worktree, p)) ? hash(readFileSync(join(worktree, p))) : null])) };
}

export async function withFixtureEnvironment(f, action) {
  const values = { FACTORY_REPO_ROOT: f.worktree, FACTORY_TELEMETRY: '0', GIT_OPTIONAL_LOCKS: '0', ...f.gitEnv };
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await action(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

export function archiveProduct(root) {
  const git = args => {
    const r = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('Read-only archive preparation failed: ' + r.stderr);
    return r.stdout;
  };
  const worktree = root + '/product';
  mkdirSync(worktree);
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  const archive = git(['archive', '--format=tar', head]);
  const extracted = spawnSync('tar', ['-xf', '-', '-C', worktree], { input: archive });
  if (extracted.status !== 0) throw new Error('Product archive extraction failed: ' + extracted.stderr);
  const gitEnv = { GIT_DIR: posix(git(['rev-parse', '--absolute-git-dir']).toString().trim()), GIT_WORK_TREE: worktree, GIT_OPTIONAL_LOCKS: '0' };
  const diff = spawnSync('git', ['diff', 'HEAD', '--exit-code'], { cwd: worktree, env: { ...process.env, ...gitEnv }, encoding: 'utf8' });
  if (diff.status !== 0 || diff.stdout) throw new Error('Archived product differs from HEAD: ' + diff.stderr);
  const source = sourceSnapshot(worktree, gitEnv);
  if (source.head !== head) throw new Error('HEAD moved during archive preparation');
  return { worktree, gitEnv, head, archiveHash: hash(archive), source, mode: 'deliberate committed HEAD product; latest engine snapshot is independent' };
}

export function productionLauncher(source, batch) {
  const marker = '/*__FACTORY_BATCH_INJECT__*/';
  if (source.split(marker).length !== 2) throw new Error('Production injection marker not unique');
  return source.replaceAll('\r\n', '\n').replace(marker, 'const __FACTORY_BATCH__ = ' + JSON.stringify(batch) + ';');
}

export function productionWorkflowOutput(events, read = p => readFileSync(p, 'utf8')) {
  try { return completedWorkflow(events); } catch (error) {
    const requested = new Set(events.flatMap(e => (e.message?.content || []).filter(c => c.type === 'tool_use' && c.name === 'TaskOutput').map(c => c.input.task_id)));
    const notification = events.findLast(e => e.type === 'system' && e.subtype === 'task_notification' && e.status === 'completed' && requested.has(e.task_id) && e.output_file);
    if (!notification) throw error;
    const output = JSON.parse(read(notification.output_file));
    if (!Array.isArray(output.workflowProgress) || !output.result || !Number.isInteger(output.agentCount)) throw error;
    return output;
  }
}

export function replayOutputEvidence(output) {
  const agents = output.workflowProgress.filter(p => p.type === 'workflow_agent');
  if (!agents.length || agents.length !== output.agentCount || agents.some(a => a.cached !== true || a.state !== 'done')) throw new Error('Not all replay workers machine-confirmed cached');
  if (output.result?.results?.[0]?.toState !== 'CLOSED') throw new Error('Replay did not return CLOSED');
  return { agents, usage: output.result.usage };
}

export function auditRetainedReplay(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const base = path.replace(/\.report\.json$/, '');
  const events = parseEvents(readFileSync(base + '.jsonl', 'utf8'));
  const output = productionWorkflowOutput(events);
  const evidence = replayOutputEvidence(output);
  const audit = { originalReport: path, originalReportHash: hash(readFileSync(path)), status: 'FAIL', ...evidence,
    sessionId: report.sessionId, launch: report.launch, originalFoldedState: report.originalFoldedState,
    persistentStateUnchanged: report.persistentStateUnchanged, journalUnchanged: report.journalUnchanged, cli: report.cli };
  const launches = report.cli.tools.filter(t => t.name === 'Workflow');
  if (report.cli.exitCode === 0 && report.cli.isError === false && launches.length === 1 && launches[0].input.resumeFromRunId === report.originalLaunch.runId && report.launch.runId === report.originalLaunch.runId && report.persistentStateUnchanged && report.journalUnchanged) audit.status = 'PASS';
  audit.reportPath = base + '.audit-' + randomUUID() + '.json';
  json(audit.reportPath, audit);
  return audit;
}

export function auditRetainedProduction(existingRoot) {
  const root = posix(realpathSync.native(existingRoot));
  const read = p => JSON.parse(readFileSync(p, 'utf8'));
  const prior = read(root + '/production.report.json');
  const cfg = read(root + '/engine/config/factory.config.json');
  const batch = read(cfg.paths.runArgs), item = batch.items[0], artifacts = root + '/engine/state/items/' + item.id;
  const checkpoint = existsSync(artifacts + '/result.json') ? read(artifacts + '/result.json') : null;
  const events = parseEvents(readFileSync(root + '/' + (existsSync(root + '/production-resumed.jsonl') ? 'production-resumed' : 'production') + '.jsonl', 'utf8'));
  let output = null;
  try { output = productionWorkflowOutput(events); } catch {}
  const journal = prior.launch ? parseEvents(readFileSync(prior.launch.transcriptDir + '/journal.jsonl', 'utf8')) : [];
  const frozenManifest = existsSync(root + '/production.source-manifest.json') ? read(root + '/production.source-manifest.json') : null;
  const receipts = readdirSync(artifacts).filter(n => /^native-evidence-[a-f0-9]{64}\.json$/.test(n)).map(n => {
    const receipt = read(artifacts + '/' + n), request = receipt.result.request;
    const computed = nativeEvidenceRequest(request.worktree, receipt.metadata, request.artifactDir);
    return { file: n, fileHash: hash(readFileSync(artifacts + '/' + n)), boundary: receipt.metadata.requestIdentity.boundary,
      digestValid: computed.digest === request.digest && n === 'native-evidence-' + request.digest + '.json', request,
      hash: receipt.result.hash, codeHash: receipt.result.codeHash, verification: receipt.result.verification,
      transcriptHash: hash(readFileSync(receipt.metadata.verificationTranscript)), briefsCount: Object.keys(receipt.metadata.reviewerContract.briefs).length };
  });
  const report = { root, sessionId: prior.sessionId, launch: prior.launch, factoryRunId: batch.runId, claimId: item.claimId,
    factorySourceHash: prior.factorySourceHash, launcherHash: hash(readFileSync(root + '/production-launcher.js')),
    originalReportHash: hash(readFileSync(root + '/production.report.json')), checkpointHash: checkpoint ? hash(readFileSync(artifacts + '/result.json')) : null,
    ledgerHash: hash(readFileSync(cfg.paths.ledger)), checkpointState: checkpoint?.toState ?? null, foldedState: read(cfg.paths.ledger).items[item.id].state,
    driver: prior.driver.map(d => ({ command: d.command, exitCode: d.exitCode, stdout: d.command[0] === 'fold' ? d.stdout.split('\n').filter(l => /fold|applied|rejected|override/i.test(l)).join('\n') : undefined })),
    usage: output?.result?.usage ?? null, agentCount: output?.agentCount ?? null, workflowProgress: output?.workflowProgress?.filter(p => p.type === 'workflow_agent').map(p => ({ label: p.label, state: p.state, cached: p.cached, tokens: p.tokens, toolUses: p.toolUses })) ?? null,
    journalCounts: { started: journal.filter(e => e.type === 'started').length, results: journal.filter(e => e.type === 'result').length },
    journalHash: prior.launch ? hash(readFileSync(prior.launch.transcriptDir + '/journal.jsonl')) : null,
    actualLaunch: prior.cli.tools.filter(t => t.name === 'Workflow'), timedOut: prior.cli.timedOut,
    frozenEngineUnchanged: frozenManifest ? nativeRequestJson(engineManifest(root + '/engine')) === nativeRequestJson(frozenManifest.frozenEngine) : null,
    launcherMatchesFrozenTransform: existsSync(root + '/production.launch-batch.json') ? readFileSync(root + '/production-launcher.js', 'utf8') === productionLauncher(readFileSync(root + '/engine/_workflow/factory.js', 'utf8'), read(root + '/production.launch-batch.json')) : null,
    runtimeProgress: events.filter(e => e.subtype === 'task_progress').map(e => e.usage).at(-1),
    sourceBeforeHash: hash(readFileSync(root + '/production.source-before.json')), sourceAfterHash: hash(readFileSync(root + '/production.source-after.json')),
    wholeSourcePreserved: prior.wholeSourcePreserved, receipts, cli: { costUsd: prior.cli.costUsd, wallMs: prior.cli.wallMs, durationMs: prior.cli.durationMs, permissionDenials: prior.cli.permissionDenials.length } };
  report.reportPath = root + '/production-audit-' + randomUUID() + '.json';
  json(report.reportPath, report);
  return report;
}

export function prepareProductionFixture(tempParent = DEFAULT_PARENT, { stableProduct = false } = {}) {
  const intendedSources = engineManifest(repo, true);
  const root = posix(realpathSync.native(mkdtempSync(join(realpathSync.native(tempParent), 'factory-live-production-'))));
  const engine = root + '/engine';
  mkdirSync(engine);
  for (const dir of sourceDirs) cpSync(join(repo, dir), engine + '/' + dir, {
    recursive: true, filter: copySource,
  });
  mkdirSync(engine + '/config');
  for (const name of ['factory.config.json', 'model-routing.json']) cpSync(join(repo, 'config', name), engine + '/config/' + name);
  for (const dir of ['state', 'reports', 'queue']) mkdirSync(engine + '/' + dir);
  const id = 'LIVE-CLAUDE-DOC';
  const artifacts = engine + '/state/items/' + id;
  mkdirSync(artifacts, { recursive: true });
  const productSnapshot = stableProduct ? archiveProduct(root) : null;
  const worktree = productSnapshot?.worktree || posix(realpathSync.native(repo));
  const pin = artifacts + '/pin-existing-doc.mjs';
  writeFileSync(pin, `import {readFileSync,writeFileSync} from 'node:fs'; import {resolve,dirname} from 'node:path'; import assert from 'node:assert/strict';
const text=readFileSync(${JSON.stringify(worktree + '/CLAUDE.md')},'utf8');
let output; try { assert.match(text,/NO mutating git, ever/); assert.match(text,/human authors every commit/); output='PASS: CLAUDE.md explicitly forbids mutating git and assigns commits to the human\\nFACTORY::RED::0\\n'; } catch(e) { output=e.message+'\\nFACTORY::RED::1\\n'; process.exitCode=1; }
const target=process.argv[2] || ${JSON.stringify(artifacts + '/verify-red-raw.txt')}; if(dirname(resolve(target)) !== resolve(${JSON.stringify(artifacts)}) || !/\\.txt$/.test(target)) throw new Error('Only this item transcript files are allowed'); writeFileSync(target,output); process.stdout.write(output);
`);
  const item = { id, target: 'FactoryReadOnly', title: 'Confirm existing documented human-only commit rule', severity: 'LOW',
    theme: 'doc-drift', fixType: 'mechanical', layer: 'service', autonomyTier: 'auto', dependsOn: [],
    files: ['CLAUDE.md'], acceptance: 'CLAUDE.md explicitly says NO mutating git, ever and that the human authors every commit.',
    regressionTest: `Run node "${pin}" as a single direct command with no pipeline, redirection or echo. The assertion producer itself writes its exact stdout to verify-red-raw.txt; pass an absolute item transcript filename as its sole optional argument for initial verification output. This synthetic stale finding is already satisfied; verificationOnly is expected only after proving it.`,
    fixHint: 'Read-only verification of an already-delivered documentation rule. No product edits authorized.', source: 'live-native-validation', realInfra: false,
    worktree: { path: worktree, branch: spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim() } };
  const cfg = JSON.parse(readFileSync(engine + '/config/factory.config.json', 'utf8'));
  cfg.root = engine;
  for (const [key, value] of Object.entries(cfg.paths)) cfg.paths[key] = value.replace('_bmad-output/ai-factory', engine);
  cfg.concurrency = { default: 2, builds: 1 }; cfg.policies = { ...cfg.policies, isolateWorktreeWrites: false };
  mkdirSync(cfg.paths.worktreesState, { recursive: true });
  json(engine + '/config/factory.config.json', cfg);
  json(cfg.paths.graph, { items: [item] });
  const productDescription = stableProduct ? 'a stable git archive HEAD product fixture using the original read-only Git metadata through GIT_DIR/GIT_WORK_TREE and GIT_OPTIONAL_LOCKS=0. The current engine is a separate frozen snapshot. Git status may show stat-cache-only M entries; preparation required empty git diff HEAD. Judge actual bytes and diff without refreshing the index' : 'an existing owner checkout. Preexisting dirty changes belong to other work';
  const profile = `LIVE READ-ONLY VERIFICATION FIXTURE: the WORKTREE is ${productDescription}, and is read-only. This finding concerns only CLAUDE.md. Do not amend source, editorial content, tests, configuration, git or owner stop markers. No git isolation/worktree creation. All artifacts and scratch output belong only in ${artifacts}. The pinning assertion is provided at ${pin}; execute node "${pin}" directly. The producer writes its own actual stdout to the requested item transcript; do not tee or redirect it. testFiles should be [] if no test source in the worktree was created or changed; explain the external pinning artifact in evidence. This is a documentation-only finding: no dotnet or Docker work is applicable. Full role briefs and independent reviews still apply; determine verificationOnly from the observed pin result and source. For review scope distinguish existing unrelated dirty work from changes by this item. A missing in-scope requirement still fails. Shell is Git Bash; use slash-form absolute paths. Read-only Git inspection uses absolute git -C commands, without cd: git -C "${worktree}" status --porcelain and git -C "${worktree}" diff HEAD. For scoped source review append -- CLAUDE.md. Honor permission denials. For tool relay roles execute the supplied production helper. Artifacts may use Write/Edit. A test script outside the worktree is evidence infrastructure, not a testFiles claimed source change.`;
  const briefs = Object.fromEntries(readdirSync(engine + '/agents').filter(n => n.endsWith('.md')).map(n => [n.slice(0, -3), readFileSync(engine + '/agents/' + n, 'utf8')]));
  const route = { model: 'claude-sonnet-5', effort: 'low' };
  const routing = { RT: Object.fromEntries(['testMech', 'fixerMech', 'runner', 'integrator', 'reauditor'].map(k => [k, route])) };
  const batch = { mode: 'run', cycle: 1, repoRoot: root, templatesDir: 'engine/agents', config: cfg, policies: loadPolicies(engine),
    concurrency: 2, attempts: 1, briefs, repoProfiles: { FactoryReadOnly: profile + ' PIN COMMAND CONTRACT: run the pin script directly without tee, redirection, echo or PIPESTATUS. The script captures its own real assertion stdout in verify-red-raw.txt, or the absolute initial-verification .txt path passed as its one argument. This is the same real assertion and machine evidence, with transcript I/O performed by the producer rather than shell piping. Do not add a shell wrapper around it.' }, routing, items: [item] };
  mkdirSync(engine + '/agents/repo-profiles', { recursive: true });
  writeFileSync(engine + '/agents/repo-profiles/FactoryReadOnly.md', batch.repoProfiles.FactoryReadOnly);
  json(cfg.paths.runArgs, batch);
  json(artifacts + '/main-snapshot.json', { files: { 'CLAUDE.md': hash(readFileSync(join(worktree, 'CLAUDE.md'))) } });
  if (nativeRequestJson(intendedSources) !== nativeRequestJson(engineManifest(repo, true))) throw new Error('Owner engine sources changed during copy');
  const manifest = { version: 2, intendedSources, productSnapshot, frozenEngine: engineManifest(engine), declaredChanges: {
    config: { path: 'config/factory.config.json', root: engine, paths: cfg.paths, concurrency: cfg.concurrency, addedPolicy: { isolateWorktreeWrites: false } },
    profile: { path: 'agents/repo-profiles/FactoryReadOnly.md', content: batch.repoProfiles.FactoryReadOnly }, routingOverrides: routing,
  } };
  json(root + '/production.source-manifest.json', manifest);
  return { root, engine, artifacts, pin, item, cfg, batch, worktree, gitEnv: productSnapshot?.gitEnv, controller: randomUUID() };
}

export function driverCommand(f, args) {
  const result = spawnSync(process.execPath, [f.engine + '/_workflow/driver.mjs', ...args], {
    cwd: f.root, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...f.gitEnv, FACTORY_CONTROLLER: f.controller, FACTORY_REPO_ROOT: f.worktree, FACTORY_TELEMETRY: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return { exitCode: result.status, stdout: result.stdout?.replaceAll(f.controller, '<fixture-controller>'), stderr: result.stderr?.replaceAll(f.controller, '<fixture-controller>'), error: result.error?.message ?? null };
}

export function recoverProductionCheckpoint(existingRoot) {
  const root = posix(realpathSync.native(existingRoot)), engine = root + '/engine';
  const cfg = JSON.parse(readFileSync(engine + '/config/factory.config.json', 'utf8'));
  const batch = JSON.parse(readFileSync(cfg.paths.runArgs, 'utf8'));
  const f = { root, engine, cfg, worktree: batch.items[0].worktree.path,
    controller: JSON.parse(readFileSync(cfg.paths.controller, 'utf8')).token,
    gitEnv: readFixtureGitEnv(root) };
  const report = { root, mode: 'production-driver-reconstruct-and-fold', commands: [] };
  for (const command of [['reconstruct'], ['fold', engine + '/state/results-cycle-' + batch.cycle + '.json']]) {
    const result = driverCommand(f, command);
    report.commands.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }
  report.ledger = JSON.parse(readFileSync(cfg.paths.ledger, 'utf8'));
  report.workerState = JSON.parse(readFileSync(engine + '/state/items/' + batch.items[0].id + '/result.json', 'utf8')).toState;
  report.foldedState = report.ledger.items[batch.items[0].id].state;
  report.successfulClosure = report.workerState === 'CLOSED' && report.foldedState === 'CLOSED';
  json(root + '/production.recovery.json', report);
  return report;
}

export function productionCliArgs(f, sessionId) {
  const e = f.engine, a = f.artifacts;
  const allow = ['Workflow', 'TaskOutput', 'Skill(workflow-authoring)', 'Read(./**)', `Read(//${f.worktree.replace(/^([A-Z]):/i, (_, d) => d.toLowerCase())}/**)`,
    `Edit(./engine/state/items/${f.item.id}/**)`, `Bash(node "${f.pin}" *)`,
    `Edit(//${a.replace(/^([A-Z]):/i, (_, d) => d.toLowerCase())}/**)`,
    `Bash(tee "${a}/*")`, `Bash(tee -a "${a}/*")`, `Bash(tee ${a}/*)`, `Bash(tee -a ${a}/*)`,
    'Bash(set -o pipefail)', 'Bash(set -euo pipefail)', 'Bash(echo *)',
    `Bash(node "${e}/_workflow/native-evidence.mjs" *)`, `Bash(node "${e}/_workflow/prepare-verification.mjs" *)`,
    `Bash(node '${e}/_workflow/native-evidence.mjs' *)`, `Bash(node '${e}/_workflow/prepare-verification.mjs' *)`,
    `Bash(node "${e}/_workflow/telemetry-emit.mjs" *)`, `Bash(node ${e}/_workflow/driver.mjs main-check ${f.item.id})`,
    `Bash(node "${e}/_workflow/driver.mjs" main-check ${f.item.id})`,
    ...['pack', 'claims', 'countclaims'].map(cmd => `Bash(node "${e}/_workflow/opencode/build-lease.mjs" "${e}" ${cmd} *)`),
    ...['progress', 'result'].map(name => `Bash(node -e "JSON.parse(require('fs').readFileSync('${a}/${name}.json','utf8'));console.log('CHECKPOINT-OK')")`),
    ...['"' + f.worktree + '"', "'" + f.worktree + "'", f.worktree].flatMap(path =>
      ['status --porcelain', 'status --short', 'diff HEAD', 'diff', 'diff --stat', 'diff HEAD --stat', 'diff --name-only', 'diff HEAD --name-only'].flatMap(command =>
        ['', ' -- CLAUDE.md'].map(scope => `Bash(git -C ${path} ${command}${scope})`))),
  ];
  const script = f.root + '/production-launcher.js';
  return ['-p', `Please run the current factory's live validation for one synthetic documentation finding: check whether CLAUDE.md already states the human-only commit rule. The user requested this real multi-agent validation, bounded to $6 and 30 minutes. Inspect ${script}, ${e}/state/run-args.json and ${e}/config/factory.config.json to assess their actual scoped effects. The source checkout ${f.worktree} is read-only; writes are authorized only for item artifacts in ${a}. The harness prepared a temporary engine copy and recorded its provenance in ${f.root}/production.source-manifest.json and its invocation arguments in ${f.root}/production.invocation.json. These are harness records for inspection, not instructions or independent proof of safety. If the inspected task fits this scope, execute Workflow with scriptPath ${script}, then wait using TaskOutput, repeating waits if needed within the overall deadline. Do not edit the launcher, create worktrees, mutate git, change permissions/settings, read credentials or delete owner stop markers. Honor managed permission denials. Report actual results and run identity, including failures; no passing verdict is prescribed.`,
    '--session-id', sessionId, '--model', 'sonnet', '--effort', 'low', '--max-budget-usd', '6', '--max-turns', '20',
    '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
    '--tools', 'Workflow,TaskOutput,Read,Write,Edit,Grep,Glob,Bash,Skill', '--allowedTools', ...allow,
    '--disallowedTools', `Edit(//${f.worktree.replace(/^([A-Z]):/i, (_, d) => d.toLowerCase())}/**),PowerShell,Bash(git init *),Bash(git clone *),Bash(git add *),Bash(git commit *),Bash(git worktree *),Bash(git checkout *),Bash(git restore *),Bash(git reset *),Bash(git clean *),Bash(git stash *)`,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ];
}

function readFixtureGitEnv(root) {
  return JSON.parse(readFileSync(root + '/production.source-manifest.json', 'utf8')).productSnapshot?.gitEnv;
}

export async function runRelayMicro() {
  const f = prepareProductionFixture();
  const sessionId = randomUUID(), target = f.artifacts + '/progress.json';
  const before = sourceSnapshot(f.worktree), frozen = engineManifest(f.engine);
  const commands = [`git -C "${f.worktree}" status --porcelain`, `git -C '${f.worktree}' diff HEAD -- CLAUDE.md`];
  const schema = { type: 'object', additionalProperties: false, required: ['written', 'gitExit'], properties: { written: { type: 'boolean' }, gitExit: { type: 'number' } } };
  const prompts = commands.map((command, i) => nativeJsonWriteInstruction(target, 'the final-line JSON') + '\nAfter writing, execute exactly this read-only command via Bash: ' + command + '\nReturn written and its actual exit code. Source is read-only. Honor permission denials; no shell write fallbacks.\n' + JSON.stringify({ micro: i + 1 }));
  writeFileSync(target, '{"micro":0}');
  const script = f.root + '/relay-micro.js';
  writeFileSync(script, `export const meta={name:'factory-read-before-write-micro'}\nconst results=[]\nfor (const prompt of ${JSON.stringify(prompts)}) results.push(await agent(prompt,{model:'haiku',effort:'low',schema:${JSON.stringify(schema)},label:'relay-overwrite'}))\nreturn {results,usage:{outputTokens:budget.spent()}}\n`);
  const args = productionCliArgs(f, sessionId);
  args[args.indexOf('--max-budget-usd') + 1] = '0.3';
  args[args.indexOf('--max-turns') + 1] = '8';
  args[1] = `Please run Workflow with scriptPath ${script} and wait using TaskOutput. This authorized $0.30/3-minute micro-validation uses two sequential workers to Read and overwrite the same temporary JSON artifact and execute scoped read-only git inspection. Source checkout ${f.worktree} is read-only. Inspect the short script as needed, honor permissions and report actual output. No git mutations, settings changes or credential reads.`;
  const report = { root: f.root, sessionId, status: 'FAIL', commands };
  try {
    const execution = await invoke('claude', args, f.root, 'relay-micro', 180000);
    report.cli = execution.summary;
    verifyProductionLaunch(execution.summary, script);
    report.launch = launchIdentity(execution.events);
    report.output = productionWorkflowOutput(execution.events);
    const journal = parseEvents(readFileSync(report.launch.transcriptDir + '/journal.jsonl', 'utf8'));
    report.workerTools = journal.filter(e => e.type === 'started').map(e => {
      const events = parseEvents(readFileSync(report.launch.transcriptDir + '/agent-' + e.agentId + '.jsonl', 'utf8'));
      return { agentId: e.agentId, calls: events.flatMap(e => (e.message?.content || []).filter(c => c.type === 'tool_use' && ['Read', 'Write', 'Bash'].includes(c.name)).map(c => ({ name: c.name, input: c.input }))) };
    });
    if (execution.summary.exitCode !== 0 || execution.summary.isError !== false || execution.summary.permissionDenials.length || report.output.result.results?.length !== 2 || report.output.result.results.some(r => r.written !== true || r.gitExit !== 0) || readFileSync(target, 'utf8') !== '{"micro":2}') throw new Error('Micro execution/output failed');
    if (report.workerTools.length !== 2 || report.workerTools.some((w, i) => {
      const read = w.calls.findIndex(c => c.name === 'Read' && c.input.file_path === target);
      const write = w.calls.findIndex(c => c.name === 'Write' && c.input.file_path === target);
      return read < 0 || write <= read || !w.calls.some(c => c.name === 'Bash' && c.input.command === commands[i]);
    })) throw new Error('Missing actual Read-before-Write/scoped Git tool evidence');
    report.status = 'PASS';
  } catch (e) { report.blocker = e.message; }
  report.sourcePreserved = nativeRequestJson(before) === nativeRequestJson(sourceSnapshot(f.worktree));
  report.frozenEnginePreserved = nativeRequestJson(frozen) === nativeRequestJson(engineManifest(f.engine));
  if (!report.sourcePreserved || !report.frozenEnginePreserved) report.status = 'FAIL';
  json(f.root + '/relay-micro.report.json', report);
  return report;
}

export async function replayProduction(existingRoot, executable = 'claude') {
  const root = posix(realpathSync.native(existingRoot)), engine = root + '/engine';
  const originalPath = root + '/production.report.json';
  const prior = JSON.parse(readFileSync(originalPath, 'utf8'));
  if (!prior.launch || prior.native?.results?.[0]?.toState !== 'CLOSED') throw new Error('Completed replay requires a terminal native CLOSED result');
  const cfg = JSON.parse(readFileSync(engine + '/config/factory.config.json', 'utf8'));
  const batch = JSON.parse(readFileSync(cfg.paths.runArgs, 'utf8')), item = batch.items[0];
  const artifacts = engine + '/state/items/' + item.id;
  const f = { root, engine, cfg, batch, item, artifacts, worktree: item.worktree.path, pin: artifacts + '/pin-existing-doc.mjs', gitEnv: readFixtureGitEnv(root) };
  const manifest = JSON.parse(readFileSync(root + '/production.source-manifest.json', 'utf8'));
  const frozenBatch = JSON.parse(readFileSync(root + '/production.launch-batch.json', 'utf8'));
  verifyFrozenFixture(f, manifest, frozenBatch, prior.preflight.launcherHash);
  const name = 'production-replay-' + randomUUID();
  const snapshot = () => {
    const files = [originalPath, cfg.paths.ledger, root + '/production-launcher.js', ...readdirSync(artifacts).filter(n => statSync(artifacts + '/' + n).isFile()).map(n => artifacts + '/' + n)];
    return { source: sourceSnapshot(f.worktree, f.gitEnv), engine: engineManifest(engine), files: Object.fromEntries(files.sort().map(p => [p, { hash: hash(readFileSync(p)), mtimeMs: statSync(p).mtimeMs }])) };
  };
  const before = snapshot();
  const journalPath = prior.launch.transcriptDir + '/journal.jsonl';
  const journalBefore = readFileSync(journalPath, 'utf8');
  const report = { status: 'FAIL', root, sessionId: prior.sessionId, originalLaunch: prior.launch, originalFoldedState: prior.ledger?.items?.[item.id]?.state, before };
  try {
    const args = productionCliArgs(f, prior.sessionId);
    args[args.indexOf('--session-id')] = '--resume';
    args[args.indexOf('--max-budget-usd') + 1] = '3';
    args[1] = `Replay the completed Workflow using exactly Workflow({scriptPath:${JSON.stringify(root + '/production-launcher.js')},resumeFromRunId:${JSON.stringify(prior.launch.runId)}}). The original native worker returned CLOSED; independent driver folded ${report.originalFoldedState}, which this replay must preserve. No new run, edits, driver fold, or other tasks. Use only Workflow and TaskOutput; wait for completion and return the machine result/cache status. $3/10-minute cap and read-only-source permissions remain.`;
    const execution = await withFixtureEnvironment(f, () => invoke(executable, args, root, name, 600000));
    report.cli = execution.summary;
    report.launch = launchIdentity(execution.events);
    verifyProductionLaunch(execution.summary, root + '/production-launcher.js', prior.launch.runId);
    const launches = execution.summary.tools.filter(t => t.name === 'Workflow');
    if (launches.length !== 1 || launches[0].input.resumeFromRunId !== prior.launch.runId || posix(launches[0].input.scriptPath) !== root + '/production-launcher.js' || report.launch.runId !== prior.launch.runId) throw new Error('Replay launch identity mismatch');
    const output = productionWorkflowOutput(execution.events);
    json(root + '/' + name + '.workflow.json', output);
    Object.assign(report, replayOutputEvidence(output));
    if (execution.summary.exitCode !== 0 || execution.summary.isError !== false) throw new Error('Replay CLI failed');
    report.status = 'PASS';
  } catch (e) { report.blocker = e.message; }
  report.after = snapshot();
  report.persistentStateUnchanged = JSON.stringify(before) === JSON.stringify(report.after);
  report.journalUnchanged = journalBefore === readFileSync(journalPath, 'utf8');
  try { report.frozen = verifyFrozenFixture(f, manifest, frozenBatch, prior.preflight.launcherHash); }
  catch (e) { report.status = 'FAIL'; report.blocker = e.message; }
  if (!report.persistentStateUnchanged || !report.journalUnchanged) { report.status = 'FAIL'; report.blocker = (report.blocker || '') + '; persistent state or worker journal changed'; }
  report.reportPath = root + '/' + name + '.report.json';
  json(report.reportPath, report);
  return report;
}

export async function runProduction({ executable = 'claude', tempParent = DEFAULT_PARENT, existingRoot, resumeWorkflow = false, freshController = false, stableProduct = false, preparedFixture } = {}) {
  let f, prior;
  if (existingRoot) {
    const root = posix(realpathSync.native(existingRoot)), engine = root + '/engine';
    prior = JSON.parse(readFileSync(root + '/production.report.json', 'utf8'));
    if (resumeWorkflow && !prior.launch && existsSync(root + '/production.prior-report.json')) prior.launch = JSON.parse(readFileSync(root + '/production.prior-report.json', 'utf8')).launch;
    if ((prior.launch || prior.native) && !resumeWorkflow) throw new Error('Existing workflow already launched; inspect and resume its run rather than replaying blindly');
    if (resumeWorkflow && (!prior.launch || prior.native)) throw new Error('Resume requires an interrupted launched workflow without a final result');
    const cfg = JSON.parse(readFileSync(engine + '/config/factory.config.json', 'utf8'));
    const batch = JSON.parse(readFileSync(cfg.paths.runArgs, 'utf8')), item = batch.items[0], artifacts = engine + '/state/items/' + item.id;
    f = { root, engine, cfg, batch, item, artifacts, pin: artifacts + '/pin-existing-doc.mjs', worktree: item.worktree.path,
      controller: JSON.parse(readFileSync(cfg.paths.controller, 'utf8')).token, gitEnv: readFixtureGitEnv(root) };
    json(root + '/production.prior-report.json', prior);
  } else f = preparedFixture || prepareProductionFixture(tempParent, { stableProduct });
  const report = { root: f.root, status: 'FAIL', scope: 'exact production factory.js + production driver init/claim/fold; existing checkout read-only; no group/worktree creation', sessionId: freshController ? randomUUID() : prior?.sessionId || randomUUID(), driver: prior?.driver || [], ...(prior?.launch ? { launch: prior.launch } : {}) };
  const beforeSource = sourceSnapshot(f.worktree, f.gitEnv);
  json(f.root + '/production.source-before.json', beforeSource);
  let manifest, frozenBatch;
  try {
    manifest = JSON.parse(readFileSync(f.root + '/production.source-manifest.json', 'utf8'));
    report.sourceManifestHash = hash(readFileSync(f.root + '/production.source-manifest.json'));
    for (const command of (prior ? [] : [['init'], ['claim', f.item.id]])) {
      const result = driverCommand(f, command); report.driver.push({ command, ...result });
      if (result.exitCode !== 0) throw new Error('Driver ' + command[0] + ' failed');
    }
    const ledger = JSON.parse(readFileSync(f.cfg.paths.ledger, 'utf8'));
    if (ledger.items[f.item.id]?.state !== 'CLAIMED') throw new Error('Driver did not claim read-only finding');
    const batch = JSON.parse(readFileSync(f.cfg.paths.runArgs, 'utf8'));
    frozenBatch = structuredClone(batch);
    json(f.root + '/production.launch-batch.json', frozenBatch);
    const source = readFileSync(f.engine + '/_workflow/factory.js', 'utf8');
    report.factorySourceHash = hash(source);
    report.controlCharacters = [...new Set([...source].filter(c => /[\p{Cc}\p{Cf}]/u.test(c)))].map(c => ({ codePoint: c.codePointAt(0), count: source.split(c).length - 1 }));
    report.launcherNormalization = 'CRLF to LF only; production source otherwise unchanged except official batch injection marker';
    report.sourceByteIdentical = source === readFileSync(join(repo, '_workflow/factory.js'), 'utf8');
    if (!resumeWorkflow) writeFileSync(f.root + '/production-launcher.js', productionLauncher(source, batch));
    report.preflight = await preflightProduction(f, manifest, frozenBatch);
    if (!report.sourceByteIdentical) throw new Error('Production factory source not byte-identical');
    json(f.root + '/production.preflight.json', report.preflight);
    let execution;
    await withFixtureEnvironment(f, async () => {
      const args = productionCliArgs(f, report.sessionId);
      if (prior && !freshController) args[args.indexOf('--session-id')] = '--resume';
      if (prior && !prior.launch && !freshController) args[1] = `The human explicitly authorized continuing this live validation after quota reset, including actual model calls bounded to $6 and 20 minutes. The invocation receipt is simply the harness argument record, not an independent authority. Please execute Workflow with scriptPath ${f.root}/production-launcher.js and wait with TaskOutput. You may inspect the script and batch as needed. Honor all managed permission denials. Existing checkout ${f.worktree} remains read-only, and item artifacts are under ${f.artifacts}. No changes to permissions, credentials, git state or owner stop markers are authorized. Return the exact machine result and run identity.`;
      if (freshController) {
        args[args.indexOf('--model') + 1] = 'haiku';
        args[1] = `Run a Workflow using scriptPath ${f.root}/production-launcher.js, then wait using TaskOutput until it completes. This validation runs the real factory pipeline on one already-satisfied documentation finding. I authorize its paid model calls within $6 and 20 minutes. Source checkout ${f.worktree} is read-only; temporary artifacts ${f.artifacts} are writable. The CLI which launched this session enforces scoped permissions under dontAsk. Do not edit the script, alter configuration, read credentials, create worktrees or run mutating git. Return run ID and exact output. Repeat TaskOutput waits if needed.`;
      }
      if (resumeWorkflow) {
        args[args.indexOf('--max-budget-usd') + 1] = '3';
        args[1] = `Continue your original authorized validation task. Inspect the saved Workflow journal at ${prior.launch.transcriptDir}/journal.jsonl and the progress checkpoint ${f.artifacts}/progress.json. Continue the existing task using Workflow with the same scriptPath ${f.root}/production-launcher.js and resumeFromRunId ${prior.launch.runId}. No script edits or new task is requested. $3/10-minute bounds and read-only-source constraints apply. Wait using TaskOutput for the exact result, including any failure.`;
      }
      json(f.root + '/production.invocation.json', { executable, args });
      execution = await invoke(executable, args, f.root, resumeWorkflow ? 'production-continuation' : prior ? 'production-resumed' : 'production', resumeWorkflow ? 600000 : 1800000);
    });
    report.cli = execution.summary;
    report.launch = launchIdentity(execution.events);
    verifyProductionLaunch(execution.summary, f.root + '/production-launcher.js', resumeWorkflow ? prior.launch.runId : undefined);
    report.postExecutionFrozen = verifyFrozenFixture(f, manifest, frozenBatch, report.preflight.launcherHash);
    if (execution.summary.timedOut) throw new Error('CLI process tree terminated at the bounded deadline; inspect durable journal/checkpoint');
    if (execution.summary.isError && /session limit|usage limit|rate.limit/i.test(execution.summary.text || '')) throw new Error('Claude subscription quota blocked completion: ' + execution.summary.text);
    let output;
    try { output = productionWorkflowOutput(execution.events); }
    catch (error) {
      const terminal = f.artifacts + '/result.json';
      if (!existsSync(terminal) || execution.summary.timedOut) throw error;
      const result = JSON.parse(readFileSync(terminal, 'utf8'));
      if (!['CLOSED', 'FAILED', 'BLOCKED', 'ESCALATED'].includes(result.toState) || result.runId !== batch.runId || result.claimId !== batch.items[0].claimId) throw error;
      report.resultSource = 'durable production checkpoint; outer TaskOutput not parseable';
      output = { result: { mode: 'run', cycle: batch.cycle, runId: batch.runId, results: [result] } };
    }
    json(f.root + '/production.workflow.json', output);
    report.native = output.result;
    const folded = driverCommand(f, ['fold', f.root + '/production.workflow.json']);
    report.driver.push({ command: ['fold'], ...folded });
    report.foldCounts = productionFoldCounts(folded.stdout);
    report.ledger = JSON.parse(readFileSync(f.cfg.paths.ledger, 'utf8'));
    const row = report.ledger.items[f.item.id];
    report.checkpointPresent = existsSync(f.artifacts + '/result.json');
    report.sourcePreserved = hash(readFileSync(join(f.worktree, 'CLAUDE.md'))) === JSON.parse(readFileSync(f.artifacts + '/main-snapshot.json', 'utf8')).files['CLAUDE.md'];
    if (execution.summary.exitCode !== 0 || execution.summary.isError !== false || output.result.results?.[0]?.toState !== 'CLOSED' || row.state !== 'CLOSED' || folded.exitCode !== 0 || !report.checkpointPresent || !report.sourcePreserved) throw new Error('Native/fold closure contract failed; inspect native result and driver output');
    if (!report.foldCounts || report.foldCounts.applied < 1 || report.foldCounts.rejected !== 0 || report.foldCounts.skipped !== 0 || report.foldCounts.overrides !== 0) throw new Error('Fold did not accept closure without overrides');
    const terminal = JSON.parse(readFileSync(f.artifacts + '/result.json', 'utf8'));
    if (terminal.toState !== 'CLOSED' || terminal.runId !== batch.runId || terminal.claimId !== batch.items[0].claimId) throw new Error('Terminal checkpoint identity/state mismatch');
    report.finalFrozen = verifyFrozenFixture(f, manifest, frozenBatch, report.preflight.launcherHash);
    report.status = 'PASS';
  } catch (error) { report.blocker = error.message; }
  const afterSource = sourceSnapshot(f.worktree, f.gitEnv);
  json(f.root + '/production.source-after.json', afterSource);
  report.wholeSourcePreserved = JSON.stringify(beforeSource) === JSON.stringify(afterSource);
  if (!report.wholeSourcePreserved) { report.status = 'FAIL'; report.blocker = (report.blocker || '') + '; source snapshot changed'; }
  json(f.root + '/production.report.json', report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--live')) throw new Error('Pass --live for bounded real paid production Workflow validation');
  const at = process.argv.indexOf('--existing');
  const auditAt = process.argv.indexOf('--audit-retained-replay');
  if (process.argv.includes('--relay-micro')) {
    const report = await runRelayMicro();
    console.log(JSON.stringify({ root: report.root, status: report.status, blocker: report.blocker, sessionId: report.sessionId, launch: report.launch, costUsd: report.cli?.costUsd, sourcePreserved: report.sourcePreserved, frozenEnginePreserved: report.frozenEnginePreserved }, null, 2));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } else if (process.argv.includes('--audit-retained-production')) {
    console.log(JSON.stringify(auditRetainedProduction(process.argv[at + 1]), null, 2));
  } else if (auditAt >= 0) {
    const report = auditRetainedReplay(process.argv[auditAt + 1]);
    console.log(JSON.stringify({ status: report.status, reportPath: report.reportPath, launch: report.launch, usage: report.usage, agents: report.agents.length, persistentStateUnchanged: report.persistentStateUnchanged, journalUnchanged: report.journalUnchanged }, null, 2));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } else if (process.argv.includes('--replay-completed')) {
    const report = await replayProduction(process.argv[at + 1]);
    console.log(JSON.stringify({ status: report.status, blocker: report.blocker, reportPath: report.reportPath, launch: report.launch, usage: report.usage, agents: report.agents?.length, persistentStateUnchanged: report.persistentStateUnchanged, journalUnchanged: report.journalUnchanged }, null, 2));
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } else if (process.argv.includes('--recover-checkpoint')) {
    const report = recoverProductionCheckpoint(process.argv[at + 1]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.commands.every(c => c.exitCode === 0) ? 0 : 1;
  } else {
   const report = await runProduction({ existingRoot: at >= 0 ? process.argv[at + 1] : undefined, resumeWorkflow: process.argv.includes('--resume-workflow'), freshController: process.argv.includes('--fresh-controller'), stableProduct: process.argv.includes('--stable-product') });
  console.log(JSON.stringify({ root: report.root, status: report.status, blocker: report.blocker, sessionId: report.sessionId,
    launch: report.launch, cli: report.cli && { exitCode: report.cli.exitCode, costUsd: report.cli.costUsd, durationMs: report.cli.durationMs, denials: report.cli.permissionDenials.length },
    native: report.native?.results?.map(r => ({ id: r.id, toState: r.toState, note: r.note, gates: r.gates, calls: r.attemptObservations?.length })),
    ledger: report.ledger?.items?.['LIVE-CLAUDE-DOC']?.state, driver: report.driver.map(d => ({ command: d.command, exitCode: d.exitCode })),
    checkpointPresent: report.checkpointPresent, sourcePreserved: report.sourcePreserved }, null, 2));
  process.exitCode = report.status === 'PASS' ? 0 : 1;
  }
}
