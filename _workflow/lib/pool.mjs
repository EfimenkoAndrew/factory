// Pure orchestration helpers — the proven audit shapes (audit-wave.js makeLimiter,
// rollup.js pool + retry), extracted as an ESM module so both the main-agent driver
// and unit smoke-tests can import them. factory.js (the Workflow script) cannot
// `import`, so it inlines byte-equivalent copies of makeLimiter/pool/retry; keep the
// two in sync — this file is the canonical reference + the testable copy.
//
// No Date.now()/Math.random() anywhere (they throw inside Workflow scripts; we keep
// this module Workflow-shaped on purpose so the inlined copies stay faithful).

// Minimal async semaphore: at most `max` gated thunks have work in flight at once.
// This is the deliberate 429 ceiling, held BELOW the runtime's own min(16, cores-2).
export function makeLimiter(max) {
  let active = 0;
  const queue = [];
  function pump() {
    while (active < max && queue.length > 0) {
      active++;
      const job = queue.shift();
      Promise.resolve().then(job.fn).then(
        function (v) { active--; job.resolve(v); pump(); },
        function (e) { active--; job.reject(e); pump(); }
      );
    }
  }
  return function gate(fn) {
    return new Promise(function (resolve, reject) {
      queue.push({ fn: fn, resolve: resolve, reject: reject });
      pump();
    });
  };
}

// Worker pool: run fn over items at concurrency n, preserving result order.
export async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const w = Math.min(n, items.length);
  const ws = [];
  for (let k = 0; k < w; k++) ws.push(worker());
  await Promise.all(ws);
  return results;
}

// Retry a thunk that returns a falsy value on transient failure (e.g. a 429-killed
// agent() returns null). `log` is optional (the Workflow provides a global `log`).
export async function retry(mk, attempts, log) {
  const note = log || function () {};
  for (let a = 0; a < attempts; a++) {
    const r = await mk();
    if (r) return r;
    note('[retry] attempt ' + (a + 1) + '/' + attempts);
  }
  return null;
}
