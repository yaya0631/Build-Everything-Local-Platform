/**
 * Local AI service adapter (Section 5.7 of Brief).
 * Never calls external cloud services. Connects only to a configured local
 * runtime (default: Ollama / OpenAI-compatible local endpoint on 127.0.0.1:11434).
 * Image, video, speech, and OCR methods return a clear `local_ai_unavailable`
 * error unless a local adapter is registered, so apps degrade gracefully.
 */

function isLoopbackUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return (
      u.hostname === '127.0.0.1' ||
      u.hostname === 'localhost' ||
      u.hostname === '::1' ||
      u.hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

function createOllamaChatAdapter(getBaseUrl) {
  return {
    async listModels() {
      const base = getBaseUrl();
      if (!base || !isLoopbackUrl(base)) return [];
      try {
        const res = await fetch(`${base.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.models || []).map((m) => ({
          id: m.name || m.model,
          name: m.name || m.model,
          provider: 'local',
        }));
      } catch {
        return [];
      }
    },

    async chat({ messages, model, stream, temperature, max_tokens, tools }, res) {
      const base = getBaseUrl();
      if (!base || !isLoopbackUrl(base)) {
        const err = new Error('Local AI endpoint is not configured or not a local address.');
        err.code = 'local_ai_unavailable';
        err.status = 503;
        throw err;
      }

      let upstream;
      try {
        upstream = await fetch(`${base.replace(/\/$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: model || process.env.LOCAL_AI_MODEL || 'llama3.2',
            messages: Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages || '') }],
            stream: !!stream,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(max_tokens !== undefined ? { max_tokens } : {}),
            ...(tools !== undefined ? { tools } : {}),
          }),
          signal: AbortSignal.timeout(30000),
        });
      } catch (cause) {
        const err = new Error('Local AI runtime is not reachable. Start Ollama or configure LOCAL_AI_URL.');
        err.code = 'local_ai_unavailable';
        err.status = 503;
        err.cause = cause;
        throw err;
      }

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        const err = new Error(`Local AI runtime returned HTTP ${upstream.status}: ${text.slice(0, 200)}`);
        err.code = 'local_ai_unavailable';
        err.status = 503;
        throw err;
      }

      if (!stream) {
        const data = await upstream.json();
        const choice = data?.choices?.[0] || {};
        const message = choice.message || data?.message || { role: 'assistant', content: data?.response || '' };
        return {
          ok: true,
          message,
          finish_reason: choice.finish_reason || 'stop',
          usage: data?.usage || {},
        };
      }

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let fullText = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed?.choices?.[0]?.delta?.content ?? parsed?.message?.content ?? parsed?.text ?? '';
            if (delta) {
              fullText += delta;
              res.write(JSON.stringify({ type: 'text', text: delta }) + '\n');
            }
          } catch {
            /* ignore malformed line */
          }
        }
      }
      res.write(JSON.stringify({
        type: 'done',
        message: { role: 'assistant', content: fullText },
        finish_reason: 'stop',
      }) + '\n');
      res.end();
      return null;
    },
  };
}

export function createAiService(ctx) {
  const getBaseUrl = () => ctx.localAiUrl ?? process.env.LOCAL_AI_URL ?? 'http://127.0.0.1:11434';
  const adapters = {
    chat: createOllamaChatAdapter(getBaseUrl),
    txt2img: null,
    txt2vid: null,
    speech2txt: null,
    txt2speech: null,
    img2txt: null,
  };

  function setAdapter(kind, impl) {
    adapters[kind] = impl;
  }

  function unavailable(capability) {
    const err = new Error(
      `puter.ai.${capability} is not available locally: no local ${capability} adapter is configured.`
    );
    err.code = 'local_ai_unavailable';
    err.status = 501;
    return err;
  }

  return { adapters, setAdapter, unavailable };
}

export async function handleAi(ctx, req, res, url, body, user, sendJson) {
  const p = url.pathname;
  if (!p.startsWith('/api/ai/')) return false;
  const ai = ctx.ai;

  try {
    if (p === '/api/ai/models') {
      const models = await ai.adapters.chat.listModels();
      return sendJson(res, 200, models);
    }
    if (p === '/api/ai/chat') {
      const out = await ai.adapters.chat.chat(body || {}, res);
      if (out !== null) return sendJson(res, 200, out);
      return true;
    }
    for (const cap of ['txt2img', 'txt2vid', 'speech2txt', 'txt2speech', 'img2txt']) {
      if (p === `/api/ai/${cap}`) {
        const adapter = ai.adapters[cap];
        if (!adapter || typeof adapter.run !== 'function') {
          throw ai.unavailable(cap);
        }
        const result = await adapter.run(body || {});
        return sendJson(res, 200, result);
      }
    }
  } catch (err) {
    return sendJson(res, err.status || 503, {
      code: err.code || 'local_ai_unavailable',
      message: err.message || 'Local AI is not available.',
    });
  }
  return false;
}
