/**
 * AI provider adapters.
 *
 * Every provider is described by a small record the user owns (kind, base URL,
 * key, models). Nothing here hardcodes a vendor endpoint that gets called on
 * its own: a provider only runs once the user has saved it in the AI settings
 * page. Three wire protocols cover the field:
 *
 *   openai     - the /v1/chat/completions family (OpenAI, OpenRouter, Groq,
 *                Mistral, DeepSeek, Together, xAI, Google's compat endpoint,
 *                LM Studio, llama.cpp, vLLM, and anything else OpenAI-shaped)
 *   anthropic  - /v1/messages
 *   ollama     - the native /api/chat NDJSON protocol
 *
 * Adapters normalize all three into the shapes the apps already expect.
 */

/**
 * Presets shown in the settings page. A preset fills the form; nothing is
 * called until the user saves it and enters the matching API key.
 */
export const PROVIDER_PRESETS = [
  { id: 'ollama', label: 'Ollama (local)', kind: 'ollama', base_url: 'http://127.0.0.1:11434', capabilities: ['chat'] },
  { id: 'lmstudio', label: 'LM Studio (local)', kind: 'openai', base_url: 'http://127.0.0.1:1234/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'llamacpp', label: 'llama.cpp (local)', kind: 'openai', base_url: 'http://127.0.0.1:8080/v1', capabilities: ['chat'] },
  { id: 'vllm', label: 'vLLM (local)', kind: 'openai', base_url: 'http://127.0.0.1:8000/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'opencode', label: 'OpenCode Zen', kind: 'openai', base_url: 'https://opencode.ai/inference/openai/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'openai', label: 'OpenAI', kind: 'openai', base_url: 'https://api.openai.com/v1', capabilities: ['chat', 'txt2img', 'txt2speech', 'speech2txt', 'img2txt'] },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', base_url: 'https://openrouter.ai/api/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', base_url: 'https://api.anthropic.com', capabilities: ['chat', 'img2txt'] },
  { id: 'google', label: 'Google Gemini', kind: 'openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', capabilities: ['chat', 'img2txt'] },
  { id: 'groq', label: 'Groq', kind: 'openai', base_url: 'https://api.groq.com/openai/v1', capabilities: ['chat'] },
  { id: 'mistral', label: 'Mistral', kind: 'openai', base_url: 'https://api.mistral.ai/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai', base_url: 'https://api.deepseek.com/v1', capabilities: ['chat'] },
  { id: 'together', label: 'Together', kind: 'openai', base_url: 'https://api.together.xyz/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'xai', label: 'xAI', kind: 'openai', base_url: 'https://api.x.ai/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'fireworks', label: 'Fireworks', kind: 'openai', base_url: 'https://api.fireworks.ai/inference/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'cerebras', label: 'Cerebras', kind: 'openai', base_url: 'https://api.cerebras.ai/v1', capabilities: ['chat'] },
  { id: 'sambanova', label: 'SambaNova', kind: 'openai', base_url: 'https://api.sambanova.ai/v1', capabilities: ['chat'] },
  { id: 'hyperbolic', label: 'Hyperbolic', kind: 'openai', base_url: 'https://api.hyperbolic.xyz/v1', capabilities: ['chat', 'txt2img', 'img2txt'] },
  { id: 'novita', label: 'Novita AI', kind: 'openai', base_url: 'https://api.novita.ai/v3/openai', capabilities: ['chat', 'txt2img', 'img2txt'] },
  { id: 'nebius', label: 'Nebius', kind: 'openai', base_url: 'https://api.studio.nebius.com/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'moonshot', label: 'Moonshot (Kimi)', kind: 'openai', base_url: 'https://api.moonshot.ai/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'zai', label: 'Z.AI (GLM)', kind: 'openai', base_url: 'https://api.z.ai/api/paas/v4', capabilities: ['chat'] },
  { id: 'qwen', label: 'Qwen (DashScope)', kind: 'openai', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', capabilities: ['chat', 'img2txt'] },
  { id: 'siliconflow', label: 'SiliconFlow', kind: 'openai', base_url: 'https://api.siliconflow.com/v1', capabilities: ['chat', 'txt2img', 'img2txt'] },
  { id: 'perplexity', label: 'Perplexity', kind: 'openai', base_url: 'https://api.perplexity.ai', capabilities: ['chat'] },
  { id: 'cohere', label: 'Cohere', kind: 'openai', base_url: 'https://api.cohere.ai/compatibility/v1', capabilities: ['chat'] },
  { id: 'custom', label: 'Custom OpenAI-compatible', kind: 'openai', base_url: '', capabilities: ['chat'] },
];

export const PROVIDER_KINDS = ['openai', 'anthropic', 'ollama'];

/** Capabilities an adapter may implement. Anything absent degrades cleanly. */
export const CAPABILITIES = ['chat', 'txt2img', 'txt2speech', 'speech2txt', 'img2txt', 'txt2vid'];

export function unavailableError(message, status = 503) {
  const err = new Error(message);
  err.code = 'local_ai_unavailable';
  err.status = status;
  return err;
}

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function mimeOf(blob) {
  return (blob && blob.type) || 'application/octet-stream';
}

function toDataUrl(buffer, mime) {
  return `data:${mime || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
}

/** Split a data: URL into bytes and mime type. Returns null for anything else. */
export function parseDataUrl(value) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(value || ''));
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime, data };
}

/** Turn whatever the app handed us (data URL, raw base64, bytes) into bytes. */
function asBytes(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseDataUrl(value);
    if (parsed) return parsed.data;
    try {
      return Buffer.from(value, 'base64');
    } catch {
      return Buffer.from(value, 'utf8');
    }
  }
  return null;
}

/**
 * fetch, but a connection failure becomes a `local_ai_unavailable` error with
 * a readable message instead of a bare TypeError from undici.
 */
async function request(url, init, label) {
  try {
    return await fetch(url, init);
  } catch (cause) {
    const reason = cause?.cause?.code || cause?.code || cause?.message || 'network error';
    throw unavailableError(`${label || 'The AI provider'} is not reachable (${reason}).`, 503);
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function assertOk(res, label) {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.message || parsed?.error || detail;
  } catch {
    /* keep the raw text */
  }
  const status = res.status === 401 || res.status === 403 ? 401 : res.status >= 500 ? 502 : 400;
  const err = unavailableError(`${label} returned HTTP ${res.status}: ${detail}`, status);
  err.upstream_status = res.status;
  throw err;
}

/** Assistant text may be a string or an array of content parts. */
function textOf(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? part?.content ?? ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

/** Read an SSE or NDJSON stream line by line and hand each payload to `onPayload`. */
async function pumpLines(upstream, onPayload) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || line.startsWith(':')) continue;
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (!payload || payload === '[DONE]') continue;
      try {
        onPayload(JSON.parse(payload));
      } catch {
        /* a malformed line is not worth failing the whole reply over */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible                                                   */
/* ------------------------------------------------------------------ */

function openAiHeaders(provider) {
  const headers = { 'content-type': 'application/json' };
  if (provider.api_key) headers.authorization = `Bearer ${provider.api_key}`;
  if (provider.kind === 'openai' && /openrouter\.ai/.test(provider.base_url || '')) {
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'Everything Local';
  }
  return headers;
}

/** OpenAI chat content: a plain string, or parts when an image is attached. */
function openAiContent(messages) {
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return { role: 'user', content: String(m ?? '') };
    const role = m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
    if (!Array.isArray(m.content)) return { role, content: String(m.content ?? '') };
    return {
      role,
      content: m.content.map((part) => {
        if (part && part.type === 'image' && part.image) {
          const url = typeof part.image === 'string' ? part.image : part.image.url;
          return { type: 'image_url', image_url: { url } };
        }
        if (part && part.type === 'text') return { type: 'text', text: String(part.text ?? '') };
        return { type: 'text', text: String(part?.text ?? '') };
      }),
    };
  });
}

function createOpenAiAdapter(provider) {
  const base = trimBase(provider.base_url);
  if (!base) throw unavailableError('This provider has no base URL configured.', 400);

  return {
    async listModels() {
      // A few gateways (OpenCode Zen is one) expose the catalogue outside the
      // OpenAI-compatible prefix. Try the sibling path before giving up.
      const urls = [`${base}/models`];
      const sibling = /^(.*)\/openai(\/v\d+)$/.exec(base);
      if (sibling) urls.push(`${sibling[1]}${sibling[2]}/models`);
      let lastError = null;
      for (const modelUrl of urls) {
        const res = await request(modelUrl, { headers: openAiHeaders(provider), signal: AbortSignal.timeout(15000) });
        if (res.status === 404) {
          await res.text().catch(() => '');
          lastError = unavailableError('The provider does not expose a model list.', 404);
          continue;
        }
        await assertOk(res, 'The provider');
        const data = await readJson(res);
        return (data.data || data.models || []).map((m) => ({
          id: m.id || m.name,
          name: m.name || m.id,
          provider: provider.name,
        }));
      }
      if (lastError?.status === 404) return [];
      throw lastError;
    },

    async chat({ messages, model, stream, temperature, max_tokens, tools }, onDelta) {
      const res = await request(`${base}/chat/completions`, {
        method: 'POST',
        headers: openAiHeaders(provider),
        body: JSON.stringify({
          model: model || provider.default_model,
          messages: openAiContent(messages),
          stream: !!stream,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(max_tokens !== undefined ? { max_tokens } : {}),
          ...(tools !== undefined ? { tools } : {}),
        }),
        signal: AbortSignal.timeout(provider.timeout_ms || 120000),
      });
      await assertOk(res, 'The provider');

      if (!stream) {
        const data = await readJson(res);
        const choice = data?.choices?.[0] || {};
        const content = textOf(choice.message?.content);
        return {
          message: { role: 'assistant', content },
          finish_reason: choice.finish_reason || 'stop',
          usage: data?.usage || {},
        };
      }

      let full = '';
      await pumpLines(res, (parsed) => {
        const delta = textOf(parsed?.choices?.[0]?.delta?.content);
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta);
        }
      });
      return { message: { role: 'assistant', content: full }, finish_reason: 'stop', usage: {} };
    },

    async txt2img({ prompt, model, size, input_image }) {
      const body = { model: model || provider.default_model, prompt: String(prompt || ''), n: 1 };
      if (size) body.size = size;
      if (input_image) body.image = input_image;
      const res = await request(`${base}/images/generations`, {
        method: 'POST',
        headers: openAiHeaders(provider),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(provider.timeout_ms || 180000),
      });
      await assertOk(res, 'The image provider');
      const data = await readJson(res);
      const first = data?.data?.[0] || {};
      if (first.b64_json) return { src: toDataUrl(Buffer.from(first.b64_json, 'base64'), 'image/png') };
      if (first.url) return { src: first.url };
      throw unavailableError('The image provider returned no picture.', 502);
    },

    async txt2speech({ text, model, voice }) {
      const res = await request(`${base}/audio/speech`, {
        method: 'POST',
        headers: openAiHeaders(provider),
        body: JSON.stringify({
          model: model || provider.default_model,
          input: String(text || ''),
          voice: voice || 'alloy',
        }),
        signal: AbortSignal.timeout(provider.timeout_ms || 120000),
      });
      await assertOk(res, 'The speech provider');
      const bytes = Buffer.from(await res.arrayBuffer());
      return { src: toDataUrl(bytes, res.headers.get('content-type') || 'audio/mpeg') };
    },

    async speech2txt({ audio, model, language }) {
      const bytes = asBytes(audio);
      if (!bytes) throw unavailableError('No audio was supplied.', 400);
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mimeOf(audio) }), 'audio.wav');
      form.append('model', model || provider.default_model || 'whisper-1');
      if (language && language !== 'auto') form.append('language', String(language));
      const res = await request(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: provider.api_key ? { authorization: `Bearer ${provider.api_key}` } : {},
        body: form,
        signal: AbortSignal.timeout(provider.timeout_ms || 180000),
      });
      await assertOk(res, 'The transcription provider');
      const data = await readJson(res);
      return { text: data.text || '', segments: data.segments || [] };
    },

    async img2txt({ image, model, prompt }) {
      const url = typeof image === 'string' && image.startsWith('data:') ? image : toDataUrl(asBytes(image), mimeOf(image));
      const res = await request(`${base}/chat/completions`, {
        method: 'POST',
        headers: openAiHeaders(provider),
        body: JSON.stringify({
          model: model || provider.default_model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt || 'Transcribe every character of text in this image. Return only the text.' },
                { type: 'image_url', image_url: { url } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(provider.timeout_ms || 120000),
      });
      await assertOk(res, 'The vision provider');
      const data = await readJson(res);
      return { text: textOf(data?.choices?.[0]?.message?.content) };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                           */
/* ------------------------------------------------------------------ */

function anthropicHeaders(provider) {
  return {
    'content-type': 'application/json',
    'x-api-key': provider.api_key || '',
    'anthropic-version': '2023-06-01',
  };
}

function anthropicContent(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      out.push({ role: 'user', content: [{ type: 'text', text: String(m ?? '') }] });
      continue;
    }
    if (m.role === 'system') {
      system.push(String(m.content ?? ''));
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (!Array.isArray(m.content)) {
      out.push({ role, content: [{ type: 'text', text: String(m.content ?? '') }] });
      continue;
    }
    out.push({
      role,
      content: m.content.map((part) => {
        if (part && part.type === 'image' && part.image) {
          const url = typeof part.image === 'string' ? part.image : part.image.url;
          const parsed = parseDataUrl(url);
          if (parsed) {
            return { type: 'image', source: { type: 'base64', media_type: parsed.mime, data: parsed.data.toString('base64') } };
          }
        }
        return { type: 'text', text: String(part?.text ?? '') };
      }),
    });
  }
  return { system: system.join('\n\n'), messages: out };
}

function createAnthropicAdapter(provider) {
  const base = trimBase(provider.base_url) || 'https://api.anthropic.com';

  async function messages(payload) {
    const res = await request(`${base}/v1/messages`, {
      method: 'POST',
      headers: anthropicHeaders(provider),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(provider.timeout_ms || 120000),
    });
    await assertOk(res, 'The provider');
    return res;
  }

  return {
    async listModels() {
      const res = await request(`${base}/v1/models`, { headers: anthropicHeaders(provider), signal: AbortSignal.timeout(15000) });
      await assertOk(res, 'The provider');
      const data = await readJson(res);
      return (data.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id, provider: provider.name }));
    },

    async chat({ messages: msgs, model, stream, temperature, max_tokens, tools }, onDelta) {
      const { system, messages: converted } = anthropicContent(msgs);
      const res = await messages({
        model: model || provider.default_model,
        max_tokens: max_tokens || 4096,
        ...(system ? { system } : {}),
        messages: converted,
        stream: !!stream,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(tools !== undefined ? { tools } : {}),
      });

      if (!stream) {
        const data = await readJson(res);
        const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        return {
          message: { role: 'assistant', content: text },
          finish_reason: data.stop_reason || 'stop',
          usage: data.usage || {},
        };
      }

      let full = '';
      await pumpLines(res, (parsed) => {
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          full += parsed.delta.text;
          if (onDelta) onDelta(parsed.delta.text);
        }
      });
      return { message: { role: 'assistant', content: full }, finish_reason: 'stop', usage: {} };
    },

    async img2txt({ image, model, prompt }) {
      const url = typeof image === 'string' ? image : toDataUrl(asBytes(image), mimeOf(image));
      const parsed = parseDataUrl(url);
      if (!parsed) throw unavailableError('The image could not be read.', 400);
      const res = await messages({
        model: model || provider.default_model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: parsed.mime, data: parsed.data.toString('base64') } },
              { type: 'text', text: prompt || 'Transcribe every character of text in this image. Return only the text.' },
            ],
          },
        ],
      });
      const data = await readJson(res);
      return { text: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ollama (native)                                                     */
/* ------------------------------------------------------------------ */

function createOllamaAdapter(provider) {
  const base = trimBase(provider.base_url) || 'http://127.0.0.1:11434';

  return {
    async listModels() {
      const res = await request(`${base}/api/tags`, { signal: AbortSignal.timeout(15000) });
      await assertOk(res, 'Ollama');
      const data = await readJson(res);
      return (data.models || []).map((m) => ({ id: m.name || m.model, name: m.name || m.model, provider: provider.name }));
    },

    async chat({ messages, model, stream, temperature, max_tokens, tools }, onDelta) {
      const res = await request(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || provider.default_model,
          messages: messages.map((m) => ({ role: m.role || 'user', content: textOf(m.content) })),
          stream: !!stream,
          options: {
            ...(temperature !== undefined ? { temperature } : {}),
            ...(max_tokens !== undefined ? { num_predict: max_tokens } : {}),
          },
          ...(tools !== undefined ? { tools } : {}),
        }),
        signal: AbortSignal.timeout(provider.timeout_ms || 300000),
      });
      await assertOk(res, 'Ollama');

      if (!stream) {
        const data = await readJson(res);
        return {
          message: data.message || { role: 'assistant', content: data.response || '' },
          finish_reason: data.done ? 'stop' : 'length',
          usage: {},
        };
      }

      let full = '';
      await pumpLines(res, (parsed) => {
        const delta = textOf(parsed?.message?.content);
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta);
        }
      });
      return { message: { role: 'assistant', content: full }, finish_reason: 'stop', usage: {} };
    },
  };
}

/** Build the adapter for a provider record. Throws when the kind is unknown. */
export function createAdapter(provider) {
  if (provider.kind === 'anthropic') return createAnthropicAdapter(provider);
  if (provider.kind === 'ollama') return createOllamaAdapter(provider);
  if (provider.kind === 'openai') return createOpenAiAdapter(provider);
  throw unavailableError(`Unknown provider kind "${provider.kind}".`, 400);
}
