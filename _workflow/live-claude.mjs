import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { SCHEMAS, validate } from './opencode/schemas.mjs';

export const DEFAULT_PARENT = process.platform === 'win32' ? 'C:\\Users\\AYEFYM~1\\AppData\\Local\\Temp\\opencode' : tmpdir();
const help = `Usage: node _workflow/live-claude.mjs --live [--fixture] [--executable PATH] [--temp-parent PATH]
Runs real paid Claude Workflow agents through the existing CLI login.
Creates a retained temporary evidence directory; never runs git or reads credentials.
Each CLI turn is capped at $1.50, 12 turns and 180 seconds. Two CLI invocations
exercise parallel schema/file relays and saved-session replay. --fixture adds one
invocation with parallel code/doc fixes and independent reviews. No automatic retries.
--help does not invoke Claude. See _workflow/LIVE-CLAUDE.md.
`;

export function parseEvents(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsed', text: line }; }
  });
}

export function summarize(events, processResult) {
  const result = events.findLast(e => e.type === 'result');
  const tools = events.flatMap(e => (e.message?.content || []).filter(c => c.type === 'tool_use'));
  return {
    exitCode: processResult.exitCode, signal: processResult.signal, timedOut: processResult.timedOut,
    sessionId: result?.session_id ?? null, subtype: result?.subtype ?? null,
    isError: result?.is_error ?? null, durationMs: result?.duration_ms ?? null,
    costUsd: result?.total_cost_usd ?? null, usage: result?.usage ?? null,
    modelUsage: result?.modelUsage ?? null, permissionDenials: result?.permission_denials ?? [],
    tools: tools.map(t => ({ name: t.name, input: t.input })), text: result?.result ?? null,
  };
}

export function primitiveScript(root) {
  const source = join(root, 'relay-source.txt').replaceAll('\\', '/');
  const target = join(root, 'relay-result.txt').replaceAll('\\', '/');
  return `export const meta = { name: 'factory-live-primitive', description: 'Bounded schema and filesystem relay validation', phases: [{title:'Probe'}] }
phase('Probe')
const before = budget.spent()
const schema = {type:'object',additionalProperties:false,required:['value'],properties:{value:{type:'string'}}}
const results = await Promise.all([
  agent('Return value exactly schema-ok. Do not use tools.', {model:'haiku',effort:'low',label:'schema',schema}),
  agent(${JSON.stringify(`Read ${source}, then Write its exact contents to ${target}. The source contains a UUID followed by exactly one LF newline: preserve that newline in the Write content. Only these two files are in scope. Never run git, launch agents, change settings, or access credentials. Return value equal to the file contents, trimming trailing whitespace.`)}, {model:'haiku',effort:'low',label:'filesystem-relay',schema})
])
if (!results[0] || !results[1]) throw new Error('Agent unavailable')
return {results, keys:results.map(r=>Object.keys(r)), usage:{sharedOutputTokensBefore:before,sharedOutputTokensAfter:budget.spent(),total:budget.total}}
`;
}

export function cliArgs({ sessionId, resume = false, prompt, budgetUsd = 1.5, fixture = false }) {
  return ['-p', prompt, resume ? '--resume' : '--session-id', sessionId,
    '--model', 'sonnet', '--effort', 'low', '--output-format', 'stream-json', '--verbose',
    '--max-budget-usd', String(budgetUsd), '--max-turns', '12', '--permission-mode', 'dontAsk',
    '--tools', 'Workflow,TaskOutput,Read,Write,Skill',
    '--allowedTools', 'Workflow,TaskOutput,Read(./**),Edit(./relay-result.txt),Skill(workflow-authoring)' + (fixture ? ',Edit(./clamp.mjs),Edit(./README.md)' : ''),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
}

export async function invoke(executable, args, root, name, timeoutMs = 180000) {
  const started = Date.now();
  let stdout = '', stderr = '', timedOut = false, spawnError = null;
  const child = spawn(executable, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '2', MAX_STRUCTURED_OUTPUT_RETRIES: '2' } });
  child.stdout.on('data', b => { stdout += b.toString(); });
  child.stderr.on('data', b => { stderr += b.toString(); });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  }, timeoutMs);
  child.on('error', e => { spawnError = e.message; });
  const outcome = await new Promise(resolve => child.on('close', (exitCode, signal) => resolve({ exitCode, signal, timedOut })));
  clearTimeout(timer);
  writeFileSync(join(root, name + '.jsonl'), stdout);
  writeFileSync(join(root, name + '.stderr.txt'), stderr);
  const summary = { ...summarize(parseEvents(stdout), outcome), wallMs: Date.now() - started, spawnError };
  writeFileSync(join(root, name + '.summary.json'), JSON.stringify(summary, null, 2));
  return { summary, events: parseEvents(stdout) };
}

export function workflowOutputs(events) {
  const found = [];
  for (const event of events) {
    for (const content of event.message?.content || []) {
      if (content.type !== 'tool_result') continue;
      const text = typeof content.content === 'string' ? content.content : JSON.stringify(content.content);
      found.push(text);
    }
  }
  return found;
}

export function completedWorkflow(events) {
  for (const text of workflowOutputs(events).reverse()) {
    const match = text.match(/<output>\s*([\s\S]*?)\s*<\/output>/);
    if (!match || !text.includes('<status>completed</status>')) continue;
    try { const value = JSON.parse(match[1]); if (Array.isArray(value.workflowProgress)) return value; } catch {}
  }
  throw new Error('Missing machine Workflow completion output');
}

export function verifyPrimitive(initial, replay, expected) {
  const a = initial.result, b = replay.result;
  if (JSON.stringify(a?.results) !== JSON.stringify([{ value: 'schema-ok' }, { value: expected }])) throw new Error('Wrong structured agent results');
  if (JSON.stringify(a.results) !== JSON.stringify(b?.results)) throw new Error('Replay result mismatch');
  const agents = replay.workflowProgress.filter(p => p.type === 'workflow_agent');
  if (agents.length !== 2 || agents.some(p => p.cached !== true || p.state !== 'done')) throw new Error('Replay agents were not both cached');
  if (!Number.isFinite(a.usage?.sharedOutputTokensAfter) || a.usage.sharedOutputTokensAfter <= a.usage.sharedOutputTokensBefore) throw new Error('Missing initial runtime output usage');
  if (!Number.isFinite(b.usage?.sharedOutputTokensAfter) || b.usage.sharedOutputTokensAfter !== b.usage.sharedOutputTokensBefore) throw new Error('Replay spent workflow output tokens');
  return { structuredResults: a.results, initialUsage: a.usage, replayUsage: b.usage,
    initialAgents: initial.workflowProgress.filter(p => p.type === 'workflow_agent'), replayAgents: agents };
}

export function launchIdentity(events) {
  for (const text of workflowOutputs(events)) {
    const runId = text.match(/^Run ID: (wf_[\w-]+)$/m)?.[1];
    const transcriptDir = text.match(/^Transcript dir: (.+)$/m)?.[1];
    if (runId && transcriptDir) return { runId, transcriptDir };
  }
  throw new Error('Missing Workflow launch identity');
}

export function fixtureScript(root) {
  const code = join(root, 'clamp.mjs').replaceAll('\\', '/');
  const doc = join(root, 'README.md').replaceAll('\\', '/');
  const extra = ' No git, shell, nested agents, settings or credential access. Use only Read and Write for the named fixture file. Return the supplied schema truthfully. scopeStop means a forbidden product-scope red-line prevents this fix; it does NOT mean you stayed within the file scope. Return scopeStop=false for an ordinary successful fix. Reviewers have not observed executed tests: omit redGreenConfirmed or set it false; source inspection alone cannot confirm executed RED/GREEN.';
  return `export const meta = {name:'factory-live-fixture',description:'Factory-schema code/doc fixture; injected no-git adapter, not full factory E2E'}
const fixSchema = ${JSON.stringify(SCHEMAS.FIX_SCHEMA)}
const gateSchema = ${JSON.stringify(SCHEMAS.GATE_SCHEMA)}
phase('Fix')
const fixes = await Promise.all([
 agent(${JSON.stringify(`Read ${code}. Fix clamp(value,min,max) to clamp a finite value to the inclusive range. The harness observed clamp(12,0,10) returning 12, expected 10. Modify only ${code}; no comments. Set applied, filesChanged, scopeStop and summary appropriately.` + extra)}, {schema:fixSchema,model:'haiku',effort:'low',label:'code-fixer'}),
 agent(${JSON.stringify(`Read ${doc}. Correct the documentation to say clamp returns the inclusive lower or upper bound when the value is outside the range. Modify only ${doc}; keep it concise. Set applied, filesChanged, scopeStop and summary appropriately.` + extra)}, {schema:fixSchema,model:'haiku',effort:'low',label:'doc-fixer'})
])
phase('Review')
let gates = await Promise.all([
 agent(${JSON.stringify(`Read ${code}. Independently review the implementation: clamp(-1,0,10)=0, clamp(12,0,10)=10, clamp(5,0,10)=5, boundaries are inclusive, finite negative bounds work. Do not edit. Return APPROVED only if correct, else CHANGES_REQUIRED with concrete findings. This is a source review, not an executed test.` + extra)}, {schema:gateSchema,model:'haiku',effort:'low',label:'code-reviewer'}),
 agent(${JSON.stringify(`Read ${doc}. Independently review that it accurately describes inclusive clamping, including inputs outside the range. Do not edit. Return APPROVED only if correct, else CHANGES_REQUIRED with concrete findings.` + extra)}, {schema:gateSchema,model:'haiku',effort:'low',label:'doc-reviewer'})
])
const originalGates = gates
const amendments = []
for (let i=0;i<gates.length;i++) {
 if (gates[i] && gates[i].verdict === 'CHANGES_REQUIRED' && !gates[i].scopeViolation && fixes[i] && !fixes[i].scopeStop) {
  const path = [${JSON.stringify(code)},${JSON.stringify(doc)}][i]
  const amend = await agent('Fix only '+path+' to address these independent findings: '+JSON.stringify(gates[i].findings)+${JSON.stringify(extra)}, {schema:fixSchema,model:'haiku',effort:'low',label:'bounded-amend-'+i})
  amendments.push(amend)
  if (amend && amend.applied && !amend.scopeStop) gates = gates.map((g,j)=>j===i?null:g)
  if (!gates[i]) gates[i] = await agent('Read '+path+' and independently re-review these prior findings against its CURRENT contents: '+JSON.stringify(originalGates[i].findings)+'. Return APPROVED only if addressed and accurate. No edits. '+${JSON.stringify(extra)}, {schema:gateSchema,model:'haiku',effort:'low',label:'bounded-regate-'+i})
 }
}
return {kind:'factory-schema-fixture-no-git-adapter',fixes,originalGates,amendments,gates,usage:{sharedOutputTokens:budget.spent()}}
`;
}

export function fixtureOracle(root) {
  const script = `import assert from 'node:assert/strict'; import {clamp} from './clamp.mjs'; for(const [x,lo,hi,want] of [[12,0,10,10],[-1,0,10,0],[5,0,10,5],[0,0,10,0],[10,0,10,10],[-9,-8,-2,-8],[-1,-8,-2,-2],[4,4,4,4]]) assert.equal(clamp(x,lo,hi),want); console.log('8 clamp cases passed');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: root, encoding: 'utf8', timeout: 10000 });
  return { exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null };
}

export function fixturePassed(summary, green, result) {
  const { fixes, gates } = result || {};
  return summary.exitCode === 0 && summary.isError === false && green.exitCode === 0 &&
    fixes?.length === 2 && fixes.every(r => validate(SCHEMAS.FIX_SCHEMA, r).ok && r.applied === true && r.scopeStop === false) &&
    (result.amendments || []).every(r => validate(SCHEMAS.FIX_SCHEMA, r).ok && r.applied === true && r.scopeStop === false) &&
    gates?.length === 2 && gates.every(r => validate(SCHEMAS.GATE_SCHEMA, r).ok && r.verdict === 'APPROVED' && r.scopeViolation !== true && r.redGreenConfirmed !== true);
}

export async function runFixture(executable, root) {
  writeFileSync(join(root, 'clamp.mjs'), 'export function clamp(value, min, max) { return value; }\n');
  writeFileSync(join(root, 'README.md'), '# Clamp\n\nReturns the input unchanged, even outside the bounds.\n');
  const red = fixtureOracle(root);
  writeFileSync(join(root, 'fixture-red.json'), JSON.stringify(red, null, 2));
  if (red.exitCode !== 1 || !red.stderr.includes('AssertionError')) throw new Error('Fixture RED not established');
  const scriptPath = join(root, 'fixture.js');
  writeFileSync(scriptPath, fixtureScript(root));
  const { summary, events } = await invoke(executable, cliArgs({ sessionId: randomUUID(), fixture: true,
    prompt: `Use the Workflow tool explicitly to run the authorized script ${scriptPath} without modifying it. Wait for completion using TaskOutput. Only the fixture clamp.mjs and README.md may be edited, using Read/Write. No shell, git, configuration, credential access, or extra agents. Return exact result.` }), root, 'fixture');
  const green = fixtureOracle(root);
  writeFileSync(join(root, 'fixture-green.json'), JSON.stringify(green, null, 2));
  const output = completedWorkflow(events);
  writeFileSync(join(root, 'fixture.workflow.json'), JSON.stringify(output, null, 2));
  const passed = fixturePassed(summary, green, output.result);
  const report = { status: passed ? 'PASS' : 'FAIL', scope: 'factory schemas with injected no-git fixture adapter; not factory.js/driver E2E', ...launchIdentity(events), red, green, result: output.result, call: summary };
  writeFileSync(join(root, 'fixture.report.json'), JSON.stringify(report, null, 2));
  return report;
}

export function assertContained(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('path escapes evidence directory');
}

export async function runLiveClaude({ executable = 'claude', tempParent = DEFAULT_PARENT, fixture = false } = {}) {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tempParent), 'factory-live-claude-')));
  const report = { status: 'FAIL', root, sessionId: randomUUID(), calls: [], checks: [], blockers: [] };
  writeFileSync(join(root, 'relay-source.txt'), randomUUID() + '\n');
  const scriptPath = join(root, 'primitive.js');
  writeFileSync(scriptPath, primitiveScript(root));
  try {
    const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (version.status !== 0) throw new Error('Claude version unavailable');
    report.installedVersion = version.stdout.trim();
    const auth = spawnSync(executable, ['auth', 'status'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const status = JSON.parse(auth.stdout);
    report.auth = { loggedIn: status.loggedIn, authMethod: status.authMethod, apiProvider: status.apiProvider, subscriptionType: status.subscriptionType };
    if (auth.status !== 0 || status.loggedIn !== true) throw new Error('Claude existing login unavailable');
    const prompt = `Use the Workflow tool explicitly to execute the existing script at ${scriptPath}. This is an authorized real Workflow launch, not a request to simulate it. Load Skill workflow-authoring if needed. Do not edit the script. Wait using TaskOutput until completion and report the exact runId, transcriptDir, and returned result. No other workflows, tools, git, settings changes or credential access. Agents may read/write only the two relay files named in the script.`;
    const first = await invoke(executable, cliArgs({ sessionId: report.sessionId, prompt }), root, 'initial');
    report.calls.push(first.summary);
    writeFileSync(join(root, 'initial.tools.json'), JSON.stringify(workflowOutputs(first.events), null, 2));
    if (first.summary.exitCode !== 0 || first.summary.isError !== false) throw new Error('initial CLI failed; inspect initial.summary.json');
    const target = join(root, 'relay-result.txt');
    if (!existsSync(target)) throw new Error('filesystem relay missing');
    if (readFileSync(target, 'utf8') !== readFileSync(join(root, 'relay-source.txt'), 'utf8')) throw new Error('filesystem relay byte mismatch (including terminal newline)');
    report.checks.push('filesystem-relay-exact-bytes');
    const before = statSync(target).mtimeMs;
    const replayPrompt = `Resume the completed Workflow run from the preceding turn using Workflow({scriptPath:${JSON.stringify(scriptPath)},resumeFromRunId:the exact prior runId}). Same script and args, no edits and no fresh run. Wait for completion. Return the runId, transcriptDir and exact result, including cache/replay evidence. Do not execute any other agents or tools except Workflow and TaskOutput.`;
    const replay = await invoke(executable, cliArgs({ sessionId: report.sessionId, resume: true, prompt: replayPrompt }), root, 'replay');
    report.calls.push(replay.summary);
    writeFileSync(join(root, 'replay.tools.json'), JSON.stringify(workflowOutputs(replay.events), null, 2));
    if (replay.summary.exitCode !== 0 || replay.summary.isError !== false) throw new Error('replay CLI failed; inspect replay.summary.json');
    const launches = replay.summary.tools.filter(t => t.name === 'Workflow');
    if (!launches.some(t => t.input.resumeFromRunId)) throw new Error('replay did not request resumeFromRunId');
    if (statSync(target).mtimeMs !== before) throw new Error('relay ran again: target mtime changed');
    report.checks.push('saved-session-resume-request', 'relay-not-rewritten');
    const initialOutput = completedWorkflow(first.events), replayOutput = completedWorkflow(replay.events);
    report.initialLaunch = launchIdentity(first.events);
    report.replayLaunch = launchIdentity(replay.events);
    if (report.initialLaunch.runId !== report.replayLaunch.runId || !launches.some(t => t.input.resumeFromRunId === report.initialLaunch.runId)) throw new Error('Replay run identity mismatch');
    writeFileSync(join(root, 'initial.workflow.json'), JSON.stringify(initialOutput, null, 2));
    writeFileSync(join(root, 'replay.workflow.json'), JSON.stringify(replayOutput, null, 2));
    report.primitive = verifyPrimitive(initialOutput, replayOutput, readFileSync(join(root, 'relay-source.txt'), 'utf8').trim());
    report.checks.push('structured-agent-results', 'machine-confirmed-cache-replay', 'runtime-usage');
    if (fixture) {
      report.fixture = await runFixture(executable, root);
      if (report.fixture.status !== 'PASS') throw new Error('Fixture lifecycle failed');
      report.checks.push('factory-schema-fixture-red-fix-review-green');
    }
    report.status = 'PASS';
  } catch (error) { report.blockers.push(error.message); }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log(help);
  else {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--live') options.live = true;
      else if (args[i] === '--fixture') options.fixture = true;
      else if (args[i] === '--executable' && args[i + 1]) options.executable = args[++i];
      else if (args[i] === '--temp-parent' && args[i + 1]) options.tempParent = args[++i];
      else throw new Error('Unknown or incomplete option: ' + args[i]);
    }
    if (!options.live) throw new Error('Pass --live to authorize real subscription/API usage.');
    const report = await runLiveClaude(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'FAIL' ? 1 : 0;
  }
}
