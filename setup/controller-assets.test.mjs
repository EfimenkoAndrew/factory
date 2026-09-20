import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeOpencodeConfig, opencodeFragment, opencodeMajor, selectOpencodeMajor, installManagedFile, installAgentsGuidance, installedHash, writeAssetAtomic, appendRulesLast } from '../_workflow/lib/hostinstall.mjs';
import { resolveRoute } from '../_workflow/opencode/server-api.mjs';

const base = JSON.parse(readFileSync(new URL('../opencode-assets/opencode.config.json', import.meta.url)));
const profiles = JSON.parse(readFileSync(new URL('../opencode-assets/worker-profiles.json', import.meta.url)));
const matches = (pattern, value) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(value);
const effect1 = (rules, resource) => Object.entries(rules).filter(([p]) => matches(p, resource)).at(-1)?.[1];
const effect2 = (rules, action, resource) => rules.filter((r) => matches(r.action, action) && matches(r.resource, resource)).at(-1)?.effect;
const effectiveV1 = (permission, tool, resource) => Object.entries(permission).flatMap(([action, value]) => Object.entries(typeof value === 'string' ? { '*': value } : value).map(([pattern, effect]) => ({ action, resource: pattern, effect }))).filter((r) => matches(r.action, tool) && matches(r.resource, resource)).at(-1)?.effect;

test('owned broad deny cannot be weakened by a more specific factory ask', () => {
  const rules = appendRulesLast({ '*': 'deny' }, { '*': 'ask', 'git *': 'ask' });
  assert.equal(effect1(rules, 'git status'), 'deny');
  assert.deepEqual(appendRulesLast(rules, { '*': 'ask', 'git *': 'ask' }), rules);
  const merged = mergeOpencodeConfig({ permission: { '*': { '*': 'deny' } } }, opencodeFragment(base, profiles, 1));
  assert.equal(merged.refused, null);
  assert.equal(effectiveV1(merged.config.permission, 'bash', 'git commit'), 'deny');
  for (const agent of Object.values(merged.config.agent)) assert.equal(effectiveV1(agent.permission, 'read', 'anything'), 'deny');
});

test('profile merge retains broad host restrictions across read/edit/tool wildcards and flat tools', () => {
  for (const major of [1, 2]) {
    const fragment = opencodeFragment(base, profiles, major);
    const id = 'factory-writer-standard';
    const host = major === 1 ? {
      permission: { read: 'deny', edit: 'deny', 'mcp_*': 'deny', webfetch: 'deny', bash: { '*': 'deny' } },
      agent: { [id]: { permission: { read: 'allow', edit: { 'src/*': 'allow' }, mcp_query: 'allow', webfetch: 'allow', bash: 'allow' } } },
    } : {
      permissions: ['read', 'edit', 'mcp_*', 'webfetch', 'shell'].map((action) => ({ action, resource: '*', effect: 'deny' })),
      agents: { [id]: { permissions: ['read', 'edit', 'mcp_query', 'webfetch', 'shell'].map((action) => ({ action, resource: '*', effect: 'allow' })) } },
    };
    const before = JSON.stringify(host);
    const merged = mergeOpencodeConfig(host, fragment, major);
    assert.equal(merged.refused, null);
    for (const agent of Object.values(major === 1 ? merged.config.agent : merged.config.agents)) {
      for (const tool of ['read', 'edit', 'mcp_query', 'webfetch', major === 1 ? 'bash' : 'shell']) {
        const action = major === 1 ? effectiveV1(agent.permission, tool, 'src/code.cs') : effect2(agent.permissions, tool, 'src/code.cs');
        assert.equal(action, 'deny', `${major} ${tool}`);
      }
      if (major === 1) assert.equal(agent.permission.webfetch, 'deny');
    }
    assert.equal(mergeOpencodeConfig(merged.config, fragment, major).changed, false, `idempotent v${major}`);
    assert.equal(JSON.stringify(host), before);
  }
});

test('profile shapes resolve through actual v1/v2 adapter with host models and role overrides', () => {
  for (const major of [1, 2]) {
    const fragment = opencodeFragment(base, profiles, major);
    const agents = major === 1 ? fragment.agent : fragment.agents;
    const definitions = Object.entries(agents).map(([id, agent]) => {
      assert.equal(agent.mode, 'subagent');
      assert.deepEqual(Object.keys(agent).sort(), (major === 1 ? ['description', 'mode', 'model', 'prompt', 'permission'] : ['description', 'mode', 'model', 'system', 'permissions']).sort());
      if (major === 2) for (const r of agent.permissions) assert.deepEqual(Object.keys(r).sort(), ['action', 'effect', 'resource']);
      return major === 1 ? { name: id, model: { providerID: 'host', modelID: 'override' } } : { id, model: { providerID: 'host', id: 'override', variant: 'high' } };
    });
    for (const [role, kind] of [['fixer', 'writer'], ['test-author', 'writer'], ['review-editorial-prose', 'writer'], ['plan-review-probe', 'probe'], ['planner', 'reviewer'], ['integrator', 'reviewer'], ['gate-qa', 'reviewer']]) {
      const route = resolveRoute({ role, route: { model: 'claude-sonnet-4-6', effort: 'high' } }, {}, definitions, `v${major}`);
      assert.equal(route.agent, `factory-${kind}-mechanical`);
      assert.equal(route.providerID, 'host'); assert.equal(route.modelID, 'override');
    }
    const selected = resolveRoute({ role: 'gate-qa', route: { model: 'claude-sonnet-5', effort: 'high' } }, { roles: { 'gate-qa': { agent: 'factory-reviewer-mechanical', modelID: 'explicit', variants: { high: 'max' } } } }, definitions, `v${major}`);
    assert.equal(selected.modelID, 'explicit'); assert.equal(selected.variant, 'max');
    assert.throws(() => resolveRoute({ role: 'fixer', route: { model: 'not-installed' } }, {}, definitions, `v${major}`), /profile missing/);
  }
});

test('version detection refuses ambiguous/future binaries', () => {
  for (const value of ['2.0.1', 'opencode v2.0.10']) assert.equal(opencodeMajor(value), 2);
  assert.equal(opencodeMajor('opencode 1.9.2'), 1);
  for (const value of ['', null, '3.0.0', '20.0.0', 'build-2', '2', 'warning 2.0.10', 'opencode v2.0.0-beta.1', '1.18.31\n2.0.10']) assert.equal(opencodeMajor(value), null);
  assert.equal(selectOpencodeMajor(null, '2'), 2);
  assert.equal(selectOpencodeMajor('opencode v2.0.10'), 2);
  assert.throws(() => selectOpencodeMajor('1.18.31', '2'), /disagrees/);
  assert.throws(() => selectOpencodeMajor(null, '2.0.10'), /must be 1 or 2/);
  assert.throws(() => selectOpencodeMajor('3.0.0', '2'), /unsupported/);
});

test('v1 merge preserves exact, wildcard and shorthand deny, host settings and idempotency', () => {
  for (const bash of [{ 'git commit*': 'deny', 'git *': 'allow' }, { 'git *': 'deny' }, 'deny']) {
    const host = { model: 'local/model', provider: { local: { options: { baseURL: 'https://host.invalid' } } }, permission: { bash } };
    const saved = JSON.stringify(host);
    const merged = mergeOpencodeConfig(host, base);
    assert.equal(merged.refused, null);
    assert.equal(effect1(merged.config.permission.bash, 'git commit -m example'), 'deny');
    assert.deepEqual(merged.config.provider, host.provider);
    assert.equal(JSON.stringify(host), saved);
    assert.equal(mergeOpencodeConfig(merged.config, base).changed, false);
  }
  const fragment = opencodeFragment(base, profiles, 1);
  const host = { agent: { 'factory-reviewer-strong': { model: 'local/review', permission: { bash: 'deny' } } } };
  const merged = mergeOpencodeConfig(host, fragment);
  assert.equal(merged.config.agent['factory-reviewer-strong'].model, 'local/review');
  assert.equal(effect1(merged.config.agent['factory-reviewer-strong'].permission.bash, 'dotnet test'), 'deny');
  assert.equal(mergeOpencodeConfig(merged.config, fragment).changed, false);
  const strict = mergeOpencodeConfig({ permission: { bash: 'deny', read: { 'private/*': 'deny' } } }, fragment).config;
  assert.equal(effect1(strict.agent['factory-probe-cheap'].permission.bash, 'dotnet test'), 'deny');
  assert.equal(effect1(strict.agent['factory-probe-cheap'].permission.read, 'private/key'), 'deny');
});

test('v2 uses documented shapes and preserves broad, exact and per-agent denies', () => {
  const fragment = opencodeFragment(base, profiles, 2);
  assert.deepEqual(Object.keys(fragment).sort(), ['$schema', 'agents', 'permissions']);
  const host = { providers: { custom: { models: {} } }, permissions: [{ action: '*', resource: '*', effect: 'deny' }], agents: { 'factory-reviewer-strong': { model: 'host/choice', permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] } } };
  const merged = mergeOpencodeConfig(host, fragment, 2);
  assert.equal(merged.refused, null);
  assert.equal(effect2(merged.config.permissions, 'shell', 'git commit -m x'), 'deny');
  assert.deepEqual(merged.config.providers, host.providers);
  assert.equal(merged.config.agents['factory-reviewer-strong'].model, 'host/choice');
  assert.equal(effect2(merged.config.agents['factory-reviewer-strong'].permissions, 'shell', 'dotnet test'), 'deny');
  assert.equal(effect2(merged.config.agents['factory-writer-standard'].permissions, 'shell', 'git commit -m x'), 'deny');
  assert.equal(effect2(merged.config.agents['factory-writer-standard'].permissions, 'read', 'private/key'), 'deny');
  assert.equal(mergeOpencodeConfig(merged.config, fragment, 2).changed, false);
  const exact = mergeOpencodeConfig({ permissions: [{ action: 'shell', resource: 'git commit*', effect: 'deny' }] }, fragment, 2);
  assert.equal(effect2(exact.config.permissions, 'shell', 'git commit -m x'), 'deny');
});

test('profiles deny mutation while retaining live probes and writer artifacts', () => {
  for (const major of [1, 2]) {
    const fragment = opencodeFragment(base, profiles, major);
    const merged = mergeOpencodeConfig({}, fragment, major).config;
    const agents = major === 1 ? merged.agent : merged.agents;
    for (const [name, agent] of Object.entries(agents)) {
      assert.match(agent.model, /^[^/]+\/.+/);
      assert.equal(agent.mode, 'subagent');
      const effect = (action, resource) => major === 1 ? effect1(agent.permission[action === 'shell' ? 'bash' : action === 'subagent' ? 'task' : action] || {}, resource) : effect2(agent.permissions, action, resource);
      assert.equal(effect('shell', 'git commit -m x'), 'deny');
      assert.notEqual(effect('shell', 'dotnet test My.sln'), 'deny');
      assert.notEqual(effect('shell', 'curl http://localhost:8080/health'), 'deny');
      assert.equal(effect('subagent', 'general'), 'deny');
      assert.equal(effect('edit', 'state/ledger.json'), 'deny');
      assert.equal(effect('edit', 'src/file.cs') === 'deny', !name.includes('-writer-'));
    }
  }
});

test('unsafe config migrations are refused without destroying host content', () => {
  for (const [host, major] of [[[], 1], [{ permission: 'deny' }, 1], [{ permissions: [] }, 1], [{ agent: {} }, 2], [{ permission: {} }, 2], [{ instructions: 2 }, 1], [{ permissions: {} }, 2], [{ permissions: [{ action: 'shell' }] }, 2]]) {
    const before = JSON.stringify(host);
    const result = mergeOpencodeConfig(host, opencodeFragment(base, profiles, major), major);
    assert.ok(result.refused);
    assert.equal(result.changed, false);
    assert.equal(JSON.stringify(host), before);
  }
});

test('installed hashes update untouched old assets, preserve local edits and unknown migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-assets-'));
  try {
    const path = join(dir, 'manual.md'), hashes = {};
    assert.equal(installManagedFile(path, 'release 1', hashes, 'manual'), 'created');
    assert.equal(installManagedFile(path, 'release 2', hashes, 'manual'), 'updated');
    writeFileSync(path, 'my edits');
    assert.equal(installManagedFile(path, 'release 3', hashes, 'manual'), 'preserved');
    assert.equal(readFileSync(path, 'utf8'), 'my edits');
    assert.equal(readFileSync(path + '.factory-new', 'utf8'), 'release 3');
    assert.equal(hashes.manual, installedHash('release 2'));
    assert.equal(installManagedFile(path, 'release 4', {}, 'manual'), 'preserved');
    writeFileSync(path, 'release 4');
    assert.equal(installManagedFile(path, 'release 4', hashes, 'manual'), 'unchanged');
    assert.equal(installManagedFile(path, 'release 5', hashes, 'manual'), 'updated');
    assert.equal(readdirSync(dir).some((p) => p.includes('.tmp.')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('active AGENTS guidance preserves host text and conservatively updates only known blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-guidance-'));
  try {
    const path = join(dir, 'AGENTS.md'), hashes = {};
    writeFileSync(path, '# Host\r\nKeep strict rules.\r\n');
    assert.equal(installAgentsGuidance(path, 'Factory v1', hashes), 'updated');
    assert.ok(readFileSync(path, 'utf8').startsWith('# Host\r\nKeep strict rules.\r\n'));
    assert.equal(installAgentsGuidance(path, 'Factory v2', hashes), 'updated');
    assert.equal(installAgentsGuidance(path, 'Factory v2', hashes), 'unchanged');
    const content = readFileSync(path, 'utf8');
    assert.equal(installAgentsGuidance(path, 'Factory v3', {}), 'preserved');
    assert.equal(readFileSync(path, 'utf8'), content);
    writeAssetAtomic(path, content.replace('Factory v2', 'Local rules'));
    assert.equal(installAgentsGuidance(path, 'Factory v3', hashes), 'preserved');
    assert.match(readFileSync(path, 'utf8'), /Local rules/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
