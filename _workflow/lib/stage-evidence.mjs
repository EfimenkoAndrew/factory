import { parseVerifyRaw, verdictFromParse } from './verify.mjs';
import { normalizeHostPath } from './repo-path.mjs';
import { compareSuiteBaseline } from './baseline.mjs';

export function completeCommand(run, sub, target, filter, baseline = null, options = {}) {
  const fail = reason => ({ pass: false, reason: sub + ': ' + reason });
  if (!run || run.code < 0 || run.error || run.signal) return fail('invocation unavailable');
  const text = run.output || '';
  const starts = { build: 'BUILD', filter: 'TEST::FILTER', suite: 'TEST::SUITE' };
  const start = 'FACTORY::' + starts[sub] + '::START ' + target + (sub === 'filter' ? ' :: ' + filter : '');
  if (!text.split(/\r?\n/).includes(start)) return fail('missing/mismatched target or filter START');
  const summaries = [...text.matchAll(new RegExp('^FACTORY::SUMMARY::' + sub + ' exit=(-?\\d+)([^\\r\\n]*)$', 'gm'))];
  if (summaries.length !== 1 || Number(summaries[0][1]) !== run.code) return fail('missing, duplicate or inconsistent completion marker');
  if (sub === 'build') return run.code === 0 && /\berrors=0\b/.test(summaries[0][2]) ? { pass: true } : fail('build failed');
  if (/No test matches|No tests (?:were )?(?:found|available)/i.test(text)) return fail('vacuous test selection');
  const counts = [...text.matchAll(/(?:Passed!|Failed!)[^\r\n]*Failed:\s*(\d+)[^\r\n]*Passed:\s*(\d+)/g)];
  const keyed = /failed=(\d+) passed=(\d+)/.exec(summaries[0][2]);
  if (sub === 'suite' && !keyed) return fail('suite keyed counts missing');
  const count = keyed || counts.at(-1);
  if (!count || Number(count[1]) + Number(count[2]) <= 0) return fail('missing/nonpositive executed test count');
  if (sub === 'filter' && (run.code !== 0 || Number(count[1]) !== 0)) return fail('targeted regression failed');
  if (run.code === 0 && Number(count[1]) !== 0) return fail('failed tests contradict successful exit');
  if (run.code !== 0 && (run.code !== 1 || Number(count[1]) === 0)) return fail('test failure outside recorded baseline');
  if (sub === 'suite') {
    const comparison = compareSuiteBaseline(text, target, Number(count[1]), baseline, options);
    if (!comparison.pass) return fail(comparison.reason);
  }
  const verdict = verdictFromParse(parseVerifyRaw(text), baseline, options);
  return verdict.pass ? { pass: true } : fail(verdict.reason);
}

export function completeVerificationTranscript(text, { band, baseline = 0, expected, worktree, required = band === 'FULL' ? ['build', 'filter', 'suite'] : ['build', 'filter'] } = {}) {
  const platform = /^[A-Za-z]:[\\/]|^\\\\|^\/\//.test(worktree || '') ? 'win32' : 'linux';
  const normalize = value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('empty expected target');
    const path = normalizeHostPath(value, { platform, base: worktree });
    if (worktree) {
      const root = normalizeHostPath(worktree, { platform }).replace(/\/$/, '');
      if (!path.startsWith(root + '/')) throw new Error('target outside worktree');
    }
    return path;
  };
  let invocations = null;
  try {
    if (expected !== undefined) {
      if (!expected || typeof expected !== 'object' || Object.keys(expected).some(sub => !['build', 'filter', 'suite'].includes(sub))) throw new Error('invalid expected command contract');
      invocations = Object.entries(expected).flatMap(([sub, values]) => {
        if (!Array.isArray(values)) throw new Error('expected command entries must be arrays');
        return values.map(value => {
          const filter = sub === 'filter' ? value && value.filter : null;
          if (sub === 'filter' && (typeof filter !== 'string' || !filter.trim())) throw new Error('expected filter must be explicit and nonempty');
          return { sub, target: normalize(typeof value === 'string' ? value : value && value.target), filter };
        });
      });
      if (required.some(sub => !invocations.some(v => v.sub === sub))) throw new Error('missing trusted expected invocations');
    }
  } catch (e) { return { pass: false, reason: e.message }; }
  const starts = [...String(text).matchAll(/^FACTORY::(BUILD|TEST::FILTER|TEST::SUITE)::START (.+)\r?$/gm)];
  const seen = new Set();
  const matched = new Set();
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const sub = m[1] === 'BUILD' ? 'build' : m[1] === 'TEST::FILTER' ? 'filter' : 'suite';
    const body = text.slice(m.index, starts[i + 1]?.index ?? text.length);
    const completion = new RegExp('^FACTORY::SUMMARY::' + sub + ' exit=(-?\\d+)', 'm').exec(body);
    if (!completion) return { pass: false, reason: sub + ': incomplete invocation' };
    const [target, ...filters] = m[2].trim().split(' :: ');
    if (sub === 'filter' && !filters.join(' :: ').trim()) return { pass: false, reason: 'empty regression filter' };
    if (invocations) {
      let path;
      try { path = normalize(target); } catch (e) { return { pass: false, reason: e.message }; }
      const matches = invocations.map((v, index) => v.sub === sub && v.target === path && (sub !== 'filter' || v.filter === filters.join(' :: ')) ? index : -1).filter(index => index >= 0);
      if (!matches.length) return { pass: false, reason: 'unexpected ' + sub + ' target/filter: ' + target + ' :: ' + filters.join(' :: ') };
      for (const index of matches) matched.add(index);
    }
    const verdict = completeCommand({ code: Number(completion[1]), output: body }, sub, target, filters.join(' :: '), baseline, { worktree, platform });
    if (!verdict.pass) return verdict;
    seen.add(sub);
  }
  const missing = required.filter(sub => !seen.has(sub));
  if (invocations && invocations.some((v, index) => !matched.has(index))) return { pass: false, reason: 'missing required build/filter/suite invocation for expected targets' };
  return missing.length ? { pass: false, reason: 'missing required invocation: ' + missing.join(', ') } : { pass: true, reason: 'complete machine transcript' };
}
