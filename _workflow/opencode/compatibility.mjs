export function parseOpenCodeVersion(output) {
  if (typeof output !== 'string') return null;
  const match = /^(?:opencode\s+)?v?(([12])\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/.exec(output.trim());
  if (!match || ![1, 2].includes(Number(match[2]))) return null;
  return { version: match[1], apiVersion: 'v' + match[2], configMajor: Number(match[2]) };
}

export async function detectOpenCodeApi({ url, headers = {}, fetchImpl = fetch, timeoutMs = 10000, version }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('positive API detection timeout required');
  if (version !== undefined && !['v1', 'v2'].includes(version)) throw new Error('OpenCode API version must be v1 or v2');
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('OpenCode server requires an http(s) URL');
  const candidates = version ? [version] : ['v1', 'v2'];
  const results = await Promise.all(candidates.map(async apiVersion => {
    const endpoint = apiVersion === 'v1' ? '/global/health' : '/api/info';
    try {
      const response = await fetchImpl(base.href.replace(/\/$/, '') + endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return { apiVersion, status: response.status, error: 'HTTP ' + response.status };
      let info;
      try { info = await response.json(); } catch { return { apiVersion, error: 'non-JSON response' }; }
      const parsed = parseOpenCodeVersion(info?.version);
      if (!parsed || parsed.apiVersion !== apiVersion || (apiVersion === 'v1' && info.healthy !== true)) return { apiVersion, error: 'unsupported or unhealthy runtime identity' };
      return { ...parsed, info };
    } catch (e) { return { apiVersion, error: e.name === 'TimeoutError' ? 'request timed out' : 'request failed' }; }
  }));
  const supported = results.filter(r => !r.error);
  if (supported.length > 1) throw new Error('ambiguous OpenCode API identities; select an explicit version');
  if (supported.length === 1) return supported[0];
  if (results.some(r => [401, 403].includes(r.status))) throw new Error('OpenCode authentication failed; supply server headers before version detection');
  throw new Error('cannot discover supported OpenCode API: ' + results.map(r => r.apiVersion + ' ' + r.error).join('; '));
}

export function openCodeAuthHeaders(headers = {}, env = process.env, version) {
  if (Object.keys(headers).some(key => key.toLowerCase() === 'authorization')) return { ...headers };
  const password = env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD;
  if (!password) return { ...headers };
  const username = version === 'v2' || env.OPENCODE_PASSWORD ? 'opencode' : env.OPENCODE_SERVER_USERNAME || 'opencode';
  return { ...headers, authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') };
}

export async function agentReady(api, directory, select, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(intervalMs) || intervalMs < 1) throw new Error('positive worker readiness timeout and interval required');
  const deadline = Date.now() + timeoutMs;
  let missing;
  do {
    let timer;
    try {
      return await Promise.race([
        api.agents(directory).then(select),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker profile readiness request timed out')), Math.max(1, deadline - Date.now())); }),
      ]);
    } catch (e) {
      if (!/^installed worker profile missing:/.test(e.message)) throw e;
      missing = e;
    } finally { clearTimeout(timer); }
    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, Math.min(intervalMs, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error('worker profiles not ready or not installed: ' + missing.message);
}

export async function waitForOpenCodeAgents(api, directory, requiredIds, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  if (!Array.isArray(requiredIds) || !requiredIds.length || requiredIds.some(id => typeof id !== 'string' || !id)) throw new Error('required worker profile IDs must be nonempty');
  return agentReady(api, directory, definitions => {
    const missing = requiredIds.filter(id => !definitions.some(d => (api.version === 'v1' ? d.name : d.id) === id));
    if (missing.length) throw new Error('installed worker profile missing: ' + missing.join(', '));
    return definitions;
  }, { timeoutMs, intervalMs });
}
