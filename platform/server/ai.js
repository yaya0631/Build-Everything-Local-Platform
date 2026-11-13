/**
 * Local AI service.
 *
 * Providers are stored in SQLite and configured by the user; nothing is called
 * until one is saved. Each capability (chat, txt2img, txt2speech, speech2txt,
 * img2txt) resolves to a provider that can serve it, so a user can run chat on
 * a local Ollama model and images on an OpenAI-compatible endpoint, or point
 * everything at one provider.
 *
 * When no provider can serve a capability the request fails with
 * `local_ai_unavailable` and the apps show their normal unavailable state.
 */

import crypto from 'node:crypto';
import { createAdapter, PROVIDER_PRESETS, PROVIDER_KINDS, CAPABILITIES, unavailableError } from './ai-providers.js';

export function initAi(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT,
      default_model TEXT,
      models_json TEXT,
      capabilities_json TEXT,
      timeout_ms INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `);
}

/** Capabilities a provider kind can serve without extra configuration. */
function defaultCapabilities(kind) {
  if (kind === 'anthropic') return ['chat', 'img2txt'];
  if (kind === 'ollama') return ['chat'];
  return ['chat', 'txt2img', 'txt2speech', 'speech2txt', 'img2txt'];
}

function rowToProvider(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    base_url: row.base_url,
    api_key: row.api_key || '',
    default_model: row.default_model || '',
    models: row.models_json ? JSON.parse(row.models_json) : [],
    capabilities: row.capabilities_json ? JSON.parse(row.capabilities_json) : defaultCapabilities(row.kind),
    timeout_ms: row.timeout_ms || 120000,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The provider record as the browser may see it: the key is never sent back. */
export function publicProvider(provider) {
  if (!provider) return null;
  const { api_key: key, ...rest } = provider;
  return { ...rest, has_key: !!key };
}

/** Live catalogues change slowly; asking every provider on every request would be slow and rude. */
const MODEL_CACHE_MS = 5 * 60 * 1000;
const MODEL_FAILURE_MS = 30 * 1000;

/**
 * Model ids drift between the spelling a person saves and the spelling a
 * provider lists: OpenRouter lists the vendor prefix (`nvidia/…`) and uses a
 * dot where the settings field may have a dash (`claude-opus-5.5`). Compare the
 * names after dropping the vendor prefix and treating punctuation as a dash.
 */
function looseModelKey(id) {
  return String(id || '')
    .trim()
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[\s_.:]+/g, '-')
    .replace(/-+/g, '-');
}

/** The provider's spelling of a model, or '' when it cannot be told apart. */
function canonicalModelId(wanted, ids) {
  const value = String(wanted || '').trim();
  if (!value || !ids.length) return '';
  if (ids.includes(value)) return value;
  const lower = value.toLowerCase();
  const exact = ids.find((id) => id.toLowerCase() === lower);
  if (exact) return exact;
  const key = looseModelKey(value);
  if (!key) return '';
  const loose = ids.filter((id) => looseModelKey(id) === key);
  return loose.length === 1 ? loose[0] : '';
}

export function createAiService(ctx) {
  const { db } = ctx;
  const adapterCache = new Map();
  const modelCache = new Map();

  function listProviders() {
    return db.prepare('SELECT * FROM ai_providers ORDER BY created_at ASC').all().map(rowToProvider);
  }

  function getProvider(id) {
    return rowToProvider(db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(String(id)));
  }

  function getSetting(key, fallback = null) {
    const row = db.prepare('SELECT value_json FROM ai_settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return fallback;
    }
  }

  function setSetting(key, value) {
    db.prepare('INSERT OR REPLACE INTO ai_settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify(value));
    return value;
  }

  function normalizeInput(input) {
    const kind = PROVIDER_KINDS.includes(input.kind) ? input.kind : 'openai';
    const name = String(input.name || '').trim() || PROVIDER_PRESETS.find((p) => p.id === input.preset)?.label || 'Provider';
    const baseUrl = String(input.base_url || '').trim();
    if (!baseUrl) throw unavailableError('A base URL is required.', 400);
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw unavailableError('The base URL is not a valid URL.', 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw unavailableError('The base URL must be http or https.', 400);
    }
    return {
      name,
      kind,
      base_url: baseUrl,
      api_key: input.api_key === undefined ? undefined : String(input.api_key || '').trim(),
      default_model: String(input.default_model || '').trim(),
      models: Array.isArray(input.models) ? input.models : [],
      capabilities: Array.isArray(input.capabilities) && input.capabilities.length
        ? input.capabilities.filter((c) => CAPABILITIES.includes(c))
        : defaultCapabilities(kind),
      timeout_ms: Number(input.timeout_ms) > 0 ? Number(input.timeout_ms) : 120000,
      enabled: input.enabled === undefined ? true : !!input.enabled,
    };
  }

  function saveProvider(input) {
    const now = Date.now();
    const clean = normalizeInput(input);
    const existing = input.id ? getProvider(input.id) : null;
    const id = existing ? existing.id : `prov-${crypto.randomBytes(6).toString('hex')}`;
    // An empty api_key on update means "keep the stored key".
    const apiKey = clean.api_key === undefined ? existing?.api_key ?? '' : clean.api_key || '';

    db.prepare(`
      INSERT INTO ai_providers (id, name, kind, base_url, api_key, default_model, models_json, capabilities_json, timeout_ms, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, kind = excluded.kind, base_url = excluded.base_url, api_key = excluded.api_key,
        default_model = excluded.default_model, models_json = excluded.models_json,
        capabilities_json = excluded.capabilities_json, timeout_ms = excluded.timeout_ms,
        enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(
      id, clean.name, clean.kind, clean.base_url, apiKey, clean.default_model,
      JSON.stringify(clean.models), JSON.stringify(clean.capabilities),
      clean.timeout_ms, clean.enabled ? 1 : 0, existing?.created_at ?? now, now
    );
    adapterCache.delete(id);
    modelCache.delete(id);
    return getProvider(id);
  }

  function deleteProvider(id) {
    db.prepare('DELETE FROM ai_providers WHERE id = ?').run(String(id));
    adapterCache.delete(String(id));
    modelCache.delete(String(id));
    const routes = getSetting('routes', {});
    for (const [cap, provId] of Object.entries(routes)) {
      if (provId === id) delete routes[cap];
    }
    setSetting('routes', routes);
    return { deleted: true, id };
  }

  function adapterFor(provider) {
    if (!adapterCache.has(provider.id)) adapterCache.set(provider.id, createAdapter(provider));
    return adapterCache.get(provider.id);
  }

  /** Models saved with the provider, in either the string or the object form. */
  function savedModels(provider) {
    return (Array.isArray(provider.models) ? provider.models : [])
      .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m?.id || m?.name, name: m?.name || m?.id }))
      .filter((m) => m.id)
      .map((m) => ({ id: String(m.id), name: String(m.name || m.id) }));
  }

  /** The provider's live catalogue, cached; an unreachable provider keeps the last list it gave. */
  async function liveModels(provider) {
    const now = Date.now();
    const hit = modelCache.get(provider.id);
    if (hit && now - hit.at < (hit.ok ? MODEL_CACHE_MS : MODEL_FAILURE_MS)) return hit.models;
    try {
      const models = await adapterFor(provider).listModels();
      const clean = (Array.isArray(models) ? models : [])
        .map((m) => ({ id: String(m?.id || m?.name || ''), name: String(m?.name || m?.id || '') }))
        .filter((m) => m.id);
      modelCache.set(provider.id, { at: now, ok: true, models: clean });
      return clean;
    } catch {
      modelCache.set(provider.id, { at: now, ok: false, models: hit?.models || [] });
      return hit?.models || [];
    }
  }

  /**
   * Everything an app may choose for a provider: its live models, models saved
   * in Settings, and the configured default. The default is resolved to the
   * provider's own spelling when possible and marked `default`.
   */
  async function providerModels(provider, capability) {
    if (capability && !provider.capabilities.includes(capability)) return [];
    const entries = new Map();
    for (const m of await liveModels(provider)) {
      entries.set(m.id, { id: m.id, name: m.name, provider: provider.name, provider_id: provider.id, source: 'live' });
    }
    for (const m of savedModels(provider)) {
      if (!entries.has(m.id)) entries.set(m.id, { ...m, provider: provider.name, provider_id: provider.id, source: 'saved' });
    }
    const wanted = String(provider.default_model || '').trim();
    if (wanted) {
      const id = canonicalModelId(wanted, [...entries.keys()]) || wanted;
      if (entries.has(id)) entries.get(id).default = true;
      else entries.set(id, { id, name: wanted, provider: provider.name, provider_id: provider.id, source: 'default', default: true });
    }
    return [...entries.values()];
  }

  /** Every model the signed-in person can pick, from every enabled provider. */
  async function listModels({ capability } = {}) {
    const providers = listProviders().filter((provider) => provider.enabled);
    const groups = await Promise.all(providers.map((provider) => providerModels(provider, capability)));
    return groups.flat();
  }

  /**
   * The model a chat turn should ask for. An app's explicit choice wins; when
   * it sends none, the Assistant model override in Settings comes first, then
   * the provider's configured default. Either is mapped to the provider's own
   * spelling so a saved `vendor/model` (or a dash/dot difference) still works.
   */
  async function resolveChatModel(provider, requested) {
    let wanted = String(requested || '').trim();
    if (!wanted) {
      const assistant = getSetting('assistant', {});
      wanted = String(assistant?.model || '').trim() || String(provider.default_model || '').trim();
    }
    if (!wanted) return '';
    const available = await providerModels(provider);
    return canonicalModelId(wanted, available.map((m) => m.id)) || wanted;
  }

  /** Build a provider record from a form payload without saving it. */
  function providerFromInput(input) {
    const clean = normalizeInput(input);
    const existing = input.id ? getProvider(input.id) : null;
    return {
      id: existing?.id || 'preview',
      ...clean,
      api_key: clean.api_key === undefined ? existing?.api_key || '' : clean.api_key || '',
      created_at: existing?.created_at || Date.now(),
      updated_at: Date.now(),
    };
  }

  /**
   * Which provider serves a capability: an explicit route first, then the first
   * enabled provider that advertises it. There is no implicit provider: AI only
   * runs after the user saves one in Settings.
   */
  function resolve(capability) {
    const routes = getSetting('routes', {});
    const routed = routes[capability] ? getProvider(routes[capability]) : null;
    if (routed && routed.enabled && routed.capabilities.includes(capability)) {
      const adapter = adapterFor(routed);
      if (typeof adapter[capability] === 'function') return { provider: routed, adapter };
    }
    for (const provider of listProviders()) {
      if (!provider.enabled) continue;
      if (!provider.capabilities.includes(capability)) continue;
      const adapter = adapterFor(provider);
      if (typeof adapter[capability] === 'function') return { provider, adapter };
    }
    return null;
  }

  /** The provider list to try, in order. Empty until the user saves one. */
  function candidates(capability) {
    const routes = getSetting('routes', {});
    const ordered = [];
    const routed = routes[capability] ? getProvider(routes[capability]) : null;
    if (routed && routed.enabled && routed.capabilities.includes(capability)) ordered.push(routed);
    for (const provider of listProviders()) {
      if (!provider.enabled || ordered.some((p) => p.id === provider.id)) continue;
      if (provider.capabilities.includes(capability)) ordered.push(provider);
    }
    return ordered;
  }

  function unavailableMessage(capability) {
    return `everything.ai.${capability} has no provider configured. Add one in Settings > AI.`;
  }

  function requireCapability(capability) {
    const found = resolve(capability);
    if (!found) throw unavailableError(unavailableMessage(capability), 501);
    return found;
  }

  /** Try each provider that can serve the capability until one answers. */
  async function withFallback(capability, run) {
    const ordered = candidates(capability);
    if (!ordered.length) throw unavailableError(unavailableMessage(capability), 501);
    let lastError = null;
    for (const provider of ordered) {
      const adapter = adapterFor(provider);
      if (typeof adapter[capability] !== 'function') continue;
      try {
        return await run(adapter, provider);
      } catch (err) {
        lastError = err;
        // A bad request is the caller's problem; do not shop it around providers.
        if (err.status === 400) throw err;
      }
    }
    throw lastError || unavailableError(`No provider could serve everything.ai.${capability}.`, 503);
  }

  function status() {
    const providers = listProviders();
    return {
      configured: providers.some((p) => p.enabled),
      providers: providers.length,
      enabled: providers.filter((p) => p.enabled).length,
      routes: getSetting('routes', {}),
    };
  }

  return {
    listProviders,
    getProvider,
    saveProvider,
    deleteProvider,
    publicProvider,
    providerFromInput,
    adapterFor,
    listModels,
    resolveChatModel,
    getSetting,
    setSetting,
    resolve,
    requireCapability,
    withFallback,
    status,
    presets: PROVIDER_PRESETS,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/** Tool calls keep their OpenAI shape; arguments stay JSON text end to end. */
function normalizeToolCall(call, index) {
  const fn = call?.function || {};
  const name = String(fn.name || call?.name || '').trim();
  if (!name) return null;
  let args = fn.arguments ?? call?.arguments ?? call?.input;
  if (typeof args !== 'string') {
    try { args = JSON.stringify(args ?? {}); } catch { args = '{}'; }
  }
  return {
    id: String(call?.id || `call_${Date.now().toString(36)}_${index}`),
    type: 'function',
    function: { name, arguments: args || '{}' },
  };
}

function normalizeMessages(body) {
  const raw = Array.isArray(body?.messages)
    ? body.messages
    : body?.prompt !== undefined
      ? [{ role: 'user', content: String(body.prompt) }]
      : [{ role: 'user', content: '' }];

  return raw.map((m) => {
    if (typeof m === 'string') return { role: 'user', content: m };
    const role = ['system', 'user', 'assistant', 'tool'].includes(m?.role) ? m.role : 'user';
    const out = { role, content: m?.content ?? '' };
    if (Array.isArray(m?.content)) out.content = m.content;
    if (role === 'assistant' && Array.isArray(m?.tool_calls)) {
      out.tool_calls = m.tool_calls.map(normalizeToolCall).filter(Boolean);
      if (m?.content == null) out.content = '';
    }
    if (role === 'tool') {
      out.tool_call_id = String(m?.tool_call_id || '');
      if (m?.name) out.name = String(m.name);
    }
    if (m?.name && role !== 'tool') out.name = String(m.name);
    return out;
  });
}

/** Accept OpenAI-shaped tool schemas and drop anything malformed. */
function normalizeTools(value) {
  if (!Array.isArray(value)) return undefined;
  const tools = [];
  for (const item of value.slice(0, 64)) {
    const fn = item?.function || item;
    const name = String(fn?.name || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
    const parameters = fn?.parameters && typeof fn.parameters === 'object'
      ? fn.parameters
      : { type: 'object', properties: {} };
    tools.push({
      type: 'function',
      function: {
        name,
        description: String(fn?.description || '').slice(0, 4000),
        parameters,
      },
    });
  }
  return tools.length ? tools : undefined;
}

function requireAdmin(user) {
  if (!user) {
    const err = new Error('Sign in to continue.');
    err.status = 401;
    err.code = 'auth_required';
    throw err;
  }
  if (user.role !== 'admin') {
    const err = new Error('Only an administrator can change AI settings.');
    err.status = 403;
    err.code = 'admin_required';
    throw err;
  }
  return user;
}

const DEFAULT_ASSISTANT_APPS = ['documents', 'photo-studio', 'video-studio', 'whiteboard'];
// Keep in sync with ASSISTANT_NATIVE_APPS in platform/sdk/everything.js.
const NATIVE_ASSISTANT_APPS = ['3d', 'parametric', 'building-design', 'spreadsheet', 'presentation'];

function defaultAssistantConfig() {
  return {
    enabled: true,
    apps: [...DEFAULT_ASSISTANT_APPS],
    model: '',
    confirm_destructive: true,
  };
}

function cleanAssistantConfig(input, appNames) {
  const base = defaultAssistantConfig();
  const value = input && typeof input === 'object' ? input : {};
  const apps = Array.isArray(value.apps)
    ? value.apps.map(String).filter((name) => appNames.has(name) && !NATIVE_ASSISTANT_APPS.includes(name))
    : base.apps;
  return {
    enabled: value.enabled === undefined ? base.enabled : !!value.enabled,
    apps: [...new Set(apps)],
    model: String(value.model || '').trim().slice(0, 200),
    confirm_destructive: value.confirm_destructive === undefined ? true : !!value.confirm_destructive,
  };
}

export async function handleAi(ctx, req, res, url, body, user, sendJson) {
  const p = url.pathname;
  if (!p.startsWith('/api/ai/')) return false;
  const ai = ctx.ai;

  try {
    /* ---- settings ---- */
    if (p === '/api/ai/status') {
      return sendJson(res, 200, ai.status());
    }
    if (p === '/api/ai/providers' || p === '/api/ai/providers/save') {
      requireAdmin(user);
      if (req.method === 'GET') {
        return sendJson(res, 200, ai.listProviders().map(ai.publicProvider));
      }
      const saved = ai.saveProvider(body || {});
      return sendJson(res, 200, ai.publicProvider(saved));
    }
    if (p === '/api/ai/providers/delete') {
      requireAdmin(user);
      return sendJson(res, 200, ai.deleteProvider(body?.id));
    }
    if (p === '/api/ai/providers/test') {
      requireAdmin(user);
      const provider = ai.providerFromInput(body || {});
      const models = await createAdapter(provider).listModels();
      return sendJson(res, 200, { ok: true, provider: ai.publicProvider(provider), models });
    }
    if (p === '/api/ai/presets') {
      return sendJson(res, 200, ai.presets);
    }
    if (p === '/api/ai/routes') {
      requireAdmin(user);
      if (req.method === 'GET') return sendJson(res, 200, ai.getSetting('routes', {}));
      const routes = {};
      for (const [capability, providerId] of Object.entries(body?.routes || {})) {
        if (!CAPABILITIES.includes(capability)) continue;
        const provider = providerId ? ai.getProvider(providerId) : null;
        if (provider && provider.capabilities.includes(capability)) routes[capability] = provider.id;
      }
      return sendJson(res, 200, ai.setSetting('routes', routes));
    }
    if (p === '/api/ai/assistant') {
      if (req.method === 'GET') {
        const config = cleanAssistantConfig(ai.getSetting('assistant', defaultAssistantConfig()), ctx.appNames);
        return sendJson(res, 200, {
          ...config,
          configured: ai.status().configured,
          app_enabled: config.apps.includes(String(url.searchParams.get('app') || '')),
          native_apps: [...NATIVE_ASSISTANT_APPS],
        });
      }
      requireAdmin(user);
      const saved = ai.setSetting('assistant', cleanAssistantConfig(body, ctx.appNames));
      return sendJson(res, 200, { ...saved, configured: ai.status().configured, native_apps: [...NATIVE_ASSISTANT_APPS] });
    }

    /* ---- models ---- */
    if (p === '/api/ai/models') {
      const requestedCapability = String(url.searchParams.get('capability') || '').trim();
      const capability = CAPABILITIES.includes(requestedCapability) ? requestedCapability : undefined;
      return sendJson(res, 200, await ai.listModels({ capability }));
    }

    /* ---- chat ---- */
    if (p === '/api/ai/chat') {
      const messages = normalizeMessages(body || {});
      const tools = normalizeTools(body?.tools);
      const toolChoice = body?.tool_choice;
      const stream = !!body?.stream;
      const request = {
        ...body,
        messages,
        tools,
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        stream: false,
      };

      if (!stream) {
        const result = await ai.withFallback('chat', async (adapter, provider) =>
          adapter.chat({ ...request, model: await ai.resolveChatModel(provider, body?.model) })
        );
        return sendJson(res, 200, { ok: true, ...result });
      }

      // Streaming: one provider owns the response so two upstreams can never
      // interleave their text. Headers stay unwritten until the first chunk.
      let started = false;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      try {
        const { provider, adapter } = ai.requireCapability('chat');
        const result = await adapter.chat(
          { ...request, stream: true, model: await ai.resolveChatModel(provider, body?.model) },
          (text) => {
            started = true;
            res.write(JSON.stringify({ type: 'text', text }) + '\n');
          }
        );
        for (const call of result.message?.tool_calls || []) {
          let input = {};
          try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
          res.write(JSON.stringify({
            type: 'tool_use',
            id: call.id,
            name: call.function?.name,
            input,
          }) + '\n');
        }
        if (result.usage && Object.keys(result.usage).length) {
          res.write(JSON.stringify({ type: 'usage', usage: result.usage }) + '\n');
        }
        res.write(JSON.stringify({ type: 'done', message: result.message, finish_reason: result.finish_reason }) + '\n');
        res.end();
        return true;
      } catch (err) {
        if (!started) {
          // Nothing was sent yet, so a real status code still helps the caller.
          res.statusCode = err.status || 503;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ code: err.code || 'local_ai_unavailable', message: err.message }));
          return true;
        }
        res.write(JSON.stringify({ type: 'error', code: err.code || 'local_ai_unavailable', message: err.message }) + '\n');
        res.end();
        return true;
      }
    }

    /* ---- single-shot capabilities ---- */
    if (p === '/api/ai/txt2img') {
      const result = await ai.withFallback('txt2img', (adapter, provider) =>
        adapter.txt2img({ ...body, model: body?.model || provider.default_model })
      );
      return sendJson(res, 200, result);
    }
    if (p === '/api/ai/txt2speech') {
      const result = await ai.withFallback('txt2speech', (adapter, provider) =>
        adapter.txt2speech({ ...body, model: body?.model || provider.default_model })
      );
      return sendJson(res, 200, result);
    }
    if (p === '/api/ai/speech2txt') {
      const result = await ai.withFallback('speech2txt', (adapter, provider) =>
        adapter.speech2txt({ ...body, model: body?.model || provider.default_model })
      );
      return sendJson(res, 200, result);
    }
    if (p === '/api/ai/img2txt') {
      const result = await ai.withFallback('img2txt', (adapter, provider) =>
        adapter.img2txt({ ...body, model: body?.model || provider.default_model })
      );
      return sendJson(res, 200, result);
    }
    if (p === '/api/ai/txt2vid') {
      throw unavailableError('Text-to-video has no adapter. Configure a compatible provider in Settings > AI.', 501);
    }
  } catch (err) {
    return sendJson(res, err.status || 503, {
      code: err.code || 'local_ai_unavailable',
      message: err.message || 'Local AI is not available.',
    });
  }
  return false;
}
