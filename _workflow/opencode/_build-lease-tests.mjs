import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './identity.mjs';

const temp = mkdtempSync(join(tmpdir(), 'build-admission-'));
const children = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const moduleUrl = new URL('../lib/build-lease.mjs', import.meta.url).href;
const source = `import { withBuildSlot } from ${JSON.stringify(moduleUrl)};
import {existsSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const [root,id,mode]=process.argv.slice(1);
writeFileSync(join(root,id+'.waiting'),'yes');
try {withBuildSlot(root,()=>{writeFileSync(join(root,id+'.active'),'yes');
while(!existsSync(join(root,id+'.release'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
if(mode==='uncertain'){const e=new Error('uncertain child');e.unsettled=true;throw e;}},mode==='short'?180:5000);
}catch(e){writeFileSync(join(root,id+'.error'),e.message);process.exitCode=1;
if(mode==='uncertain') while(!existsSync(join(root,id+'.exit'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}`;
function start(root, id, mode = '') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, id, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.done = new Promise(resolve => child.once('close', code => resolve(code)));
  return child;
}
async function until(fn) {
  const deadline = Date.now() + 4000;
  while (!fn()) { if (Date.now() > deadline) throw new Error('fixture synchronization timeout'); await pause(10); }
}
function rootFor(name) { const root = join(temp, name); mkdirSync(join(root, 'state'), { recursive: true }); setLimit(root, 2); return root; }
function setLimit(root, limit) { writeJsonAtomic(join(root, 'state/build-capacity.json'), { limit }); }
function release(root, id) { writeFileSync(join(root, id + '.release'), 'yes'); }
try {
  for (const uncertain of [false, true]) {
    const root = rootFor(uncertain ? 'uncertain' : 'active');
    const first = start(root, 'first'); await until(() => existsSync(join(root, 'first.active')));
    const second = start(root, 'second', uncertain ? 'uncertain' : ''); await until(() => existsSync(join(root, 'second.active')));
    const slot1 = join(root, 'state/opencode-build-slots/1/owner.json');
    assert.equal(JSON.parse(readFileSync(slot1)).pid, second.pid);
    const waiter = start(root, 'waiter'); await until(() => existsSync(join(root, 'waiter.waiting')));
    await pause(100);
    setLimit(root, 1);
    const configBytes = readFileSync(join(root, 'state/build-capacity.json'), 'utf8');
    release(root, 'first'); assert.equal(await first.done, 0);
    await pause(180);
    assert.equal(existsSync(join(root, 'waiter.active')), false, 'existing waiter rereads shrunken limit and counts slot 1');
    const newcomer = start(root, 'newcomer'); await until(() => existsSync(join(root, 'newcomer.waiting')));
    await pause(120);
    assert.equal(existsSync(join(root, 'newcomer.active')), false, 'new admission counts higher occupied slot');
    release(root, 'second');
    if (uncertain) {
      await until(() => existsSync(join(root, 'second.error')));
      assert.equal(JSON.parse(readFileSync(slot1)).status, 'uncertain');
      await pause(120);
      assert.equal(existsSync(join(root, 'waiter.active')), false, 'live uncertain owner in higher slot consumes capacity');
      assert.equal(existsSync(join(root, 'newcomer.active')), false);
      writeFileSync(join(root, 'second.exit'), 'yes'); assert.equal(await second.done, 1);
      assert.equal(await waiter.done, 1); assert.equal(await newcomer.done, 1);
      assert.match(readFileSync(join(root, 'waiter.error'), 'utf8'), /orphaned build lease/);
      assert.equal(existsSync(slot1), true, 'orphaned higher slot never cleared');
    } else {
      assert.equal(await second.done, 0);
      await until(() => existsSync(join(root, 'waiter.active')) || existsSync(join(root, 'newcomer.active')));
      await pause(100);
      assert.notEqual(existsSync(join(root, 'waiter.active')), existsSync(join(root, 'newcomer.active')), 'admission mutex permits exactly one waiter');
      const winner = existsSync(join(root, 'waiter.active')) ? 'waiter' : 'newcomer';
      release(root, winner);
      await until(() => existsSync(join(root, 'waiter.active')) && existsSync(join(root, 'newcomer.active')));
      release(root, winner === 'waiter' ? 'newcomer' : 'waiter');
      assert.equal(await waiter.done, 0); assert.equal(await newcomer.done, 0);
    }
    assert.equal(readFileSync(join(root, 'state/build-capacity.json'), 'utf8'), configBytes, 'admission never edits host capacity');
  }
  const root = rootFor('mutex');
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => dead.once('close', resolve));
  const lock = join(root, 'state/opencode-build-slots/admission.lock'); mkdirSync(lock, { recursive: true });
  writeJsonAtomic(join(lock, dead.pid + '-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json'), { pid: dead.pid, status: 'admitting' });
  const recovered = start(root, 'recovered'); await until(() => existsSync(join(root, 'recovered.active')));
  release(root, 'recovered'); assert.equal(await recovered.done, 0);
  assert.deepEqual(readdirSync(join(root, 'state/opencode-build-slots')), [], 'dead admission mutex recovered without clearing leases');
  mkdirSync(lock);
  const unknown = start(root, 'unknown-owner', 'short');
  assert.equal(await unknown.done, 1);
  assert.equal(existsSync(lock), true, 'ownerless mutex never cleared by timeout');
  const high = rootFor('unknown-high-slot');
  mkdirSync(join(high, 'state/opencode-build-slots/97'), { recursive: true });
  const blocked = start(high, 'blocked', 'short');
  assert.equal(await blocked.done, 1);
  assert.equal(existsSync(join(high, 'blocked.active')), false, 'unknown high slot fences admission');
  console.log('Build leases: actual child shrink, queued/new admission, higher uncertain orphan, dynamic capacity, mutex serialization/recovery and read-only config passed');
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(children.map(child => child.done));
  rmSync(temp, { recursive: true, force: true });
}
