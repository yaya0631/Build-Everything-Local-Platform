# Everything Local

Everything — the app suite, running entirely on one machine for a household.
Fifty apps are served from `apps/`; `apps/assets` is kept in its upstream layout
but is not a served app. A small Node server replaces the hosted backend:
accounts, invites, files, key-value storage, workers, mail, hosting, peer
signalling, settings-driven AI and a shared assistant with real tool calls. No
page loads code from the internet at runtime, and AI is contacted only after an
administrator configures a provider.

## Requirements

- Node.js 22.13 or newer
- npm 10 or newer
- Windows, macOS or Linux

## Run it

```sh
npm install
npm start
```

`npm start` builds any app that has no `dist/`, then serves the suite on the
local network. Open the address it prints on another device on the same network,
for example `http://192.168.1.20:8443/` or `http://home-server.local:8443/`.

The first visit shows **Create the administrator**. That account owns Settings,
can add people, and can reset forgotten passwords. Everyone else joins with a
one-time invite link or an account the administrator creates.

```sh
npm run start:local      # this machine only (127.0.0.1)
PORT=9000 npm start      # another port
EVERYTHING_HOST=127.0.0.1 npm start   # same as start:local
npm run dev              # same server, builds missing apps
npm run build            # rebuild every app; exits non-zero on failure
npm test                 # platform conformance suite
```

Each app also answers on its own origin once signed in:

```text
http://notes.localhost:8443/
http://spreadsheet.localhost:8443/
http://teamchat.localhost:8443/
```

Use the LAN address or hostname instead of `127.0.0.1` from a phone or another
computer. The server prints every usable URL at startup; **Settings → Server
access** shows the same list, the bind address and the port.

### Family outside the house

Install [Tailscale](https://tailscale.com/) on this machine and on their
devices, then open this machine's Tailscale name (for example
`http://attic-pc.tail1234.ts.net:8443/`) or its `100.x.y.z` address. Tailscale
encrypts the connection between devices. Keep port 8443 closed on your router:
there is no reason to forward it to the public internet.

The default bind is `0.0.0.0` so the LAN and Tailscale can reach it. If you only
ever want this machine to connect, use `npm run start:local`.

## Accounts and invites

There is no passwordless or shared default account. Sessions are random,
HttpOnly, SameSite=Lax cookies with a 30-day lifetime, and passwords are stored
as salted scrypt hashes.

In **Settings → People** an administrator can:

- create an account with a password to share directly;
- create a one-time invite link that expires in seven days;
- disable or re-enable an account;
- set a new password for someone, which signs out their existing browsers.

Members can open apps and use their own files, but cannot open Settings, manage
people, see server details, change AI providers or change the assistant list.
When only one administrator is left, that account cannot be disabled.

If every administrator is locked out, stop the server and run:

```sh
node platform/server/index.js --reset-password admin
```

Set `EVERYTHING_NEW_PASSWORD` to choose the password; otherwise a random one is
printed once. Start the server again and sign in.

## Assistant

The shared assistant is a small floating panel inside the apps enabled in
**Settings → Assistant**. It can inspect the current page, click and type, open
other apps, list and edit files, report the signed-in user, and remember durable
preferences. Every app can contribute its own tools:

```js
everything.assistant.registerTool({
  function: {
    name: 'notes_create',
    description: 'Create a note.',
    parameters: { type: 'object', properties: { title: { type: 'string' } } },
  },
  handler: ({ title }) => everything.fs.write(`/${title}.md`, ''),
});
```

Registering the same name replaces the previous tool; the returned function
removes it again. Tools run in the page with the signed-in person's session, so
they inherit that person's permissions. Destructive actions such as writing a
file, or clicking a control labelled Delete or Reset, ask for confirmation first
unless an administrator turns that off.

Apps with a native assistant — 3D, Parametric, Building Design, Spreadsheet and
Presentation — keep their own panel and are not given the shared one. Documents,
Photo Studio, Video Studio and Whiteboard also have specialized AI tools; the
shared assistant sits alongside them by default to handle page, file and
cross-app actions. Administrators can change the list, or the model and
confirmation behavior, in **Settings → Assistant**.

Without an AI provider the assistant reports that it is unavailable and every
app keeps working normally.

## AI settings

AI is optional and administrator-only. Open **Settings → AI providers** to add a
provider, paste its key, test the connection, choose a default model and route
capabilities. There are no AI environment variables and no config files: every
provider record, key and route is created on that page and stored locally.

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
speech to text, image understanding and text to video. Routing can pin a
capability to one provider; an unassigned capability uses the first enabled
provider that supports it. Tool calls work across all three protocols, including
streaming tool calls, which is what the assistant uses. Provider keys never
leave the server and are never returned to a browser or an app.

Until a provider is saved, apps run normally and AI features report that they
are unavailable. Image, video, speech and OCR calls fail cleanly rather than
crashing an app.

## Network settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVERYTHING_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` for this machine only. |
| `PORT` | `8443` | HTTP port. |
| `EVERYTHING_ALLOWED_HOSTS` | empty | Extra comma-separated hostnames to accept, such as a custom domain on a VPN. |
| `EVERYTHING_TRUST_PROXY` | off | Read `X-Forwarded-Host`/`-Proto` from a reverse proxy you control. |
| `EVERYTHING_SECURE_COOKIES` | off | Mark session cookies `Secure`; use when serving through HTTPS. |

The same settings can be passed on the command line: `--host` and `--port`.

## Data and backup

All state lives in `platform/data/`:

- `everything.sqlite` — accounts, password hashes, sessions, invites, KV, file
  metadata, mail metadata, workers, shares, hosted sites, assistant config and
  AI provider records
- `files/` — users' files, one directory per account
- `mail/` — raw messages for the local mailboxes

Stop the server and copy `platform/data/` to back everything up. Delete that
folder to start from a clean install. It is git-ignored.

To try multiplayer apps such as Teamchat, Chess or Whiteboard, sign in as two
different people in two browsers (or one normal and one private window). Invite
the second person from Settings, or create an account with a password.

## Layout

- `apps/` — the apps in their original upstream layout
- `platform/server/` — one small file per service
- `platform/sdk/everything.js` — the `window.everything` client, served at `/sdk/everything.js`
- `platform/sdk/assistant.js` — the shared assistant panel and tool loop
- `platform/web/login.html` — first-run setup, sign-in and invite acceptance
- `platform/web/settings.html` — people, assistant, AI providers, server and account settings
- `platform/data/` — runtime state, created on first run (git-ignored)

`apps/assets` is skipped by the build and the app list.

## Security

- The server defaults to `0.0.0.0` for LAN and Tailscale use. Set
  `EVERYTHING_HOST=127.0.0.1` or use `npm run start:local` for loopback only.
- `Host` headers are accepted only for loopback, private IPv4/IPv6, Tailscale
  `100.64/10`, `.localhost`, `.local`, `.ts.net`, this machine's hostname and
  anything in `EVERYTHING_ALLOWED_HOSTS`. Public names are rejected on HTTP and
  WebSocket requests, so a DNS-rebinding page cannot become this server.
- `Origin` must match the request host; cross-origin calls from app subdomains,
  hosted sites or public pages are refused. There is no wildcard CORS.
- Each app is isolated on its own `<app>.localhost` origin. Hosted sites cannot
  sign in or reach another app's data.
- Account cookies are HttpOnly and SameSite=Lax. Passwords use salted scrypt.
  Sign-in attempts are rate-limited per address and username.
- Settings and all account, server and AI configuration routes are
  administrator-only, checked on the server as well as hidden in the UI.
- A saved provider key is write-only from the browser's point of view: the API
  reports whether a key exists, never its value.
- Plain HTTP on a home LAN is not encrypted against other devices on that LAN.
  Use Tailscale for anyone outside the house. If you put this behind an HTTPS
  reverse proxy, set `EVERYTHING_TRUST_PROXY=1` and
  `EVERYTHING_SECURE_COOKIES=1`. Do not expose port 8443 directly to the
  internet.

## License

MIT. See [LICENSE](LICENSE).
