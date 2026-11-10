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

export function createAiService(ctx) {
  const { db } = ctx;
  const adapterCache = new Map();

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
    return getProvider(id);
  }

  function deleteProvider(id) {
    db.prepare('DELETE FROM ai_providers WHERE id = ?').run(String(id));
    adapterCache.delete(String(id));
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

function normalizeMessages(body) {
  if (Array.isArray(body.messages)) {
    return body.messages.map((m) =>
      typeof m === 'string' ? { role: 'user', content: m } : { role: m?.role || 'user', content: m?.content ?? '' }
    );
  }
  if (body.prompt !== undefined) return [{ role: 'user', content: String(body.prompt) }];
  return [{ role: 'user', content: '' }];
}

/**
 * Only the platform page (`127.0.0.1`/`localhost`, no app subdomain) may change
 * AI settings. Requests with no Origin header are local tools and are allowed;
 * an app origin cannot rewrite provider keys.
 */
function isSettingsRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function assertSettingsRequest(req) {
  if (isSettingsRequest(req)) return;
  throw unavailableError('AI settings can only be changed from the local settings page.', 403);
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
      if (req.method === 'GET') {
        return sendJson(res, 200, ai.listProviders().map(ai.publicProvider));
      }
      assertSettingsRequest(req);
      const saved = ai.saveProvider(body || {});
      return sendJson(res, 200, ai.publicProvider(saved));
    }
    if (p === '/api/ai/providers/delete') {
      assertSettingsRequest(req);
      return sendJson(res, 200, ai.deleteProvider(body?.id));
    }
    if (p === '/api/ai/providers/test') {
      assertSettingsRequest(req);
      const provider = ai.providerFromInput(body || {});
      const models = await createAdapter(provider).listModels();
      return sendJson(res, 200, { ok: true, provider: ai.publicProvider(provider), models });
    }
    if (p === '/api/ai/presets') {
      return sendJson(res, 200, ai.presets);
    }
    if (p === '/api/ai/routes') {
      assertSettingsRequest(req);
      if (req.method === 'GET') return sendJson(res, 200, ai.getSetting('routes', {}));
      const routes = {};
      for (const [capability, providerId] of Object.entries(body?.routes || {})) {
        if (!CAPABILITIES.includes(capability)) continue;
        const provider = providerId ? ai.getProvider(providerId) : null;
        if (provider && provider.capabilities.includes(capability)) routes[capability] = provider.id;
      }
      return sendJson(res, 200, ai.setSetting('routes', routes));
    }

    /* ---- models ---- */
    if (p === '/api/ai/models') {
      const out = [];
      for (const provider of ai.listProviders()) {
        if (!provider.enabled) continue;
        try {
          const models = await createAdapter(provider).listModels();
          out.push(...models.map((m) => ({ ...m, provider: provider.name, provider_id: provider.id })));
        } catch {
          /* an unreachable provider should not break the model list */
        }
      }
      return sendJson(res, 200, out);
    }

    /* ---- chat ---- */
    if (p === '/api/ai/chat') {
      const messages = normalizeMessages(body || {});
      const stream = !!body?.stream;

      if (!stream) {
        const result = await ai.withFallback('chat', (adapter, provider) =>
          adapter.chat({ ...body, messages, stream: false, model: body?.model || provider.default_model })
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
          { ...body, messages, stream: true, model: body?.model || provider.default_model },
          (text) => {
            started = true;
            res.write(JSON.stringify({ type: 'text', text }) + '\n');
          }
        );
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
