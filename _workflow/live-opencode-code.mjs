import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, realpathSync, appendFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareLifecycle, lifecycleReport, appendCleanupReceipt } from './live-opencode-lifecycle.mjs';
import { launchV2 } from './live-opencode-cancel.mjs';
import { stopServer } from './live-opencode-workers.mjs';
import { prepareOfflineDotnetFixture } from './lib/_offline-dotnet-fixture.mjs';
import { limitedBuildTest } from './opencode/build-lease.mjs';
import { OpenCodeServer } from './opencode/server-api.mjs';
import { waitForOpenCodeAgents } from './opencode/compatibility.mjs';
import { dispatchAgent } from './opencode/dispatcher.mjs';
import { digest, writeJsonAtomic } from './opencode/identity.mjs';
import { opencodeFragment } from './lib/hostinstall.mjs';

export const CODE_ID = 'LIVE-NUMERIC-CODE';
export const CODE = 'src/Numeric/Arithmetic.cs';
export const TEST = 'tests/Numeric.Tests/ArithmeticRegressionTests.cs';
export const TARGET = 'tests/Numeric.Tests/Numeric.Tests.csproj';
export const FILTER = 'FullyQualifiedName~ArithmeticRegressionTests';
const read = p => JSON.parse(readFileSync(p, 'utf8'));
const check = (v, message) => { if (!v) throw new Error(message); };
const slash = p => p.replace(/\\/g, '/');

export function codeConfig(model, fx) {
  check(model === 'github-copilot/gpt-5-mini', 'only-authorized-copilot-mini-route');
  const base = read(new URL('../opencode-assets/opencode.config.json', import.meta.url));
  const profiles = read(new URL('../opencode-assets/worker-profiles.json', import.meta.url));
  const installed = opencodeFragment(base, { ...profiles, models: { standard: model } }, 2);
  const commands = codeCommands(fx);
  const agent = (kind, path) => {
    const profile = installed.agents['factory-' + (path ? 'writer' : 'reviewer') + '-standard'];
    return { ...profile, steps: 20,
    system: profile.system + `\nPublic synthetic numeric .NET fixture only. Follow HOST WORKER COMMAND CONTRACT at the end of the request. Use shell workdir, never cd. Read-only git status/diff are allowed. No credentials/network/private paths. Only ${path || 'no source files'} may be edited. For patch use the absolute filename ${path ? slash(join(fx.workspace, path)) : '(read-only)'}. No role-artifact writes; return JSON.`,
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      ...profile.permissions,
      ...['read', 'list'].map(action => ({ action, resource: '*', effect: 'allow' })),
      { action: 'external_directory', resource: slash(fx.root) + '/*', effect: 'allow' },
      ...['glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
      ...[commands.status, commands.diff, 'git status --porcelain', 'git diff HEAD', 'pwd', 'Get-Location'].map(resource => ({ action: 'shell', resource, effect: 'allow' })),
      ...['suite', ...(kind === 'test-author' ? ['red'] : [])].flatMap(sub => [commands[sub], `node code-check.mjs ${sub}`, `node '${slash(join(fx.root, 'code-check.mjs'))}' ${sub}`, `node.exe "${slash(join(fx.root, 'code-check.mjs'))}" ${sub}`].map(resource => ({ action: 'shell', resource, effect: 'allow' }))),
      { action: 'edit', resource: '*', effect: 'deny' },
      ...(path ? [path, slash(relative(fx.root, join(fx.workspace, path))), slash(join(fx.workspace, path)), join(fx.workspace, path)].map(resource => ({ action: 'edit', resource, effect: 'allow' })) : []),
      ...['read', 'edit'].flatMap(action => ['**/config/**', '**/auth.json', '**/ledger.json', '**/.env*'].map(resource => ({ action, resource, effect: 'deny' }))),
    ] }; };
  return { $schema: 'https://opencode.ai/config.json', snapshots: false, update: 'disable', share: 'disabled',
    plugins: [], mcp: { servers: {} }, formatter: false,
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    agents: { 'factory-code-test': agent('test-author', TEST), 'factory-code-fixer': agent('fixer', CODE), 'factory-code-review': agent('reviewer') } };
}

export function codeCommands(fx) {
  const helper = 'node "' + slash(join(fx.root, 'code-check.mjs')) + '"';
  return { status: `git -C "${slash(fx.workspace)}" status --porcelain`, diff: `git -C "${slash(fx.workspace)}" diff HEAD`, red: helper + ' red', suite: helper + ' suite' };
}

export function codeCommandHint(fx) {
  const commands = codeCommands(fx);
  return `For this synthetic host, use the following exact shell command strings with workdir=${JSON.stringify(slash(fx.workspace))}; do not prefix cd or use tee/redirection. First inspect: ${commands.status} then ${commands.diff}. For RED execute: ${commands.red}. For suite execute: ${commands.suite}. The absolute helper already invokes the stock verification script through the shared build lease, uses the isolated offline SDK/cache, and writes the unedited RED transcript; do not invoke dotnet/docker/the generic wrapper spellings. Baseline already passed before new tests: ${slash(join(fx.root, 'before-suite.txt'))}. Return role JSON only; controller persists artifacts. Test-author must actually run RED after authoring ${TEST}, must not change ${CODE}, and must report the actual failing assertions (red=false if it cannot run). Fixer changes only ${CODE}, never the regression. Reviewers inspect current code/tests and raw evidence independently. Read original defective source at ${slash(join(fx.root, 'before-fix.json'))}. All .cs/.csproj files were pre-created untracked bootstrap files except the agent-authored regression; the original read-only index may show stat-cache-only M entries for unchanged archived HEAD files. Preparation checked empty tracked diff. Judge actual fixture bytes and evidence; no git mutations, credential/private reads, or writes outside the allowed source file. This replaces generic command spellings and artifact-write instructions only; every evidence/review gate remains binding.`;
}

export function prepareCode(root) {
  const fx = prepareLifecycle(root);
  const workspace = join(root, 'state/worktrees', CODE_ID);
  mkdirSync(join(root, 'state/worktrees'), { recursive: true });
  renameSync(fx.workspace, workspace);
  Object.assign(fx, { workspace, dir: join(fx.mount, 'state/items', CODE_ID) });
  fx.env.GIT_WORK_TREE = workspace;
  appendFileSync(join(root, 'fixture-excludes'), '**/bin/\n**/obj/\n');
  mkdirSync(fx.dir, { recursive: true });
  prepareOfflineDotnetFixture(root);
  Object.assign(fx.env, { NUGET_PACKAGES: join(root, 'offline-nuget'), DOTNET_CLI_HOME: root,
    DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' });
  const put = (path, text) => { mkdirSync(resolve(workspace, path, '..'), { recursive: true }); writeFileSync(join(workspace, path), text); };
  put('NuGet.Config', '<configuration><packageSources><clear/></packageSources></configuration>');
  put('src/Numeric/Numeric.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><NuGetAudit>false</NuGetAudit></PropertyGroup></Project>');
  put(CODE, 'namespace Numeric;\npublic static class Arithmetic\n{\n    public static long Add(int left, int right) => (long)left - right;\n}\n');
  put('Directory.Packages.props', '<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include="Microsoft.NET.Test.Sdk" Version="17.11.1"/><PackageVersion Include="xunit" Version="2.9.0"/><PackageVersion Include="xunit.runner.visualstudio" Version="2.8.2"/></ItemGroup></Project>');
  put(TARGET, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><IsTestProject>true</IsTestProject><NuGetAudit>false</NuGetAudit></PropertyGroup><ItemGroup><ProjectReference Include="../../src/Numeric/Numeric.csproj"/><PackageReference Include="Microsoft.NET.Test.Sdk"/><PackageReference Include="xunit"/><PackageReference Include="xunit.runner.visualstudio"/></ItemGroup></Project>');
  put('tests/Numeric.Tests/ArithmeticTests.cs', 'using Xunit;\nusing Numeric;\nnamespace Numeric.Tests;\npublic class ArithmeticTests\n{\n    [Fact]\n    public void Add_ZeroInputs_ReturnsZero()\n    {\n        var actual = Arithmetic.Add(0, 0);\n        Assert.True(actual == 0L, $"Adding zero to zero must produce zero; actual={actual}");\n    }\n}\n');
  fx.item = { id: CODE_ID, target: 'Numeric', severity: 'LOW', band: 'FULL', fixType: 'mechanical', autonomyTier: 'auto',
    title: 'Correct pure integer addition', theme: 'numeric-correctness', realInfra: false,
    files: [CODE, TEST, TARGET, 'src/Numeric/Numeric.csproj', 'tests/Numeric.Tests/ArithmeticTests.cs', 'NuGet.Config', 'Directory.Packages.props'],
    solution: TARGET,
    acceptance: 'Arithmetic.Add returns the exact mathematical sum as Int64 for every pair of Int32 inputs, including positive, negative, mixed-sign, zero and Int32 boundary inputs.',
    regressionTest: `Create ${TEST} with an xUnit theory covering (2,3)=5, (-2,-3)=-5, (-2,3)=1, (0,0)=0, (int.MaxValue,1)=2147483648L and (int.MinValue,-1)=-2147483649L; call the public method directly, match the sibling Assert.True equality assertion with a descriptive message including inputs/expected/actual and the exact-sum requirement, and execute the absolute RED helper in HOST WORKER COMMAND CONTRACT before any product fix.`,
    fixHint: `Fix only ${CODE}. Preserve the agent-authored regression tests and sibling test. All project files are pre-created synthetic infrastructure, intentionally untracked in an archived public HEAD fixture using the original read-only .git; no mutating git is permitted. Use node code-check.mjs suite for actual tests. The test helper calls the stock verify script through the shared build lease, with an isolated offline package cache. No database semantics are involved.`,
    source: 'public-synthetic-code-lifecycle', dependsOn: [] };
  writeJsonAtomic(join(root, 'fixture.json'), { item: fx.item, worktreePath: workspace, branch: 'fixture/read-only-archive', cycle: 1 });
  writeJsonAtomic(join(fx.mount, 'state/findings-graph.json'), { version: 1, items: [fx.item] });
  const roles = ['fixer', 'review-edgecase', 'red-coverage-probe', 'breadth-claim-probe', 'gate-architect', 'gate-developer', 'gate-qa', 'gate-security', 'gate-po', 'review-code', 'review-adversarial', 'review-testreview', 'refuter', 're-auditor', 'integrator'];
  const roleHints = Object.fromEntries(roles.map(role => [role, `You are ${role}, NOT test-author. NEVER run red: pre-fix code no longer exists and rerunning red would destroy historical proof. Read ${slash(join(fx.dir, 'verify-red-raw.txt'))} for historical RED and ${slash(join(fx.dir, 'verify-raw.txt'))} for controller GREEN. If you need fresh execution, run EXACTLY ${codeCommands(fx).suite} with workdir=${JSON.stringify(slash(workspace))}; suite is permitted for your role and executes real .NET tests. Use these actual results to resolve suspected compile errors, not guesses. Do not create/rewrite any transcript/artifact. This fixture intentionally restores only from the prepopulated offline cache, so cleared network sources are its required host setup. Test package versions are central in Directory.Packages.props. Scope is synthetic numeric code, not deployment. Return JSON. ${role === 'integrator' ? 'HANDOFF-ONLY: read integrate-raw.txt rather than repeating the suite.' : ''}`]));
  roleHints['test-author'] = `Author ${TEST} using the sibling file-scoped namespace and named int.MaxValue/int.MinValue constants. Then execute EXACTLY ${codeCommands(fx).red} with workdir=${JSON.stringify(slash(workspace))}. The helper itself persists verify-red-raw.txt; READ that file after execution, never write or tee it. A NuGet/build setup error is NOT defect proof: red=true requires actual failed assertions. Do not run docker. Return JSON only.`;
  writeJsonAtomic(join(fx.mount, 'config/factory.config.local.json'), { solution: TARGET, solutions: { Numeric: TARGET }, workerCommandHint: codeCommandHint(fx), workerRoleCommandHints: roleHints });
  const baseline = limitedBuildTest(fx.mount, 'suite', [slash(join(workspace, TARGET))], { cwd: workspace, env: fx.env });
  writeFileSync(join(root, 'before-suite.txt'), baseline.output);
  check(baseline.code === 0 && /SUMMARY::suite exit=0 failed=0 passed=1/.test(baseline.output), 'pre-test-baseline-not-green');
  fx.originalCode = digest(readFileSync(join(workspace, CODE)));
  writeJsonAtomic(join(root, 'before-fix.json'), { code: readFileSync(join(workspace, CODE), 'utf8'), hash: fx.originalCode, baseline: 'before-suite.txt', regressionExisted: false });
  const helperEnv = Object.fromEntries(Object.entries(fx.env).filter(([key]) => /^(NUGET_PACKAGES|DOTNET_|MSBUILD|GIT_|FACTORY_)/.test(key) || /^(APPDATA|LOCALAPPDATA|USERPROFILE|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|SystemRoot|SystemDrive|ALLUSERSPROFILE|PUBLIC)$/i.test(key)));
  writeFileSync(join(root, 'code-check.mjs'), `import {writeFileSync} from 'node:fs';\nimport {limitedBuildTest} from ${JSON.stringify(pathToFileURL(join(fx.mount, '_workflow/opencode/build-lease.mjs')).href)};\nconst sub=process.argv[2];\nif(!['red','suite'].includes(sub))throw new Error('unsupported-command');\nconst r=limitedBuildTest(${JSON.stringify(fx.mount)},sub,[${JSON.stringify(slash(join(workspace, TARGET)))},...(sub==='red'?[${JSON.stringify(FILTER)}]:[])],{cwd:${JSON.stringify(workspace)},env:{...process.env,...${JSON.stringify(helperEnv)}}});\nif(sub==='red')writeFileSync(${JSON.stringify(join(fx.dir, 'verify-red-raw.txt'))},r.output);\nprocess.stdout.write(r.output);\nprocess.exitCode=r.code;\n`);
  writeJsonAtomic(join(root, 'fixture-context.json'), { ...fx, env: undefined, helperEnv });
  return fx;
}

export function foldCodeFailure(root) {
  root = realpathSync.native(root);
  const fx = read(join(root, 'fixture-context.json'));
  const { report, save } = lifecycleReport(root);
  const env = { ...process.env, ...fx.helperEnv };
  const cli = (name, args) => execFileSync(process.execPath, [join(fx.mount, '_workflow', name), ...args], { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  const runtime = args => cli('opencode/runtime.mjs', args), driver = args => cli('driver.mjs', args);
  const progress = read(join(fx.dir, 'opencode-progress.json'));
  check(progress.phase === 'test', 'failure-fold-only-for-pending-test');
  const descriptor = progress.pendingSet.calls.find(c => c.key === 'test-author');
  const mapping = read(join(fx.dir, 'dispatch', descriptor.dispatchId + '-session.json'));
  const redPath = join(fx.dir, 'verify-red-raw.txt');
  const infrastructureRed = mapping.outcome?.value?.red === true && existsSync(redPath) && /NuGet\.targets.*error/.test(readFileSync(redPath, 'utf8')) && !/Failed:\s+[1-9]/.test(readFileSync(redPath, 'utf8'));
  check(mapping.status === 'completed' && mapping.stopped === true && (mapping.outcome?.value?.red === false || infrastructureRed) && mapping.outcome.value.verificationOnly !== true, 'failure-fold-requires-settled-negative-test-result');
  const result = join(fx.dir, 'dispatch', descriptor.dispatchId + '-result.json');
  writeJsonAtomic(result, mapping.outcome.value);
  if (infrastructureRed) runtime(['fail', CODE_ID, '--dispatch', descriptor.dispatchId, '--reason', 'RED execution failed in NuGet setup before assertions; no regression proof']);
  else runtime(['submit', CODE_ID, '--role', 'test-author', '--dispatch', descriptor.dispatchId, '--model', mapping.outcome.actualModel, '--json', result]);
  const text = runtime(['next', CODE_ID]);
  check(JSON.parse(text.slice(text.indexOf('{'))).mechanical === 'checkpoint', 'negative-test-did-not-terminate');
  runtime(['mech', CODE_ID, 'checkpoint']); runtime(['finalize', CODE_ID]);
  const envelope = join(fx.mount, 'state', 'results-cycle-1-' + CODE_ID + '.json');
  report.finalized = read(envelope).results[0];
  const controller = read(join(fx.mount, 'state/controller.json')).token;
  report.foldOutput = driver(['fold', envelope, '--controller', controller]);
  const ledger = join(fx.mount, 'state/ledger.json');
  report.folded = read(ledger).items[CODE_ID];
  const before = digest(readFileSync(ledger));
  report.foldReplayOutput = driver(['fold', envelope, '--controller', controller]);
  report.foldReplayUnchanged = before === digest(readFileSync(ledger));
  check(report.folded.state === 'FAILED' && report.foldReplayUnchanged, 'terminal-failure-fold-mismatch');
  report.failureFold = { noNewInference: true, unchangedWorkerVerdict: true, infrastructureRedRejected: infrastructureRed };
  report.result = 'FAIL'; save();
  return report;
}

export async function runCode({ executable, tempParent, prepareOnly = false, resumeRoot } = {}) {
  const root = resumeRoot ? realpathSync.native(resumeRoot) : realpathSync.native(mkdtempSync(join(realpathSync.native(tempParent), 'factory-live-code-')));
  const { report, save } = lifecycleReport(root);
  report.scope = 'public-synthetic-dotnet-real-runtime-finalize-driver-fold';
  report.result = 'FAIL'; delete report.error;
  const model = 'github-copilot/gpt-5-mini';
  let fx, server, api, stage = 'prepare';
  const sessions = [];
  const started = Date.now();
  try {
    fx = resumeRoot ? read(join(root, 'fixture-context.json')) : prepareCode(root);
    if (resumeRoot) fx.env = { ...process.env, ...fx.helperEnv };
    const cli = (name, args) => execFileSync(process.execPath, [join(fx.mount, '_workflow', name), ...args], { cwd: root, env: fx.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
    const runtime = args => cli('opencode/runtime.mjs', args), driver = args => cli('driver.mjs', args);
    const progressPath = join(fx.dir, 'opencode-progress.json');
    if (!existsSync(progressPath)) { runtime(['init', CODE_ID, '--fixture', join(root, 'fixture.json')]); driver(['init']); }
    if (prepareOnly) { report.result = 'PREPARED'; return report; }
    stage = 'server';
    const config = codeConfig(model, fx);
    const workerEnv = Object.fromEntries(Object.entries(fx.env).filter(([key]) => /^(GIT_|NUGET_PACKAGES|DOTNET_|MSBUILD)/.test(key)));
    const launched = await launchV2(executable, root, config, workerEnv); server = launched.server;
    api = new OpenCodeServer({ url: server.url, version: 'v2', headers: launched.headers, timeoutMs: 60000 });
    report.runtimeVersion = (await api.check()).version; report.endpoint = server.url; report.pid = server.child.pid;
    report.auth = 'standard OpenCode user auth; no credentials read/copied by harness';
    const defs = await waitForOpenCodeAgents(api, root, Object.keys(config.agents), { timeoutMs: 120000 });
    check(Object.keys(config.agents).every(id => defs.some(a => a.id === id && a.model?.providerID + '/' + a.model?.id === model)), 'effective-model-route');
    report.effectiveProfiles = defs.filter(a => Object.hasOwn(config.agents, a.id)).map(a => ({ id: a.id, model: a.model, permissions: a.permissions }));
    for (let step = 0; step < 80; step++) {
      check(Date.now() - started < 20 * 60000, '20-minute-budget');
      const text = runtime(['next', CODE_ID]); const plan = JSON.parse(text.slice(text.indexOf('{')));
      const progress = read(progressPath); stage = progress.phase;
      if (plan.done) break;
      if (plan.mechanical) {
        const args = ['mech', CODE_ID, plan.mechanical];
        if (plan.mechanical === 'verify') args.push('--', TARGET, FILTER);
        if (plan.mechanical === 'integrate') args.push('--', TARGET);
        runtime(args);
        report.mechanics.push({ phase: stage, command: plan.mechanical, completed: true }); save();
        continue;
      }
      check(report.calls.length + plan.agents.length <= 25, '25-dispatch-budget');
      check(report.calls.reduce((sum, c) => sum + (c.cost ?? 0), 0) < 0.75, 'reported-cost-budget');
      const results = await Promise.allSettled(plan.agents.map(async descriptor => {
        const call = { phase: progress.phase, role: descriptor.key, dispatchId: descriptor.dispatchId };
        report.calls.push(call); save();
        const statePath = join(fx.dir, 'dispatch', descriptor.dispatchId + '-session.json');
        const agent = descriptor.role === 'test-author' ? 'factory-code-test' : descriptor.role === 'fixer' ? 'factory-code-fixer' : 'factory-code-review';
        const options = { descriptor: { ...descriptor, itemId: CODE_ID, runId: progress.runId }, directory: fx.workspace, statePath, api,
          config: { version: 'v2', pollMs: 250, agentTimeoutMs: Math.min(180000, 20 * 60000 - (Date.now() - started)), roles: { [descriptor.role]: { agent } } }, observe: () => {} };
        let outcome;
        try {
          outcome = await dispatchAgent(options);
          if (!report.settledReplay) {
            const before = digest(await api.messages(read(statePath), fx.workspace));
            const replay = await dispatchAgent(options);
            check(digest(replay.value) === digest(outcome.value) && before === digest(await api.messages(read(statePath), fx.workspace)), 'settled-replay-changed');
            report.settledReplay = { dispatchId: descriptor.dispatchId, sameMessages: true, sameValue: true, newAdmission: false };
          }
        } finally {
          if (existsSync(statePath)) {
            const mapping = read(statePath); sessions.push(mapping);
            Object.assign(call, { sessionId: mapping.sessionId, status: mapping.status, admitted: mapping.invoked, actualModel: mapping.outcome?.actualModel ?? null,
              usage: mapping.outcome?.usage ?? null, cost: mapping.outcome?.cost ?? null, value: mapping.outcome?.value ?? null, error: mapping.error });
            if (mapping.sessionId) {
              const messages = await api.messages(mapping, fx.workspace);
              call.tools = messages.flatMap(m => (m.content || []).filter(p => p.type === 'tool').map(p => ({ tool: p.tool || p.name || p.toolID, status: p.state?.status, command: p.state?.input?.command, workdir: p.state?.input?.workdir, patch: p.state?.input?.patchText, error: p.state?.error })));
            }
          }
          save();
        }
        if (descriptor.role === 'test-author') {
          check(digest(readFileSync(join(fx.workspace, CODE))) === fx.originalCode, 'test-author-modified-product');
          const red = readFileSync(join(fx.dir, 'verify-red-raw.txt'), 'utf8');
          check(/FACTORY::RED::[1-9]\d*\s*$/m.test(red) && /Failed:\s+[1-9]/.test(red), 'missing-actual-red-assertions');
          report.red = { sourceUnchanged: true, raw: red, testHash: digest(readFileSync(join(fx.workspace, TEST))) };
        }
        if (descriptor.role === 'fixer') {
          check(digest(readFileSync(join(fx.workspace, CODE))) !== fx.originalCode, 'fixer-did-not-change-product');
          check(digest(readFileSync(join(fx.workspace, TEST))) === report.red.testHash, 'fixer-changed-regression');
          report.fix = { productChanged: true, regressionUnchanged: true, code: readFileSync(join(fx.workspace, CODE), 'utf8') };
        }
        const resultPath = join(fx.dir, 'dispatch', descriptor.dispatchId + '-result.json'); writeJsonAtomic(resultPath, outcome.value);
        runtime(['submit', CODE_ID, '--role', descriptor.key, '--dispatch', descriptor.dispatchId, '--model', outcome.actualModel || 'unknown', '--json', resultPath]);
        save();
      }));
      const failure = results.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
    }
    stage = 'finalize'; runtime(['finalize', CODE_ID]);
    const resultPath = join(fx.mount, 'state', 'results-cycle-1-' + CODE_ID + '.json');
    report.finalized = read(resultPath).results[0];
    stage = 'fold';
    const controller = read(join(fx.mount, 'state/controller.json')).token;
    report.foldOutput = driver(['fold', resultPath, '--controller', controller]);
    const ledgerPath = join(fx.mount, 'state/ledger.json');
    report.folded = read(ledgerPath).items[CODE_ID];
    const before = digest(readFileSync(ledgerPath));
    report.foldReplayOutput = driver(['fold', resultPath, '--controller', controller]);
    report.foldReplayUnchanged = before === digest(readFileSync(ledgerPath));
    check(report.foldReplayUnchanged, 'fold-replay-changed-ledger');
    check(report.folded.state === 'CLOSED', 'fold-not-closed');
    check(report.finalized.codeChange === true && report.finalized.verificationOnly !== true, 'not-real-code-lifecycle');
    report.result = 'PASS';
  } catch (e) { report.error = { stage, message: e.message.slice(0, 2000) }; }
  finally {
    report.cleanup.sessions ||= [];
    for (const mapping of sessions) {
      if (!mapping.sessionId) continue;
      let stopped = false, deleted = false;
      try { stopped = (await api.stop(mapping, fx.workspace)).stopped; if (stopped) deleted = await api.request('DELETE', '/api/session/' + mapping.sessionId, undefined, fx.workspace) === null; } catch { }
      const receipt = { id: mapping.sessionId, dispatchId: mapping.dispatchId, stopped, deleted, server: api.url, directory: fx.workspace };
      appendCleanupReceipt(root, report, 'session', receipt); report.cleanup.sessions.push(receipt); save();
    }
    if (server) {
      report.cleanup.serverStopped = await stopServer(server);
      appendCleanupReceipt(root, report, 'server', { pid: server.child.pid, server: server.url, stopped: report.cleanup.serverStopped });
    }
    report.elapsedMs = Date.now() - started;
    report.accounting = { calls: report.calls.length, reportedCostSubtotal: report.calls.reduce((n, c) => n + (c.cost ?? 0), 0), unknownCostCalls: report.calls.filter(c => c.cost == null).length,
      billingVerified: false, tokens: report.calls.map(c => ({ dispatchId: c.dispatchId, usage: c.usage ?? null })) };
    if (report.cleanup.sessions.some(s => !s.stopped || !s.deleted) || report.cleanup.serverStopped === false) report.result = 'FAIL';
    save();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--prepare-only') { options.prepareOnly = true; continue; }
    const key = { '--executable': 'executable', '--temp-parent': 'tempParent', '--resume-root': 'resumeRoot', '--fold-failure': 'foldFailure' }[process.argv[i]];
    check(key && process.argv[i + 1], 'invalid-option'); options[key] = process.argv[++i];
  }
  const report = options.foldFailure ? foldCodeFailure(options.foldFailure) : await runCode(options);
  console.log(JSON.stringify({ root: report.root, result: report.result, error: report.error, reportPath: report.reportPath, folded: report.folded?.state, accounting: report.accounting, cleanup: report.cleanup }, null, 2));
  process.exitCode = ['PASS', 'PREPARED'].includes(report.result) ? 0 : 1;
}
