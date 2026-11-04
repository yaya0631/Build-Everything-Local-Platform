# Everything Local

The 51 apps from the open-source Everything suite, running entirely on one
machine. A small Node server replaces the hosted backend: local accounts,
files, key-value storage, workers, mail, hosting, peer signalling and an
optional local AI adapter. Nothing is loaded from the internet at runtime.

## Requirements

- Node.js 22.13 or newer
- npm 10 or newer
- Windows, macOS or Linux

## Run it

```sh
npm install
npm start
```

The first `npm start` builds any app that has no `dist/`, then serves the suite.
Open <http://127.0.0.1:8443/> for the app list, or go straight to an app:

```text
http://notes.localhost:8443/
http://spreadsheet.localhost:8443/
http://teamchat.localhost:8443/
```

`npm run dev` is the same local server (it builds missing apps too).
`npm run build` rebuilds every app and exits non-zero if one fails.
`npm test` runs the platform conformance suite. That is the fifth script: the
apps keep their own test suites, while this one checks every SDK method.

Set `PORT` to use another port; app origins follow it (`<app>.localhost:<port>`).
The server binds loopback only, and rejects non-local `Host` and `Origin`
headers.

## Data and backup

All state lives in `platform/data/`:

- `everything.sqlite` — accounts, sessions, KV, files metadata, mail, workers,
  shares and hosted sites
- `files/` — the users' files, one directory per account

Stop the server and copy `platform/data/` to back everything up. Delete that
folder to start from a clean install. It is git-ignored.

The default account is `local`. Add `?user=alice` (or any name) to a URL to
open a separate session in that tab; that is enough to try multiplayer apps
such as Teamchat, Chess or Whiteboard with two windows.

## AI

AI is optional and never leaves the machine. If an Ollama-compatible runtime
is listening on `http://127.0.0.1:11434`, chat works through it. Override with
`LOCAL_AI_URL` and `LOCAL_AI_MODEL` (default model `llama3.2`). Image, video,
speech and OCR methods return a clear `local_ai_unavailable` error until such
an adapter exists; the apps show their normal unavailable state.

## Layout

- `apps/` — the apps, each with its original upstream layout
- `platform/server/` — one small file per service
- `platform/sdk/puter.js` — the drop-in `window.puter` client
- `platform/data/` — runtime state, created on first run (git-ignored)

`apps/assets` is kept as upstream shipped it and is skipped by the build.
