import { normalizeHostPath, canonicalRepoPath } from './repo-path.mjs';

export function baselineTarget(target, { worktree, platform } = {}) {
  platform ||= /^[A-Za-z]:[\\/]|^\\\\|^\/\//.test(worktree || target || '') ? 'win32' : 'linux';
  if (!worktree && !/^(?:[A-Za-z]:|[\\/])/.test(target || '')) return canonicalRepoPath(target, platform);
  const path = normalizeHostPath(target, { platform, base: worktree });
  if (worktree) {
    const root = normalizeHostPath(worktree, { platform }).replace(/\/$/, '');
    if (!path.startsWith(root + '/')) throw new Error('baseline target outside worktree');
  }
  return path;
}

export function canonicalFramework(value) {
  if (typeof value !== 'string') throw new Error('invalid framework identity');
  const framework = value.trim();
  const long = /^(\.NETCoreApp|\.NETStandard|\.NETFramework),Version=v([1-9]\d*|0)\.(\d+)(?:\.(\d+))?$/i.exec(framework);
  if (long) {
    const [, family, major, minor, patch] = long;
    if ((minor.length > 1 && minor[0] === '0') || (patch?.length > 1 && patch[0] === '0')) throw new Error('ambiguous framework version');
    const version = major + '.' + minor + (patch && patch !== '0' ? '.' + patch : '');
    return family.toLowerCase() + ',Version=v' + version;
  }
  const modern = /^(netcoreapp|netstandard|net)([1-9]\d*|0)\.(0|[1-9]\d*)(?:-([a-z][a-z0-9]*(?:\d+(?:\.\d+)*)?))?$/i.exec(framework);
  if (modern) {
    const [, family, major, minor, platform] = modern;
    if (family.toLowerCase() === 'net' && +major < 5) throw new Error('ambiguous framework TFM');
    return platform ? framework.toLowerCase()
      : (family.toLowerCase() === 'netstandard' ? '.netstandard' : '.netcoreapp') + ',Version=v' + major + '.' + minor;
  }
  const legacy = /^net([1-4])([0-9])([0-9])?$/i.exec(framework);
  if (legacy) return '.netframework,Version=v' + legacy[1] + '.' + legacy[2] + (legacy[3] && legacy[3] !== '0' ? '.' + legacy[3] : '');
  throw new Error('unsupported or ambiguous framework identity: ' + framework);
}

const canonicalSource = source => {
  const split = source.lastIndexOf('/');
  if (split < 0) return source;
  const framework = source.slice(split + 1);
  if (!/^(?:net|\.net)/i.test(framework)) return source;
  return source.slice(0, split + 1) + canonicalFramework(framework);
};

const identity = (source, test) => {
  if (typeof source !== 'string' || typeof test !== 'string' || !source.trim() || !test.trim()
    || /[\r\n\0]/.test(source + test)) throw new Error('invalid failed-test identity');
  return JSON.stringify([canonicalSource(source.trim()), test.trim()]);
};

export function failedTestIdentities(text, failed) {
  try {
    if (!Number.isSafeInteger(failed) || failed < 0) throw new Error('invalid failure count');
    const rows = [...String(text).matchAll(/^FACTORY::TEST::FAILURE(?: (.*))?\r?$/gm)];
    let ids;
    if (rows.length) {
      ids = rows.map(m => { const row = JSON.parse(m[1]); return identity(row.source, row.test); });
    } else {
      const sources = [...String(text).matchAll(/^Test run for (.+?\.dll)\s*\(([^\r\n]+)\)\s*\r?$/gm)]
        .map(m => m[1].replace(/\\/g, '/').split('/').pop() + '/' + m[2].trim());
      const tests = [...String(text).matchAll(/^\s+Failed (.+?)\s+\[[^\r\n]*\]\s*\r?$/gm)].map(m => m[1]);
      if (tests.length && sources.length !== 1) throw new Error('ambiguous or missing test assembly; emit failure markers');
      ids = tests.map(test => identity(sources[0], test));
    }
    const failedTests = [...new Set(ids)].sort();
    if (failedTests.length !== failed) throw new Error('failed tests lack complete unique identities');
    return { pass: true, failedTests };
  } catch (e) { return { pass: false, reason: e.message, failedTests: [] }; }
}

export function suiteInvocations(text) {
  const starts = [...String(text || '').matchAll(/^FACTORY::(BUILD|TEST::FILTER|TEST::SUITE)::START (.+)\r?$/gm)];
  return starts.flatMap((m, i) => m[1] !== 'TEST::SUITE' ? [] : [{ target: m[2].trim(),
    text: String(text).slice(m.index, starts[i + 1]?.index ?? String(text).length) }]);
}

export function captureBaseline(text, options = {}) {
  const targets = [];
  if (!text) return { version: 1, status: 'absent', targets };
  try {
    const runs = suiteInvocations(text);
    if (!runs.length) throw new Error('baseline lacks target-bound suite invocations');
    for (const run of runs) {
      const summaries = [...run.text.matchAll(/^FACTORY::SUMMARY::suite exit=(-?\d+) failed=(\d+) passed=(\d+)(?:[^\r\n]*)\r?$/gm)];
      if (summaries.length !== 1) throw new Error('baseline suite completion missing or duplicated');
      const [, code, f, p] = summaries[0], failed = Number(f), passed = Number(p);
      if (!Number.isSafeInteger(passed) || failed + passed <= 0 || Number(code) !== (failed ? 1 : 0)
        || /No test matches|No tests (?:were )?(?:found|available)/i.test(run.text)) throw new Error('invalid/nonvacuous baseline suite completion required');
      const evidence = failedTestIdentities(run.text, failed);
      if (!evidence.pass) throw new Error(evidence.reason);
      const target = baselineTarget(run.target, options);
      const previous = targets.find(t => t.target === target);
      if (previous && JSON.stringify(previous.failedTests) !== JSON.stringify(evidence.failedTests)) throw new Error('baseline retries disagree for ' + target);
      if (!previous) targets.push({ target, failed, passed, failedTests: evidence.failedTests });
    }
    return { version: 1, status: 'captured', targets };
  } catch (e) { return { version: 1, status: 'invalid', targets: [], reason: e.message }; }
}

export function compareSuiteBaseline(text, target, failed, baseline, options = {}) {
  const evidence = failedTestIdentities(text, failed);
  if (!evidence.pass) return evidence;
  if (failed === 0) return { pass: true, reason: 'suite clean' };
  if (!baseline || baseline.version !== 1 || baseline.status !== 'captured' || !Array.isArray(baseline.targets)) {
    return { pass: false, reason: 'suite failures require a captured target/test baseline (' + (baseline?.status || (baseline ? 'legacy count/name allowance refused' : 'absent')) + ')' };
  }
  try {
    const key = baselineTarget(target, options);
    const matches = baseline.targets.filter(row => baselineTarget(row.target, options) === key);
    if (matches.length !== 1) throw new Error('no unique captured baseline for target ' + key);
    const prior = matches[0];
    if (!Array.isArray(prior.failedTests) || prior.failedTests.length !== prior.failed
      || new Set(prior.failedTests).size !== prior.failedTests.length) throw new Error('invalid baseline failure identities');
    for (const id of prior.failedTests) {
      const pair = JSON.parse(id);
      if (!Array.isArray(pair) || pair.length !== 2 || identity(...pair) !== id) throw new Error('invalid baseline failure identity');
    }
    const added = evidence.failedTests.filter(id => !prior.failedTests.includes(id));
    if (added.length) throw new Error('new suite failure identities for ' + key + ': ' + added.join(', '));
    return { pass: true, reason: 'suite failed set is a subset of captured target baseline' };
  } catch (e) { return { pass: false, reason: e.message }; }
}
