import { digest, isWriter } from './identity.mjs';
import { readFileSync } from 'node:fs';
const PROFILES = JSON.parse(readFileSync(new URL('../../opencode-assets/worker-profiles.json', import.meta.url), 'utf8'));
const pathKey = s => { const p = String(s || '').replace(/\\/g, '/').replace(/\/$/, ''); return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p; };

function validSession(session, id, title, directory, version) {
  if (!session || typeof session.id !== 'string' || !session.id.startsWith('ses') || (id && session.id !== id) || session.title !== title || session.parentID || session.fork || pathKey(version === 'v1' ? session.directory : session.location?.directory) !== pathKey(directory)) throw new Error('stale/malformed session identity or worktree');
  return session.id;
}

function usageFor(messages, version) {
  const rows = messages.map(m => version === 'v1' ? m.info : m);
  const values = rows.map(r => r.tokens);
  const sum = get => values.every(v => typeof get(v) === 'number') ? values.reduce((s, v) => s + get(v), 0) : null;
  return { usage: { input: sum(v => v?.input), output: sum(v => v?.output), cache: { read: sum(v => v?.cache?.read), write: sum(v => v?.cache?.write) } }, cost: rows.every(r => typeof r.cost === 'number') ? rows.reduce((s, r) => s + r.cost, 0) : null };
}

function toolsSettled(messages, version) {
  return messages.every(m => {
    const parts = version === 'v1' ? m.parts : m.content;
    if (!Array.isArray(parts)) return version === 'v1' ? m.info?.role !== 'assistant' : m.type !== 'assistant';
    return parts.every(p => p.type !== 'tool' || ['completed', 'error'].includes(p.state?.status));
  });
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; this.retryable = status === 429 || status >= 500; }
}

export class OpenCodeServer {
  constructor({ url, version, headers = {}, fetchImpl = fetch, timeoutMs = 30000 }) {
    if (!['v1', 'v2'].includes(version)) throw new Error('explicit API version v1 or v2 required');
    this.url = url.replace(/\/$/, ''); this.version = version; this.headers = headers; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this.unsentSessions = new Set();
  }
  async request(method, path, body, directory) {
    const u = new URL(this.url + path);
    if (directory && this.version === 'v1') u.searchParams.set('directory', directory);
    const r = await this.fetch(u, { method, headers: { 'content-type': 'application/json', ...this.headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new ApiError(method + ' ' + u.pathname + ': HTTP ' + r.status + ' ' + (await r.text()).slice(0, 500), r.status);
    return r.status === 204 ? null : r.json();
  }
  async check() {
    const info = await this.request('GET', this.version === 'v1' ? '/global/health' : '/api/info');
    if (this.version === 'v1' && (info.healthy !== true || !/^1\./.test(info.version))) throw new Error('server is not a healthy v1 runtime');
    if (this.version === 'v2' && !/^2\./.test(info.version || '')) throw new Error('server is not a v2 runtime');
    this.runtimeInfo = info; return info;
  }
  async agents(directory) {
    const result = await this.request('GET', this.version === 'v1' ? '/agent' : '/api/agent?location[directory]=' + encodeURIComponent(directory), undefined, directory);
    const agents = this.version === 'v1' ? result : result?.data;
    if (!Array.isArray(agents)) throw new Error('missing effective worker profile definitions');
    return agents;
  }
  async route(dispatch, config, directory) {
    return resolveRoute(dispatch, config, await this.agents(directory), this.version);
  }
  async create(dispatch, directory, route) {
    const title = 'factory:' + dispatch.dispatchId;
    if (this.version === 'v1') {
      const existing = await this.request('GET', '/session', undefined, directory);
      if (!Array.isArray(existing)) throw new Error('malformed session list');
      const matches = existing.filter(s => s.title === title);
      if (matches.length > 1) throw new Error('ambiguous dispatch session identity');
      if (matches.length) return validSession(matches[0], null, title, directory, this.version);
      const s = await this.request('POST', '/session', { title }, directory);
      const id = validSession(s, null, title, directory, this.version);
      this.unsentSessions.add(id);
      return id;
    }
    const id = 'ses_' + digest(dispatch.dispatchId).slice(0, 32);
    try { const prior = await this.request('GET', '/api/session/' + id); return validSession(prior?.data, id, title, directory, this.version); }
    catch (e) { if (e.status !== 404) throw e; }
    const s = await this.request('POST', '/api/session', { id, title, agent: route.agent, model: { providerID: route.providerID, id: route.modelID, ...(route.variant ? { variant: route.variant } : {}) }, location: { directory } });
    return validSession(s?.data, id, title, directory, this.version);
  }
  async verifySession(mapping, directory) {
    const response = await this.request('GET', (this.version === 'v1' ? '/session/' : '/api/session/') + encodeURIComponent(mapping.sessionId), undefined, directory);
    const session = this.version === 'v1' ? response : response?.data;
    validSession(session, mapping.sessionId, 'factory:' + mapping.dispatchId, directory, this.version);
    if (this.version === 'v2' && (session.agent !== mapping.requestedModel.agent || session.model?.id !== mapping.requestedModel.modelID || session.model?.providerID !== mapping.requestedModel.providerID)) throw new Error('session route changed after dispatch');
  }
  async send(mapping, prompt, route, directory) {
    this.unsentSessions.delete(mapping.sessionId);
    const id = encodeURIComponent(mapping.sessionId);
    if (this.version === 'v1') return this.request('POST', '/session/' + id + '/prompt_async', {
      messageID: mapping.messageId, agent: route.agent,
      model: { providerID: route.providerID, modelID: route.modelID },
      parts: [{ type: 'text', text: prompt }],
    }, directory);
    const response = await this.request('POST', '/api/session/' + id + '/prompt', { id: mapping.messageId, text: prompt, metadata: { factoryDispatchId: mapping.dispatchId } });
    if (response?.data?.id !== mapping.messageId || response.data.sessionID !== mapping.sessionId || response.data.type !== 'user') throw new Error('malformed v2 durable admission response');
    return response;
  }
  async messages(mapping, directory) {
    const id = encodeURIComponent(mapping.sessionId);
    if (this.version === 'v1') {
      const messages = await this.request('GET', '/session/' + id + '/message', undefined, directory);
      if (!Array.isArray(messages)) throw new Error('malformed v1 message envelope');
      return messages;
    }
    const all = []; let cursor; const seen = new Set();
    do {
      const path = '/api/session/' + id + '/message?' + (cursor ? 'cursor=' + encodeURIComponent(cursor) : 'order=asc');
      const page = await this.request('GET', path);
      if (!Array.isArray(page?.data) || !page.cursor || !(page.cursor.next === null || typeof page.cursor.next === 'string')) throw new Error('unsupported v2 message envelope');
      all.push(...page.data); cursor = page.cursor?.next;
      if (cursor && seen.has(cursor)) throw new Error('repeated v2 pagination cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return all;
  }
  async admissionKnown(mapping, directory) {
    if (this.version === 'v2') {
      const queued = (await this.inbox(mapping)).find(i => i.id === mapping.messageId && i.type === 'user');
      if (queued) return digest(queued.payload?.text || '') === mapping.promptHash;
    }
    const messages = await this.messages(mapping, directory);
    const input = messages.find(m => this.version === 'v1' ? m.info?.id === mapping.messageId && m.info?.role === 'user' && m.info?.sessionID === mapping.sessionId : m.id === mapping.messageId && m.type === 'user');
    if (!input) return false;
    const text = this.version === 'v1' ? input.parts.filter(p => p.type === 'text').map(p => p.text).join('\n') : input.text;
    return digest(text) === mapping.promptHash;
  }
  async outcome(mapping, directory) {
    await this.verifySession(mapping, directory);
    const messages = await this.settledMessages(mapping, directory);
    if (!messages) return { pending: true };
    if (this.version === 'v1') {
      if (messages.some(m => !m.info || m.info.sessionID !== mapping.sessionId)) throw new Error('message session identity mismatch');
      const users = messages.filter(m => m.info.role === 'user');
      if (users.some(m => m.info.id !== mapping.messageId)) throw new Error('foreign user input in dispatch session');
      if (users.length !== 1) return { pending: true };
      if (!users[0].parts.some(p => p.type === 'text')) return { pending: true };
      if (digest(users[0].parts.filter(p => p.type === 'text').map(p => p.text).join('\n')) !== mapping.promptHash) throw new Error('durable prompt content mismatch');
      const related = messages.filter(m => m.info?.role === 'assistant' && m.info.parentID === mapping.messageId);
      const last = related.at(-1);
      if (last?.info.error) return { failed: true, settled: true, error: last.info.error };
      if (!last || !last.info.time?.completed || !last.info.finish || last.info.finish === 'tool-calls') return { pending: true };
      if (last.info.error || last.info.finish !== 'stop') return { failed: true, settled: true, error: last.info.error || last.info.finish };
      return { settled: true, text: last.parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), actualModel: last.info.providerID && last.info.modelID ? last.info.providerID + '/' + last.info.modelID : null, ...usageFor(related, this.version) };
    }
    const user = messages.findIndex(m => m.id === mapping.messageId && m.type === 'user');
    if (messages.some(m => ['user', 'synthetic'].includes(m.type) && m.id !== mapping.messageId)) throw new Error('foreign input in dispatch session');
    if (user < 0) return { pending: true };
    if (digest(messages[user].text) !== mapping.promptHash) throw new Error('durable prompt content mismatch');
    const related = messages.slice(user + 1).filter(m => m.type === 'assistant');
    const last = related.at(-1);
    if (last?.error) return { failed: true, settled: true, error: last.error };
    if (!last || !last.time?.completed || !last.finish || last.finish === 'tool-calls') return { pending: true };
    if (last.error || last.finish !== 'stop') return { failed: true, settled: true, error: last.error || last.finish };
    return { settled: true, text: last.content.filter(p => p.type === 'text').map(p => p.text).join('\n'), actualModel: last.model?.providerID && last.model?.id ? last.model.providerID + '/' + last.model.id : null, ...usageFor(related, this.version) };
  }
  async executionIdle(mapping, directory) {
    const response = await this.request('GET', this.version === 'v1' ? '/session/status' : '/api/session/active', undefined, directory);
    const states = this.version === 'v1' ? response : response?.data;
    if (!states || typeof states !== 'object' || Array.isArray(states)) throw new Error('missing execution state');
    if (this.version === 'v2') return !Object.hasOwn(states, mapping.sessionId);
    const status = states[mapping.sessionId];
    // The v1 status implementation deletes idle sessions from its map.
    return status === undefined || status?.type === 'idle';
  }
  async settledMessages(mapping, directory) {
    const before = await this.messages(mapping, directory);
    if (!await this.executionIdle(mapping, directory)) return null;
    if (this.version === 'v2' && (await this.inbox(mapping)).length) return null;
    const after = await this.messages(mapping, directory);
    if (!toolsSettled(after, this.version) || !await this.executionIdle(mapping, directory)) return null;
    if (this.version === 'v2' && (await this.inbox(mapping)).length) return null;
    if (digest(before) !== digest(after)) return null;
    return after;
  }
  async inbox(mapping) {
    const result = await this.request('GET', '/api/session/' + encodeURIComponent(mapping.sessionId) + '/inbox');
    if (!Array.isArray(result?.data) || result.data.some(i => !i.id || i.sessionID !== mapping.sessionId)) throw new Error('malformed durable inbox');
    return result.data;
  }
  async stop(mapping, directory) {
    await this.verifySession(mapping, directory);
    let v1Started = false, unsent = false;
    if (this.version === 'v1') {
      const before = await this.messages(mapping, directory);
      unsent = this.unsentSessions.has(mapping.sessionId) && before.length === 0;
      const users = before.filter(m => m.info?.role === 'user');
      const input = users.length === 1 && users[0].info.id === mapping.messageId && users[0].info.sessionID === mapping.sessionId ? users[0] : null;
      const text = input?.parts?.filter(p => p.type === 'text').map(p => p.text).join('\n');
      const matched = !!text && digest(text) === mapping.promptHash;
      const terminal = before.some(m => m.info?.role === 'assistant' && m.info.sessionID === mapping.sessionId && m.info.parentID === mapping.messageId
        && (m.info.error || (m.info.time?.completed && m.info.finish && m.info.finish !== 'tool-calls')));
      v1Started = matched && (terminal || !await this.executionIdle(mapping, directory));
    }
    if (this.version === 'v2') await this.request('DELETE', '/api/session/' + encodeURIComponent(mapping.sessionId) + '/inbox/' + encodeURIComponent(mapping.messageId));
    await this.interrupt(mapping, directory);
    if (this.version === 'v1' && !v1Started && !unsent) throw new Error('session not proven stopped: v1 prompt handler may not have started');
    const messages = await this.settledMessages(mapping, directory);
    if (!messages || (unsent && messages.length)) throw new Error('session not proven stopped after cancellation');
    return { stopped: true };
  }
  async interrupt(mapping, directory) {
    const response = await this.request('POST', this.version === 'v1' ? '/session/' + encodeURIComponent(mapping.sessionId) + '/abort' : '/api/session/' + encodeURIComponent(mapping.sessionId) + '/interrupt?resume=false', undefined, directory);
    if (this.version === 'v1' ? response !== true : typeof response?.interrupted !== 'boolean') throw new Error('interrupt not acknowledged');
    return response;
  }
}

export function resolveRoute(dispatch, config, definitions, version = config.version) {
  const override = config.roles?.[dispatch.role] || config.models?.[dispatch.route.model];
  const tier = Object.entries(PROFILES.models).find(([, model]) => model.split('/').slice(1).join('/') === dispatch.route.model)?.[0];
  const kind = isWriter(dispatch.role) ? 'writer' : dispatch.role.endsWith('-probe') || dispatch.role === 'consolidated-scan-shadow' ? 'probe' : 'reviewer';
  const agent = override?.agent || (tier && `factory-${kind}-${tier}`);
  const definition = definitions?.find(d => (version === 'v2' ? d.id : d.name) === agent);
  if (definitions && !definition) throw new Error('installed worker profile missing: ' + agent);
  const model = definition?.model;
  const route = { agent, providerID: override?.providerID || model?.providerID, modelID: override?.modelID || (version === 'v2' ? model?.id : model?.modelID), variant: override?.variants?.[dispatch.route.effort] || override?.variant || model?.variant };
  if (!route.agent || !route.providerID || !route.modelID) throw new Error('explicit or installed route missing for ' + dispatch.role + ' (' + dispatch.route.model + ')');
  return route;
}
