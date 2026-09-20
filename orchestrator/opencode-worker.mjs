import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

export function dispatchConfig(host, cfg) {
  if (!host || typeof host !== 'object' || Array.isArray(host)) throw new Error('OpenCode dispatch config must be an object');
  const config = { ...host, agentConcurrency: cfg.modelConcurrency, buildConcurrency: cfg.buildCapacity };
  if (cfg.opencode?.url) config.url = cfg.opencode.url;
  if (cfg.opencode?.version) config.version = cfg.opencode.version;
  if (!config.url || !['http:', 'https:'].includes(new URL(config.url).protocol)) throw new Error('OpenCode dispatcher requires an http(s) server URL');
  if (config.version !== undefined && !['v1', 'v2'].includes(config.version)) throw new Error('OpenCode version must be v1 or v2');
  for (const key of ['agentConcurrency', 'buildConcurrency']) if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error('invalid dispatch capacity: ' + key);
  return config;
}

export async function runWorker(root, launchPath, configPath, invoke = async (file, args) => {
  const { stdout } = await exec(process.execPath, [file, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}) {
  const launch = JSON.parse(readFileSync(launchPath, 'utf8'));
  const ids = launch.items.map((item) => item.id);
  if (!ids.length || ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('invalid OpenCode lane membership');
  const runtime = join(root, '_workflow', 'opencode', 'runtime.mjs');
  for (const id of ids) await invoke(runtime, ['init', id, '--launch', launchPath]);
  const output = await invoke(join(root, '_workflow', 'opencode', 'dispatch.mjs'), ['--config', configPath, '--ids', ids.join(',')]);
  const results = JSON.parse(output);
  if (!Array.isArray(results) || results.length !== ids.length || new Set(results.map((r) => r.id)).size !== ids.length || results.some((r) => !ids.includes(r.id) || r.done !== true || r.unavailable)) throw new Error('OpenCode dispatcher returned an incomplete batch; resume its entire persisted membership/config');
  return { type: 'result', is_error: false, backend: 'opencode', ids, observationSource: 'state/items/<id>/dispatch/*-session.json' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, launchPath, configPath] = process.argv.slice(2);
  runWorker(root, launchPath, configPath).then((result) => console.log(JSON.stringify(result))).catch((e) => {
    console.error(e.message); process.exitCode = 1;
  });
}
