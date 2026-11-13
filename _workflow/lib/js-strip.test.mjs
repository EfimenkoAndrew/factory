// KI-E360 — the comment stripper's correctness net.
//
// Three layers:
//   1. unit cases: comments inside strings/templates/regexes survive; real comments die;
//      newlines inside comments are preserved (line-number fidelity); idempotence.
//   2. node --check on the STRIPPED factory.js (syntax-level proof over the real source).
//   3. execSmoke PARITY: run the RAW and the STRIPPED factory.js through the deterministic
//      stub-agent harness and require identical call-label sequences, checkpoint payloads and
//      terminal states. A mangle anywhere (a string, a regex, a template, a guardrail line the
//      stubs key off) changes prompt bytes -> stub-keyed dispatch -> this assertion fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripJsComments, stripFactorySource, FACTORY_BATCH_SENTINEL } from './js-strip.mjs';
import { execSmoke, smokeBatch, defaultAgentStub } from './_execsmoke.mjs';

test('unit: comments die, string/template/regex content survives, newlines preserved', () => {
  assert.equal(stripJsComments('const a = 1; // trail\nconst b = 2;'), 'const a = 1; \nconst b = 2;');
  assert.equal(stripJsComments('/* lead */ const a = 1;'), ' const a = 1;');
  assert.equal(stripJsComments('const s = "// not a comment";'), 'const s = "// not a comment";');
  assert.equal(stripJsComments("const s = '/* not */';"), "const s = '/* not */';");
  assert.equal(stripJsComments('const s = `// nope ${x /* inline */ + 1}`;'), 'const s = `// nope ${x  + 1}`;');
  assert.equal(stripJsComments('const s = `a ${obj["//key"]} b`;'), 'const s = `a ${obj["//key"]} b`;');
  assert.equal(stripJsComments('const r = /https?:\\/\\/x/;'), 'const r = /https?:\\/\\/x/;');
  assert.equal(stripJsComments('const r = /[<>:"|?*\\x00-\\x1f]/; // keep\n'), 'const r = /[<>:"|?*\\x00-\\x1f]/; \n');
  assert.equal(stripJsComments('const r = /(^|\\/)docs?\\//i;'), 'const r = /(^|\\/)docs?\\//i;');
  assert.equal(stripJsComments('x = a / b; // div'), 'x = a / b; ');
  assert.equal(stripJsComments('x /= 2; // div-assign'), 'x /= 2; ');
  assert.equal(stripJsComments('const f = () => /re/;'), 'const f = () => /re/;');
  assert.equal(stripJsComments('if (x) { /* block\ncomment */ }'), 'if (x) { \n }');
  assert.equal(stripJsComments('`multi\nline // tpl`'), '`multi\nline // tpl`');
  // nested interpolation braces: the `}` inside the arrow body must not close the template early
  assert.equal(stripJsComments('`${(() => { const a = 1; return a; })()}`'), '`${(() => { const a = 1; return a; })()}`');
  // idempotence
  const once = stripJsComments('a // c1\nb /* c2 */ c');
  assert.equal(stripJsComments(once), once);
  // the injection marker (a block comment) survives via the sentinel in stripFactorySource
  assert.equal(stripFactorySource('a = 1; /*__FACTORY_BATCH_INJECT__*/ b = 2; // gone\n'), 'a = 1; ' + FACTORY_BATCH_SENTINEL + ' b = 2; \n');
});

test('unit: line numbers are preserved across stripped comments', () => {
  const raw = '// one\n// two\nconst x = 1;\n/* three\nfour */\nconst y = 2;';
  const stripped = stripJsComments(raw);
  assert.equal(stripped.split('\n').length, raw.split('\n').length);
});

test('factory.js stripped source passes node --check', () => {
  const src = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const stripped = stripJsComments(src);
  // The rewritten factory.js on this line is comment-lean (a few KB of docs), so the assertion is
  // engine-agnostic: stripping must STRICTLY shrink the source and the result must parse. (On the
  // comment-heavy pre-rewrite engine this measured 43% shrinkage.)
  assert.ok(stripped.length < src.length, 'stripping must strictly shrink factory.js');
  const dir = mkdtempSync(join(tmpdir(), 'js-strip-check-'));
  try {
    const p = join(dir, 'factory-stripped.js');
    writeFileSync(p, stripped);
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('execSmoke parity: raw vs stripped factory.js produce identical outcomes', async () => {
  const raw = readFileSync(new URL('../factory.js', import.meta.url), 'utf8');
  const stripped = stripFactorySource(raw);
  const batch = smokeBatch();
  const agentOverride = (prompt, opts) => {
    // Deliberately key one stub off PROMPT CONTENT so a mangled string in a composed prompt
    // changes the dispatch and breaks parity: the fixer's prompt carries the acceptance text.
    if (opts.label && opts.label.endsWith(':fixer') && !prompt.includes('acceptance')) return null;
    return defaultAgentStub(opts);
  };
  const a = await execSmoke(raw, batch, { agentOverride });
  const b = await execSmoke(stripped, batch, { agentOverride });
  const shape = (r) => ({
    labels: r.calls.map((c) => c.label),
    toState: r.result.results.map((x) => x.toState),
    transitions: r.result.results.map((x) => x.transitions),
    checkpoints: r.checkpoints,
    note: r.result.results.map((x) => x.note),
  });
  assert.deepEqual(shape(b), shape(a), 'stripped source drives the identical agent-dispatch lifecycle');
  assert.ok(a.calls.length > 10, 'parity fixture exercised a real lifecycle (not a trivial short-circuit)');
});
