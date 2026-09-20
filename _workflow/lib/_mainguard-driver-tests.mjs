import { readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function extractFunction(source, name) {
  const start = new RegExp('\\b(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source)?.index;
  if (start === undefined) throw new Error('Missing driver function: ' + name);
  for (let end = source.indexOf('}', start); end !== -1; end = source.indexOf('}', end + 1)) {
    const text = source.slice(start, end + 1);
    try { new Function('return (' + text + ');'); return text; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  throw new Error('Cannot parse complete driver function: ' + name);
}

function extractDiagnosticTry(source) {
  const candidates = [];
  for (const match of source.matchAll(/\btry\b/g)) {
    for (let end = source.indexOf('}', match.index); end !== -1; end = source.indexOf('}', end + 1)) {
      const text = source.slice(match.index, end + 1);
      try {
        new AsyncFunction(text);
        if (/\bunclaimedMainDrift\s*\(/.test(text)) candidates.push(text);
        break;
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
  }
  candidates.sort((a, b) => a.length - b.length);
  if (!candidates.length) throw new Error('Cannot parse fold unclaimed-drift try/catch');
  return candidates[0];
}

export async function runMainGuardDriverTests(kind, { ok, eq }, sourceOverride) {
  const source = sourceOverride ?? readFileSync(new URL('../driver.mjs', import.meta.url), 'utf8');
  const code = kind === 'main-check'
    ? extractFunction(source, 'cmdMainCheck') + '\nawait cmdMainCheck(["A"], {});'
    : extractDiagnosticTry(extractFunction(source, 'cmdFold'));
  const root = '/fixture-repository';
  const cfg = { paths: { items: 'state/items', worktreesState: 'state/worktrees' } };
  const dirty = { paths: ['owner-edit.cs'], dirs: [] };
  const calls = [], rehashed = [], logs = [];
  const snapshots = { A: { files: { 'claimed-a.cs': 'a' } }, B: { files: { 'claimed-b.cs': 'b' } } };
  const context = {
    REPO_ROOT: root, MAIN_MOUNT_REL: 'factory', cfg, arr: [{ id: 'A' }],
    loadConfig: () => cfg, abs: path => join(root, path), join,
    readdirSync: () => ['A', 'B', 'CORRUPT'].map(name => ({ name, isDirectory: () => true })),
    existsSync: () => true,
    readJson: path => {
      const id = basename(dirname(path));
      if (!snapshots[id]) throw new Error('unreadable snapshot');
      return snapshots[id];
    },
    driftAgainstSnapshot: (repository, files) => { rehashed.push({ repository, files }); return []; },
    dirtyMainPaths: repository => { eq(repository, root, kind + ': reads dirt from the real repository root'); return dirty; },
    unclaimedMainDrift: (...args) => { calls.push(args); return ['owner-edit.cs']; },
    matchWorktreeDebris: () => [{ path: 'owner-edit.cs', matchedItem: null }],
    console: { log: message => logs.push(message) },
  };
  const execute = overrides => {
    const inputs = { ...context, ...overrides };
    return new AsyncFunction(...Object.keys(inputs), code + '\nreturn "continued";')(...Object.values(inputs));
  };
  eq(await execute(), 'continued', kind + ': diagnostic completes despite an unreadable sibling snapshot');
  eq(calls.length, 1, kind + ': one unclaimed sweep executes');
  eq(calls[0]?.slice(0, 2), [dirty, 'factory'], kind + ': forwards status and mount to the shared helper');
  eq([...(calls[0]?.[2] || [])].sort(), ['claimed-a.cs', 'claimed-b.cs'], kind + ': claims include every readable item, not only selected A');
  eq(calls[0]?.[3], { repoRoot: root }, kind + ': supplies physical root for alias-aware path identity');
  eq(await execute({ MAIN_MOUNT_REL: null }), 'continued', kind + ': external mount diagnostic completes');
  eq(calls[1]?.[1], null, kind + ': external mount forwards no exclusion');
  ok(logs.some(message => message.includes('MAIN-DRIFT unclaimed') && message.includes('owner-edit.cs')), kind + ': warns about actual returned unclaimed paths');
  if (kind === 'main-check') {
    eq(rehashed, Array(2).fill({ repository: root, files: snapshots.A.files }), 'targeted main-check rehashes only A while collecting every claim');
  } else {
    eq(await execute({ dirtyMainPaths: () => { throw new Error('status unavailable'); } }), 'continued', 'fold diagnostic git failure cannot abort subsequent fold');
    eq(await execute({ unclaimedMainDrift: () => { throw new Error('physical path unavailable'); } }), 'continued', 'fold diagnostic physical-identity failure cannot abort subsequent fold');
    eq(await execute({ readdirSync: () => { throw new Error('items unreadable'); } }), 'continued', 'fold diagnostic inventory failure cannot abort subsequent fold');
  }
}
