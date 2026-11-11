# Everything Local

Everything — the app suite, running entirely on one machine. Fifty apps are
served from `apps/`; `apps/assets` is kept in its upstream layout but is not a
served app. A small Node server replaces the hosted backend: local accounts,
files, key-value storage, workers, mail, hosting, peer signalling and
settings-driven AI. No page loads code from the internet at runtime, and AI is
contacted only after you configure a provider.

## Requirements

- Node.js 22.13 or newer
- npm 10 or newer
- Windows, macOS or Linux

## Run it

```sh
npm install
npm start
```

`npm start` builds any app that has no `dist/`, then serves the suite. Open
<http://127.0.0.1:8443/> for the app list and the settings link, or go straight
to an app:

```text
http://notes.localhost:8443/
http://spreadsheet.localhost:8443/
http://teamchat.localhost:8443/
```

`npm run dev` is the same local server and also builds missing apps.
`npm run build` rebuilds every app and exits non-zero if one fails.
`npm test` runs the platform conformance suite; each app keeps its own tests.

The server binds loopback only. Set `PORT` to use another port; app origins
follow it (`<app>.localhost:<port>`).

## AI settings

AI is optional. Open <http://127.0.0.1:8443/settings> to add a provider, paste
its key, test the connection, choose a default model and route capabilities.
There are no AI environment variables and no config files: every provider
record, key and route is created on that page and stored locally.

Twenty-seven presets are included, among them OpenRouter, Google Gemini,
OpenCode Zen, OpenAI, Anthropic, Groq, Mistral, DeepSeek, Together, xAI,
Fireworks, Cerebras, SambaNova, Hyperbolic, Novita, Nebius, Moonshot, Z.AI,
Qwen, SiliconFlow, Perplexity, Cohere, Ollama, LM Studio, llama.cpp and vLLM.
Any OpenAI-compatible endpoint works through **Custom OpenAI-compatible**.

Three wire protocols cover the field:

| Protocol | Used by | Endpoints appended to the base URL |
| --- | --- | --- |
| OpenAI-compatible | OpenRouter, Gemini, OpenCode Zen, OpenAI, and most hosted or local servers | `/chat/completions`, `/images/generations`, `/audio/speech`, `/audio/transcriptions` |
| Anthropic Messages | Anthropic and compatible gateways | `/v1/messages` |
| Ollama native | Ollama | `/api/chat` |

Capabilities are selected per provider: chat, image generation, text to speech,
speech to text and image understanding. Routing can pin a capability to one
provider; an unassigned capability uses the first enabled provider that supports
it. Provider keys never leave the server and are never returned to a browser or
an app.

Until a provider is saved, apps run normally and AI features report that they
are unavailable. Image, video, speech and OCR calls fail cleanly rather than
crashing an app.

## Data and backup

All state lives in `platform/data/`:

- `everything.sqlite` — accounts, sessions, KV, file metadata, mail metadata,
  workers, shares, hosted sites and AI provider records
- `files/` — users' files, one directory per account
- `mail/` — raw messages for the local mailboxes

Stop the server and copy `platform/data/` to back everything up. Delete that
folder to start from a clean install. It is git-ignored.

The default account is `local`. Add `?user=alice` (or any name) to a URL to
open a separate session in that tab; that is enough to try multiplayer apps
such as Teamchat, Chess or Whiteboard with two windows.

## Layout

- `apps/` — the apps in their original upstream layout
- `platform/server/` — one small file per service
- `platform/sdk/everything.js` — the `window.everything` client, served at `/sdk/everything.js`
- `platform/web/settings.html` — the AI settings page
- `platform/data/` — runtime state, created on first run (git-ignored)

`apps/assets` is skipped by the build and the app list.

## Security

- The HTTP server binds `127.0.0.1` only.
- Non-local `Host` and `Origin` headers are rejected, including on WebSocket
  upgrades, so a DNS-rebinding page cannot reach the API.
- Each app is isolated on its own `<app>.localhost` origin. Hosted sites cannot
  sign in or reach another app's data.
- AI settings changes are accepted only from the platform origin
  (`127.0.0.1` or `localhost`, with no app subdomain); app origins are refused.
- A saved provider key is write-only from the browser's point of view: the API
  reports whether a key exists, never its value.

## License

MIT. See [LICENSE](LICENSE).
