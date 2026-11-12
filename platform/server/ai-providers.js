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

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

let callSeq = 0;
function newCallId() {
  return `call_${Date.now().toString(36)}_${(++callSeq).toString(36)}`;
}

/** Normalize any provider's tool calls into the OpenAI shape the apps expect. */
function normalizeToolCalls(calls) {
  const out = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const fn = call?.function || call || {};
    const name = String(fn.name || call?.name || '').trim();
    if (!name) continue;
    const args = fn.arguments ?? call?.arguments ?? call?.input;
    out.push({
      id: String(call?.id || newCallId()),
      type: 'function',
      function: {
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    });
  }
  return out;
}

/** Accumulate OpenAI's streamed tool_call deltas by index. */
function addToolDelta(acc, delta) {
  if (!Array.isArray(delta)) return;
  for (const part of delta) {
    const index = Number.isInteger(part?.index) ? part.index : acc.length;
    if (!acc[index]) {
      acc[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    }
    const slot = acc[index];
    if (part.id) slot.id = String(part.id);
    if (part.type) slot.type = part.type;
    if (part.function?.name) slot.function.name += String(part.function.name);
    if (typeof part.function?.arguments === 'string') slot.function.arguments += part.function.arguments;
    else if (part.function?.arguments && typeof part.function.arguments === 'object') {
      slot.function.arguments += JSON.stringify(part.function.arguments);
    }
  }
}

function finishToolCalls(acc) {
  return acc.filter(Boolean).map((call) => ({
    id: call.id || newCallId(),
    type: 'function',
    function: {
      name: call.function.name,
      arguments: call.function.arguments || '{}',
    },
  })).filter((call) => call.function.name);
}

/** OpenAI tool schemas -> Anthropic tool definitions. */
function anthropicTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.map((item) => {
    const fn = item?.function || item;
    if (!fn?.name) return null;
    return {
      name: String(fn.name),
      description: String(fn.description || ''),
      input_schema: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} },
    };
  }).filter(Boolean);
  return out.length ? out : undefined;
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

/** OpenAI chat content: text, image parts, and the tool turn kept intact. */
function openAiContent(messages) {
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return { role: 'user', content: String(m ?? '') };
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: String(m.tool_call_id || ''),
        content: textOf(m.content),
        ...(m.name ? { name: String(m.name) } : {}),
      };
    }
    const role = m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
    if (!Array.isArray(m.content)) {
      const out = { role, content: String(m.content ?? '') };
      if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.tool_calls = m.tool_calls;
        if (!out.content) out.content = null;
      }
      return out;
    }
    return {
      role,
      content: m.content.map((part) => {
        if (part && part.type === 'image' && part.image) {
          const url = typeof part.image === 'string' ? part.image : part.image.url;
          return { type: 'image_url', image_url: { url } };
        }
        if (part && part.type === 'image' && part.source?.data) {
          return {
            type: 'image_url',
            image_url: { url: `data:${part.source.media_type || 'image/png'};base64,${part.source.data}` },
          };
        }
        if (part && part.type === 'image_url') {
          return { type: 'image_url', image_url: part.image_url };
        }
        if (part && part.type === 'document') {
          return { type: 'text', text: '[A document was attached. Ask the user to paste the relevant text; this provider does not accept PDF input here.]' };
        }
        if (part && (part.type === 'text' || part.text !== undefined)) return { type: 'text', text: String(part.text ?? '') };
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

    async chat({ messages, model, stream, temperature, max_tokens, tools, tool_choice }, onDelta) {
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
          ...(tool_choice !== undefined ? { tool_choice } : {}),
        }),
        signal: AbortSignal.timeout(provider.timeout_ms || 120000),
      });
      await assertOk(res, 'The provider');

      if (!stream) {
        const data = await readJson(res);
        const choice = data?.choices?.[0] || {};
        const content = textOf(choice.message?.content);
        const toolCalls = normalizeToolCalls(choice.message?.tool_calls);
        return {
          message: {
            role: 'assistant',
            content: toolCalls.length && !content ? null : content,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: choice.finish_reason || (toolCalls.length ? 'tool_calls' : 'stop'),
          usage: data?.usage || {},
        };
      }

      let full = '';
      let usage = {};
      let finish = 'stop';
      const toolAcc = [];
      await pumpLines(res, (parsed) => {
        const choice = parsed?.choices?.[0] || {};
        if (choice.finish_reason) finish = choice.finish_reason;
        if (parsed?.usage) usage = parsed.usage;
        const delta = textOf(choice.delta?.content);
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta);
        }
        addToolDelta(toolAcc, choice.delta?.tool_calls);
      });
      const toolCalls = finishToolCalls(toolAcc);
      return {
        message: {
          role: 'assistant',
          content: toolCalls.length && !full ? null : full,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? (finish === 'stop' ? 'tool_calls' : finish) : finish,
        usage,
      };
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

/**
 * Convert the OpenAI-shaped transcript into Anthropic blocks. Tool results
 * become `tool_result` blocks on a user turn, which is exactly what follows an
 * assistant `tool_use` block in the Anthropic protocol.
 */
function anthropicContent(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      out.push({ role: 'user', content: [{ type: 'text', text: String(m ?? '') }] });
      continue;
    }
    if (m.role === 'system') {
      system.push(textOf(m.content));
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(m.tool_call_id || ''),
          content: textOf(m.content) || '(no output)',
          ...(m.is_error ? { is_error: true } : {}),
        }],
      });
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = [];
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== 'object') {
          if (part != null) blocks.push({ type: 'text', text: String(part) });
          continue;
        }
        if (part.type === 'image' && part.source?.data) {
          blocks.push({ type: 'image', source: part.source });
        } else if (part.type === 'image' && part.image) {
          const url = typeof part.image === 'string' ? part.image : part.image.url;
          const parsed = parseDataUrl(url);
          if (parsed) {
            blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mime, data: parsed.data.toString('base64') } });
          }
        } else if (part.type === 'document' && part.source) {
          blocks.push({ type: 'document', source: part.source, ...(part.title ? { title: part.title } : {}) });
        } else if (part.type === 'tool_use' && part.name) {
          blocks.push({
            type: 'tool_use',
            id: String(part.id || newCallId()),
            name: String(part.name),
            input: parseArguments(part.input),
          });
        } else if (part.type === 'tool_result') {
          blocks.push({
            type: 'tool_result',
            tool_use_id: String(part.tool_use_id || ''),
            content: textOf(part.content),
          });
        } else if (part.type === 'text' || part.text !== undefined) {
          blocks.push({ type: 'text', text: String(part.text ?? '') });
        }
      }
    } else if (m.content != null && m.content !== '') {
      blocks.push({ type: 'text', text: String(m.content) });
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const name = call?.function?.name || call?.name;
        if (!name) continue;
        blocks.push({
          type: 'tool_use',
          id: String(call.id || newCallId()),
          name: String(name),
          input: parseArguments(call?.function?.arguments ?? call?.arguments ?? call?.input),
        });
      }
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '' });
    out.push({ role, content: blocks });
  }
  return { system: system.join('\n\n'), messages: out };
}

/** OpenAI `tool_choice` values mapped onto Anthropic's shape. */
function anthropicToolChoice(choice) {
  if (choice == null) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'required' || choice === 'any') return { type: 'any' };
  if (choice === 'none') return { type: 'none' };
  if (choice?.type === 'function' && choice.function?.name) {
    return { type: 'tool', name: String(choice.function.name) };
  }
  if (choice?.type === 'tool' && choice.name) return { type: 'tool', name: String(choice.name) };
  return undefined;
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

    async chat({ messages: msgs, model, stream, temperature, max_tokens, tools, tool_choice }, onDelta) {
      const { system, messages: converted } = anthropicContent(msgs);
      const choice = anthropicToolChoice(tool_choice);
      const res = await messages({
        model: model || provider.default_model,
        max_tokens: max_tokens || 4096,
        ...(system ? { system } : {}),
        messages: converted,
        stream: !!stream,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(tools !== undefined ? { tools: anthropicTools(tools) } : {}),
        ...(choice && choice.type !== 'none' ? { tool_choice: choice } : {}),
      });

      if (!stream) {
        const data = await readJson(res);
        const blocks = Array.isArray(data.content) ? data.content : [];
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
          id: String(b.id || newCallId()),
          type: 'function',
          function: { name: String(b.name || ''), arguments: JSON.stringify(b.input ?? {}) },
        })).filter((call) => call.function.name);
        const usage = {
          prompt_tokens: data.usage?.input_tokens ?? 0,
          completion_tokens: data.usage?.output_tokens ?? 0,
          total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        };
        return {
          message: {
            role: 'assistant',
            content: toolCalls.length && !text ? null : text,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length ? 'tool_calls' : (data.stop_reason || 'stop'),
          usage,
        };
      }

      let full = '';
      let finish = 'stop';
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      const blocks = [];
      await pumpLines(res, (parsed) => {
        if (parsed.type === 'message_start') {
          const u = parsed.message?.usage || {};
          usage.prompt_tokens = u.input_tokens ?? usage.prompt_tokens;
          usage.completion_tokens = u.output_tokens ?? usage.completion_tokens;
        } else if (parsed.type === 'content_block_start') {
          const block = parsed.content_block || {};
          const slot = {
            type: block.type,
            id: block.id,
            name: block.name,
            input: block.input,
            json: '',
          };
          blocks[parsed.index] = slot;
          if (block.type === 'text' && block.text) {
            full += block.text;
            if (onDelta) onDelta(block.text);
          }
        } else if (parsed.type === 'content_block_delta') {
          const slot = blocks[parsed.index];
          if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
            full += parsed.delta.text;
            if (onDelta) onDelta(parsed.delta.text);
          } else if (parsed.delta?.type === 'input_json_delta' && slot) {
            slot.json += parsed.delta.partial_json || '';
          }
        } else if (parsed.type === 'message_delta') {
          if (parsed.delta?.stop_reason) finish = parsed.delta.stop_reason;
          if (parsed.usage) usage.completion_tokens = parsed.usage.output_tokens ?? usage.completion_tokens;
        }
      });
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      const toolCalls = blocks.filter((b) => b?.type === 'tool_use' && b.name).map((b) => ({
        id: String(b.id || newCallId()),
        type: 'function',
        function: {
          name: String(b.name),
          arguments: b.json ? b.json : JSON.stringify(b.input ?? {}),
        },
      }));
      return {
        message: {
          role: 'assistant',
          content: toolCalls.length && !full ? null : full,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : finish,
        usage,
      };
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

/**
 * Convert the OpenAI-shaped transcript into Ollama's native message shape.
 * Ollama takes tool arguments as an object and expects prior tool results as
 * ordinary `tool` messages.
 */
function ollamaMessages(messages) {
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return { role: 'user', content: String(m ?? '') };
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: textOf(m.content),
        ...(m.name ? { tool_name: String(m.name) } : {}),
      };
    }
    const role = m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
    const out = { role, content: textOf(m.content) };
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = normalizeToolCalls(m.tool_calls).map((call) => ({
        function: { name: call.function.name, arguments: parseArguments(call.function.arguments) },
      }));
    }
    if (Array.isArray(m.content)) {
      const images = [];
      for (const part of m.content) {
        if (!part || part.type !== 'image') continue;
        if (part.source?.data) images.push(String(part.source.data));
        else if (part.image) {
          const url = typeof part.image === 'string' ? part.image : part.image.url;
          const parsed = parseDataUrl(url);
          if (parsed) images.push(parsed.data.toString('base64'));
        }
      }
      if (images.length) out.images = images;
    }
    return out;
  });
}

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
          messages: ollamaMessages(messages),
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
        const message = data.message || { role: 'assistant', content: data.response || '' };
        const text = textOf(message.content);
        const toolCalls = normalizeToolCalls(message.tool_calls);
        const promptTokens = data.prompt_eval_count ?? 0;
        const completionTokens = data.eval_count ?? 0;
        return {
          message: {
            role: 'assistant',
            content: toolCalls.length && !text ? null : text,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length ? 'tool_calls' : data.done_reason === 'length' ? 'length' : 'stop',
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
      }

      let full = '';
      let finish = 'stop';
      const toolCalls = [];
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      await pumpLines(res, (parsed) => {
        const delta = textOf(parsed?.message?.content);
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta);
        }
        if (Array.isArray(parsed?.message?.tool_calls)) {
          toolCalls.push(...normalizeToolCalls(parsed.message.tool_calls));
        }
        if (parsed?.prompt_eval_count != null) usage.prompt_tokens = parsed.prompt_eval_count;
        if (parsed?.eval_count != null) usage.completion_tokens = parsed.eval_count;
        if (parsed?.done && parsed?.done_reason && parsed.done_reason !== 'stop') finish = parsed.done_reason;
      });
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      return {
        message: {
          role: 'assistant',
          content: toolCalls.length && !full ? null : full,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : finish,
        usage,
      };
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
