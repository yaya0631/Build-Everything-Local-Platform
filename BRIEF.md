# Brief: make "Everything" run fully on my own PC, with no Puter and no cloud

You are taking over a project that an earlier, weaker AI built in a hurry across several different models. The result works partly, but it is messy: too many files, a confusing tree, leftovers from model switches. Your job is to deliver a **clean, simple, finished** version. You may repair what exists or rebuild from scratch. Section 6 tells you how to decide.

---

## 1. Goal

Take the open-source **Everything** project (about 50 browser apps: spreadsheet, documents, chess, CRM, video studio, and so on) and make it run **entirely on one local machine**:

- Every app currently depends on **Puter** (a cloud OS) for storage, login, database, AI, serverless workers, email and hosting. Replace Puter with a **local platform that I own and that you build from scratch**.
- Remove every other cloud or third-party runtime call (analytics, CDNs, hosted fonts, external APIs).
- The result must be **as simple as the original**: easy to read, easy to run, no clutter.

## 2. Inputs

| What | Where | Role |
|---|---|---|
| Original apps (pristine) | `github.com/HeyPuter/everything` at commit `b5d2584` | **Source of truth for the apps.** MIT at repo root. |
| Original Puter platform | `github.com/HeyPuter/puter` at commit `480fa7b` (v26.07) | **Behaviour reference only.** AGPL-3.0. |
| My earlier AI-built forks | `github.com/yaya0631/everything-apps` and `github.com/yaya0631/everything-platform` | The messy attempt. Audit it; do not trust it. |

Rules about these inputs:

- If you cannot open my two repos (they may be private), **say so immediately and stop to ask me for a zip**. Do not guess their contents.
- Do **not** copy code from the Puter repo into my platform. Read it to learn how an API behaves, then write your own implementation. This keeps my platform free of AGPL obligations. Some apps carry their own `LICENSE` file (for example `notes` is AGPL-3.0); keep each app's license file exactly as it is in the original.
- My fork was branched from an older upstream commit (reported as about 64 commits behind `b5d2584`). Start from `b5d2584`, not from my fork's base.
- Always diff against the pristine originals. They are the definition of "simple" and of "correct".

## 3. Target layout (exactly this, nothing more)

```
everything-local/
├── README.md              # what it is, how to run it, in under 60 lines
├── LICENSE                # same as the original repo root
├── package.json           # npm workspaces + the 3-4 scripts below
├── .gitignore
├── apps/                  # ALL apps, one folder each, same names as the original src/
│   ├── chess/
│   ├── spreadsheet/
│   ├── teamchat/
│   └── ...                # every app keeps its own internal layout from the original
└── platform/              # the local replacement for Puter and every cloud service
    ├── package.json
    ├── server/            # the local server: one small file per service
    │   ├── index.js       # starts everything, serves apps, mounts the API
    │   ├── auth.js
    │   ├── fs.js
    │   ├── kv.js
    │   ├── workers.js
    │   ├── mail.js
    │   ├── hosting.js
    │   └── ai.js
    ├── sdk/               # the client library the apps load instead of js.puter.com
    │   └── ...            # one source folder, builds to ONE static file
    └── data/              # runtime data (database, files). Git-ignored.
```

Hard layout rules:

1. **Two top-level code folders only: `apps/` and `platform/`.** No `tools/`, `scripts/`, `docs/`, `misc/`, `old/`, `backup/`, `tmp/`, `shared/` or `utils/` at the top level.
2. Inside `apps/<name>/` the layout must match the original. Do not restructure apps.
3. Inside `platform/`, one file per service. Split a file only when it passes about 400 lines.
4. No generated or duplicate files in git: no `dist/`, no `node_modules/`, no lockfile copies per folder, no `.bak`, no `*-copy`, no `v2`, no commented-out dead code.
5. A single root `package.json` with npm workspaces. Scripts are exactly: `install` (npm default), `dev`, `build`, `start`. If you need a fifth, justify it.
6. Anything not in the original and not required by the platform gets deleted. When unsure, delete it and see if something breaks.

## 4. What the apps actually use (measured from the originals)

I scanned a snapshot of `everything/src` (50 folders, including one called `assets`, and without `whiteboard`, see section 7). Your platform has to cover **this surface and nothing speculative**. Do not add methods no app calls (for example `fs.copy`, `fs.move`, `fs.upload`, `kv.decr`, `kv.flush`, `ai.listModels` have zero call sites). If you suspect a method is needed, grep for it first. Counts are call sites in app source, excluding tests.

**Namespaces:** `puter.fs` 478, `puter.kv` 314, `puter.auth` 235, `puter.workers` 106, `puter.ui` 96, `puter.ai` 72, `puter.email` 60, `puter.env` 48, `puter.peer` 45, `puter.perms` 14, `puter.events` 14, `puter.hosting` 13, `puter.exit` 11, `puter.net` 4. Also used as plain properties: `puter.authToken` (99), `puter.APIOrigin` (37), `puter.args`, `puter.appID`.

**Methods to implement:**

| Area | Methods used |
|---|---|
| `fs` | `write`, `read`, `delete`, `readdir`, `stat`, `rename`, `mkdir`, `getReadURL`, `revokeReadURL`, `space`, `share`, `unshare`, `listShared`, `getShares` |
| `kv` | `set`, `get`, `del`, `list`, `update`, `add`, `incr` (32 calls), `expire` (8), plus the `MAX` constant |
| `auth` | `signIn`, `signOut`, `isSignedIn`, `getUser`, `getProfilePicture`, `whoami` |
| `workers` | `create`, `exec`, `delete`, `list`, `get` |
| `email` | `send`, `sendTransactional`, `list` |
| `hosting` | `create`, `delete` |
| `perms` | `request`, `check` |
| `ui` | `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`, `alert`, `launchApp`, `contextMenu`, `parentApp`, `onLaunchedWithItems`, `onItemsOpened`, `setWindowTitle`, `showWindow`, `hideWindow`, `requestPermission`, `onWindowClose`, picture-in-picture request/exit |
| `ai` | `chat` (39 calls), `txt2img` (10), `txt2vid` (3), `speech2txt` (3), `txt2speech` (2), `img2txt` (2) |
| `peer` | `serve`, `connect`, `ensureTurnRelays`, `createGuestGrant`: peer-to-peer connections used for **multiplayer in chess, checkers, backgammon** and by `meetings`, `teamchat`, `photo-studio`, `spreadsheet`, `vector-studio`. On a single PC this can be a local WebSocket signalling/relay on the platform server. |
| `events` | `onLocal`, `list` (used in 9 files) |
| `net` | `fetch`, `Socket`, `tls` (rare; implement only if an app breaks without it) |

Apps load Puter in two ways: **185** places use `<script src="https://js.puter.com/v2/">`, and some import `@heyputer/puter.js`. Both must point at my local SDK.

**Serverless workers.** 15 apps ship a worker (`teamchat`, `help-desk`, `meetings`, `survey`, `wiki`, `spreadsheet`, `calendar`, `invoicing`, `legal`, `fleet`, `field-service`, `property-management`, `signatures`, `vector-studio`, `video-studio`). They are plain JS files using a `router.get/post/put/delete/...` API (182 route definitions) and receive `me.puter` (the owner's account) and `user.puter` (the caller's account). Inside workers the apps call only `kv`, `email.send`, `email.sendTransactional` and `auth.getUser`. The apps deploy their own worker with `puter.workers.create` and call it with `puter.workers.exec`. My platform needs a small worker runtime that does the same thing locally.

## 5. Architecture: the recommended design

Unless the audit shows a better option, build it like this.

1. **Drop-in SDK.** Write a from-scratch client library that exposes `window.puter` with the same method names and return shapes as in section 4, talking to my local server. Then the apps need only a mechanical change (the script URL), instead of hundreds of edited call sites. This is what keeps the apps looking like the originals. Fill in missing details by running each app against the SDK, not by reading Puter's source.
2. **One local server** (Node, plain, minimal dependencies) that:
   - serves each built app on its own origin (for example `http://<app>.localhost:<port>`; browsers resolve `*.localhost` to loopback by themselves, and this keeps per-app storage isolated the way Puter does),
   - exposes the API for fs, kv, auth, workers, mail, hosting and ai,
   - stores everything under `platform/data/` (a single SQLite file for kv, accounts and metadata; ordinary files on disk for `fs`),
   - starts with one command.
3. **Auth.** Local accounts, sessions via a token the SDK keeps. `signIn()` should work with no internet. Single-user-by-default is fine as long as the multi-user cases some apps rely on (teamchat, shared files, `perms`) still work.
4. **Workers.** Run the user's worker file in an isolated Node worker thread (or `vm` context) with the `router`, `me.puter` and `user.puter` globals. Route calls come in through `workers.exec`. Keep the worker source format unchanged.
5. **Email.** Write messages to a local mailbox store by default. Optional SMTP relay is configuration, not a requirement.
6. **Hosting.** `hosting.create` publishes a user's folder at a local subdomain.
7. **AI.** Be honest here: inference cannot be built from scratch. Define one small adapter interface in `ai.js` and ship **one** adapter for a local runtime (for example an Ollama-compatible endpoint for `chat`). Image, video and speech methods return a clear "not available locally" error unless an adapter is configured, and the apps must degrade gracefully instead of crashing. Do not call any external AI service.

If you see a cleaner way to meet the same goals, you may propose it, but explain why in five lines or fewer and keep the layout in section 3.

## 6. Decide: fix or rebuild (do this first, report the verdict)

**Phase 0, audit (no changes yet):**

1. Clone my two forks and the two pristine originals.
2. For each app, diff `my-fork/<app>` against `original/src/<app>`. Classify every changed or extra file as *required for local operation*, *unnecessary*, or *harmful*.
3. List what my platform fork contains and map each part to the surface in section 4. For each method, mark: works / partial / missing / fake (returns a stub).
4. Measure the clutter: number of top-level folders, number of files not in the original, duplicated code, dead files.

**Verdict rules:**

- **Apps:** default is **re-derive from the pristine originals** (copy the original app, apply only the minimal mechanical changes: SDK URL, removal of external calls). Repair my forked apps in place only if the diff against the original is already tiny.
- **Platform:** **rebuild from scratch** if any of these is true: fewer than about half the methods in section 4 genuinely work, the code cannot be mapped onto the section 3 tree without moving more than about half its files, or it contains copied Puter backend code. Otherwise keep the parts that work and move/trim them into the tree.

Give me the verdict with the evidence in a short summary (under 40 lines) **before** doing large changes.

## 7. Removing everything external

Find and remove or replace all of these in the app source (the originals contain them):

- All `js.puter.com`, `api.puter.com`, `puter.com`, `*.puter.site`, `developer.puter.com` and `docs.puter.com` references. Replace with the local SDK or delete.
- `<app>.puter.com` demo links in READMEs and `STORE_LISTING.md` files (delete or make local).
- `plausible.io` analytics scripts and their CSP entries (referenced in 15 apps: `backgammon`, `calendar`, `cap-table`, `checkers`, `chess`, `contacts`, `documents`, `expense`, `inventory`, `photo-studio`, `pos`, `presentation`, `solitaire`, `spreadsheet`, `vector-studio`).
- Strict Content-Security-Policy headers that whitelist Puter hosts (chess, backgammon, checkers). Update to the local origins.
- Hosted fonts or CDN scripts. Bundle them locally.
- Marketing links to other websites that act as runtime dependencies (for example the landing page of `cap-table`). Plain outbound links in text are fine to leave, but nothing may be *loaded* from the internet.
- Original deployment files that exist only for the cloud: `amplify.yml`, `customHttp.yml` (root and per app), `dev/puter-localhost.mjs` (the `*.puter.localhost` dev plugin), and the per-app `puter worker deploy` scripts. Replace the dev plugin with nothing, or with a few lines in the platform server.
- **Two known problems in the pristine original at `b5d2584`** (found by a previous audit; re-check them yourself):
  - `src/whiteboard` exists upstream, but it contains about 850 scratch files in `src/whiteboard/tmp/` (about 233 MB) and two broken symlinks, so archive and Windows checkouts silently skip or fail on it. My local zip snapshot is missing it for that reason. Include `whiteboard` in `apps/`, but **without `tmp/` and without the broken symlinks**. That makes 51 app folders in total.
  - `src/assets` ships `index.html`, `package.json` and `vite.config.js` but no `src/` folder, so its build fails upstream. Keep the pristine files and exclude this folder from the build step (do not invent an app for it).

**Verification:** after the work, `grep -rE "puter\.(com|site)|js\.puter|plausible" apps platform --include=*.js --include=*.html --include=*.css` must return nothing except comments you can justify. Do not grep for every `https://`: XML namespaces such as `schemas.openxmlformats.org` and `w3.org` are identifiers, not network calls. Check with the browser dev tools network panel (or a headless browser) that **zero external requests** happen while using the apps with the network disabled.

## 8. Quality bar

- Each app builds and runs from the root with its original tooling (Vite and Vitest). Existing tests that passed on the originals still pass. Tests that exist only to verify Puter's cloud behaviour are updated to the local SDK, not deleted.
- The platform has its own small test suite that checks each method in section 4 against the behaviour the apps expect. Keep it in `platform/` next to the code, not in a separate folder tree.
- Readable code, consistent style, short comments only where a decision is not obvious. No generated boilerplate, no giant single files, no leftover TODOs from earlier models.
- `README.md` at the root: what it is, requirements (Node 22.12 or newer, as in the original), `npm install`, `npm run dev`, where the data lives, how to back it up, how to enable AI.

## 9. Acceptance checklist (report each line as pass or fail)

1. Fresh clone, then `npm install`, then `npm start`, serves every app locally. One command, no manual steps.
2. Top-level of the repo contains only: `apps/`, `platform/`, `README.md`, `LICENSE`, `package.json`, `.gitignore` (plus the lockfile).
3. `apps/` has the same set of apps as the original `src/`, each with its original internal layout and no extra files.
4. With the network disconnected, sign in, create and save data in at least: `notes` (fs + kv), `spreadsheet` (worker + email path), `teamchat` (workers + multi-user), `video-studio` (fs + ai degrade), `chess` (auth + `peer` multiplayer between two browser tabs). Data survives a server restart.
5. A search for any Puter or analytics host in `apps/` and `platform/` returns nothing at runtime.
6. Every method in section 4 is implemented or explicitly documented as unsupported, with the apps handling the "unsupported" case without crashing.
7. Inside `apps/`, the only differences from the pristine originals are: the SDK `<script>`/import change, removed external calls (section 7), and the fixes you list explicitly. Every other changed or added file is a failure. Provide the diff summary.
8. Works on Windows as well as Linux/macOS (no symlinks, no shell-only scripts, no CRLF/LF breakage, for example in `tools/check-licenses.mjs`).

## 10. Working rules for you

- Do the audit and give the verdict first. Then work in small, reviewable steps and tell me what you changed.
- Do not leave half-finished things "for later". If something is out of scope or unsupported, say so plainly in the README.
- Do not add features, frameworks, ORMs, build systems or folders the original does not need. When a simpler option works, take it.
- If a requirement here conflicts with reality (for example an app genuinely needs something I did not list), tell me and propose the smallest fix.
