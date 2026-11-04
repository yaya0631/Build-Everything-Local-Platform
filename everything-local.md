# Plan: Everything Local (`everything-local`)

## 1. Build Order

We will build and verify the system in four sequential phases:

### Phase 1(a): Platform Server + SDK Skeleton
1. Create the root `package.json` (npm workspaces `["platform", "apps/*"]`, scripts: `dev`, `build`, `start`, plus `test` justified for running the conformance suite), root `LICENSE` (copied verbatim from `HeyPuter/everything@b5d2584`), and root `.gitignore` (ignoring `node_modules/`, `dist/`, `platform/data/`, `.vite/`, `*.log`).
2. Create `platform/package.json` (using Node 22.12+ built-in `node:sqlite`, `node:http`, `node:vm`, `node:crypto`, and `ws` for WebSocket upgrades).
3. Build the 8 server modules under `platform/server/` (each under 400 lines):
   - `platform/server/index.js`: SQLite schema initialization in `platform/data/everything.sqlite`, HTTP + WebSocket server, `<app>.localhost:<port>` and `<subdomain>.localhost:<port>` origin routing, static asset serving, `/sdk/puter.js` serving, and cross-platform Vite build/dev runner (invoking `node_modules/vite/bin/vite.js` via `process.execPath`).
   - `platform/server/auth.js`: Local account store, token/cookie session resolution, `signIn`, `signOut`, `isSignedIn`, `getUser`, `whoami`, `getProfilePicture`, and `perms` (`request`, `check`).
   - `platform/server/fs.js`: Disk file storage under `platform/data/files/<user_uuid>/` + SQLite metadata/shares/read-tokens (`write`, `read`, `delete`, `readdir`, `stat`, `rename`, `mkdir`, `copy`, `move`, `getReadURL`, `revokeReadURL`, `space`, `share`, `unshare`, `listShared`, `getShares`).
   - `platform/server/kv.js`: SQLite KV engine (`set`, `get`, `del`, `list`, `update`, `add`, `incr`, `decr`, `expire`, `expireAt`, `flush`) + WebSocket `events.onLocal` pub/sub.
   - `platform/server/workers.js`: Isolated `node:vm` worker runtime with `router`, `me.puter`, `user.puter`, system worker auto-registration, and `create`/`exec`/`delete`/`list`/`get`.
   - `platform/server/mail.js`: SQLite + disk mailbox store (`send`, `sendTransactional`, `list`) and optional local SMTP relay.
   - `platform/server/hosting.js`: Subdomain-to-directory mapping (`create`, `delete`, `get`, `list`, `update`).
   - `platform/server/ai.js`: Single local adapter interface with a built-in Ollama/OpenAI-compatible local `chat` adapter (streaming & non-streaming) and clean `local_ai_unavailable` responses for unconfigured `txt2img`, `txt2vid`, `speech2txt`, `txt2speech`, `img2txt`.
4. Build `platform/sdk/puter.js` (single static drop-in client script exposing `window.puter`) and `platform/sdk/index.js` (ESM wrapper for `@heyputer/puter.js` imports).

### Phase 1(b): Conformance Test Suite (`platform/platform.test.js`)
Write and run `node --test platform/platform.test.js` before touching the apps. It starts the platform server on an ephemeral port with a fresh temporary `data/` directory and tests **every method in Section 4**:
- **`fs` (13 methods):** `write` (string, binary, overwrite, createMissingParents), `read` (full + `offset`/`byte_count`), `delete` (single + array + recursive), `readdir` (plain array + paginated `{ items, cursor }`), `stat`, `rename`, `getReadURL`, `revokeReadURL` (verifying revoked URL returns 404/403), `space`, `share`, `unshare`, `listShared`, `getShares`.
- **`kv` (7 methods + `MAX`):** `set` (single + batch), `get`, `del`, `list` (keys, `returnValues: true`, prefix `pattern`, pagination, async iterator stream), `update` (pathMap), `add` (array append + numeric), `incr` (delta + default 1), plus `puter.kv.MAX`, `MAX_KEY_SIZE`, `MAX_VALUE_SIZE`.
- **`auth` (6 methods):** `signIn` (offline zero-popup default + user switching), `signOut`, `isSignedIn`, `getUser`, `getProfilePicture` (returns local SVG data URL), `whoami`.
- **`workers` (5 methods):** `create` (non-blocking deploy from `fs`), `exec` (routing GET/POST/PUT/DELETE with `me.puter` and `user.puter` isolation), `delete`, `list`, `get`.
- **`email` (3 methods):** `send`, `sendTransactional`, `list` (verifying messages persist in SQLite/disk mailbox).
- **`hosting` (2 methods):** `create`, `delete` (verifying files in the hosted `fs` folder are served at `<subdomain>.localhost:<port>`).
- **`perms` (2 methods):** `request`, `check` (auto-granted locally with no modal).
- **`ui` (13 methods):** `showOpenFilePicker`, `showSaveFilePicker`, `launchApp` (foreground + background iframe `postMessage` connection), `contextMenu`, `parentApp`, `onLaunchedWithItems`, `onItemsOpened`, `setWindowTitle`, `showWindow`, `hideWindow`, `requestPermission`, `onWindowClose`, `requestPictureInPicture` / `exitPictureInPicture`.
- **`ai` (6 methods):** `chat` (against a local mock Ollama server for both non-streaming and streaming NDJSON, plus clean error when offline), `txt2img`, `txt2vid`, `speech2txt`, `txt2speech`, `img2txt` (verifying structured `local_ai_unavailable` error without crashing).
- **`net` / `env` / `exit`:** `net.fetch` (allows same-origin/`*.localhost`, rejects external internet URLs), `net.Socket`, `net.tls`, `puter.env === 'app'`, `puter.exit()`.

### Phase 1(c): Apps in Batches of ~5 (Starting with Core 5)
Copy pristine `HeyPuter/everything@b5d2584` `src/<app>` into `apps/<app>`, apply the mechanical codemod (`/tmp/apply-codemod.mjs`), build with Vite, and verify tests/runtime in batches:
- **Batch 1 (Acceptance Checklist Core 5):** `chess`, `notes`, `spreadsheet`, `teamchat`, `video-studio`
- **Batch 2 (Worker + Office Apps):** `documents`, `presentation`, `whiteboard` (without `tmp/`), `wiki`, `calendar`
- **Batch 3 (Worker + Business Apps):** `invoicing`, `signatures`, `help-desk`, `meetings`, `survey`
- **Batch 4 (Worker + Field/Ops Apps):** `legal`, `fleet`, `field-service`, `property-management`, `vector-studio`
- **Batch 5 (Studio & Media Apps):** `photo-studio`, `audio-studio`, `music-studio`, `3d`, `parametric`
- **Batch 6 (CAD & Engineering Apps):** `cad`, `building-design`, `circuits`, `pdf`, `api-client`
- **Batch 7 (Finance & Accounting Apps):** `accounting`, `cap-table`, `expense`, `pos`, `contracts`
- **Batch 8 (CRM, HR & Org Apps):** `crm`, `contacts`, `hiring`, `shifts`, `time-tracking`
- **Batch 9 (Operations & Productivity Apps):** `inventory`, `projects`, `records`, `tasks`, `email`
- **Batch 10 (Games & Remaining Folders):** `backgammon`, `checkers`, `solitaire`, `sudoku`, `childcare`, `assets` (kept pristine; skipped by build runner because upstream omitted `src/assets/src/main.js`).

### Phase 1(d): Cleanup Pass & Final Verification
1. Delete `/tmp/apply-codemod.mjs` and `/tmp/audit` temporary directories.
2. Verify top-level directory entries match Section 3 Rule 1 & Section 9 Item 2.
3. Run the Section 7 external host `grep` across `apps/` and `platform/`.
4. Produce the complete diff summary of `apps/` vs `HeyPuter/everything@b5d2584/src/`.
5. Write the root `README.md` in under 60 lines.
6. Run the full Section 9 acceptance checklist (items 1–8) and report pass/fail for every line.

---

## 2. Non-Blocking API Behavior (Zero Browser Popups or Consent Modals)

Every SDK method in `platform/sdk/puter.js` and endpoint in `platform/server/*.js` runs **without opening browser popup windows (`window.open`) or blocking on trusted-click shadow-DOM consent modals**:

| Namespace / Method | Non-Blocking Local Behavior |
|---|---|
| `puter.auth.signIn(opts)` | **Never opens a popup.** Calls `POST /api/auth/signin` with `{ username: opts?.username || currentTabUser || 'local' }`, stores the returned session token in `sessionStorage` / `localStorage` and cookie, sets `puter.authToken`, and resolves `{ username, uuid, email, token }` immediately offline. |
| `puter.auth.isSignedIn()` | Synchronously/asynchronously checks active local token (auto-initializing the default `local` session on first load unless `signOut()` was explicitly called in that tab) and resolves `boolean`. |
| `puter.auth.getUser()` / `whoami()` | Resolves `{ uuid, uid, username, email, email_confirmed: true, is_temp: false }` from `GET /api/auth/whoami` (or rejects with `{ code: 'auth_required', status: 401 }` on `whoami()` after `signOut()`). |
| `puter.auth.getProfilePicture(opts)` | Resolves a deterministic local `data:image/svg+xml;utf8,...` avatar generated from the user's initials/username (zero network fetch). |
| `puter.auth.signOut()` | Clears the tab's active session token (`POST /api/auth/signout`), sets `sessionStorage.setItem('puter.signedOut', '1')`, and resolves `true`. Calling `signIn()` clears `puter.signedOut` and signs back in immediately. |
| `puter.workers.create(name, filePath)` | **Never shows a deploy consent modal.** Immediately sends `POST /api/workers/create` with `{ name, filePath, app }`. Server reads `filePath` from the user's `fs` (or falls back to the app's bundled worker file), validates syntax, stores the worker in SQLite, and returns `{ name, url: 'http://' + name + '.localhost:' + port, host_label: name, file_path: filePath, created_at }`. |
| `puter.fs.write` / `read` / `delete` / `rename` / `mkdir` / `copy` / `move` | **Never shows a Drive consent overlay.** Relative paths resolve inside the app's directory (`/Apps/<app>/...`); absolute paths (`/Documents/...`, `~/...`) resolve inside the authenticated user's local drive root `platform/data/files/<user_uuid>/` with strict path-traversal containment. Returns Puter v1 `fsentry` objects. |
| `puter.fs.getReadURL(path, expires)` / `revokeReadURL(urlOrPath)` | `getReadURL` mints a revocable token in SQLite `fs_read_urls` and returns `/api/fs/raw/<token>`. `revokeReadURL` marks the token `revoked = 1` in SQLite so subsequent fetches return `404`. |
| `puter.perms.request(perm, opts)` / `check(perm, opts)` | **Never blocks on a modal.** `request` records `(user_id, app_name, perm)` as granted in SQLite `perms` and resolves `true` (or `{ granted: true, path: '/Documents' }` for `'folder'`). `check` queries SQLite (defaulting to `true` locally). |
| `puter.ui.requestPermission(perm)` | Delegates to `puter.perms.request(perm)` and resolves `{ granted: true }` immediately without a modal. |
| `puter.ui.showOpenFilePicker(opts)` / `showSaveFilePicker(content, name, type)` | If `opts?.path` or `window.__PUTER_PICKER_MOCK__` is set (for automated tests), resolves `FSItem` immediately without UI. In interactive browser use, renders a lightweight inline DOM file-list dialog inside the current page (never a popup window). |
| `puter.ui.launchApp(name, opts)` | When `opts?.background` is true (used by `calendar` and `contacts` service bridges), mounts a hidden same-origin `<iframe>` and returns a `postMessage` connection object (`{ usesSDK: true, postMessage, on, off, close }`). Foreground calls navigate to `http://<name>.localhost:<port>/`. |
| `puter.ui.showWindow` / `hideWindow` / `contextMenu` / `setWindowTitle` / `onWindowClose` | `setWindowTitle` sets `document.title`; `onWindowClose` binds `pagehide`/`beforeunload`; `showWindow`, `hideWindow`, and `contextMenu` store state and resolve `undefined`/`null` cleanly. |
| `puter.ai.chat(prompt, ...rest)` | Calls `POST /api/ai/chat`. If a local runtime (`LOCAL_AI_URL`, default `http://127.0.0.1:11434`) is reachable, streams NDJSON chunks or returns `{ message: { role: 'assistant', content, tool_calls }, toString(), valueOf() }`. If unreachable, rejects with a structured `{ code: 'local_ai_unavailable', status: 503, message: 'Local AI runtime is not running.' }` so apps show their built-in offline/unavailable message instead of crashing. |
| `puter.ai.txt2img` / `txt2vid` / `speech2txt` / `txt2speech` / `img2txt` | Rejects cleanly with `{ code: 'local_ai_unavailable', status: 501, message: 'This AI capability is not configured on the local server.' }` unless a local adapter endpoint is configured in `platform/server/ai.js`. |
| `puter.exit(code)` | If running as a background launched child iframe, notifies parent and closes the channel; otherwise resolves `undefined` without closing the user's browser tab. |

---

## 3. Exact Mechanical Change Applied to Every App (`/tmp/apply-codemod.mjs`)

We will write a standalone, uncommitted script at `/tmp/apply-codemod.mjs` and run it over `apps/` after copying `/tmp/audit/orig-everything/src/*` to `apps/`.

### Exact Transformations Performed by `/tmp/apply-codemod.mjs`
1. **Remove Non-Source / Cloud Artifacts:**
   - Delete `apps/whiteboard/tmp/` (~850 scratch files, 233 MB, and 2 broken symlinks: `csv-baseline-main/node_modules` and `wcag-webhook-serial/src`).
   - Delete all 51 per-app `apps/<app>/package-lock.json` files (Section 3 Rule 4: "no lockfile copies per folder").
   - Delete all 5 per-app `customHttp.yml` files (`chess`, `checkers`, `backgammon`, `spreadsheet`, `teamchat`).
2. **Remove Cloud Dev Plugin & Cloud Worker Deploy Scripts:**
   - In every `apps/<app>/vite.config.js` and `vite.config.ts`: remove `import puterLocalhost from '../../dev/puter-localhost.mjs'` and `puterLocalhost(...)` from `plugins: [...]`.
   - In every `apps/<app>/package.json`: remove `deploy:worker` and `deploy:email-worker` scripts (`puter worker deploy ...`).
3. **Replace Puter SDK Loader URLs:**
   - In all `.html`, `.js`, and `.ts` files under `apps/`: replace `https://js.puter.com/v2/` and `https://js.puter.com/v2` with `/sdk/puter.js`.
4. **Remove Plausible Analytics Scripts & Update Affected Tests:**
   - Remove `<script async src="https://plausible.io/js/..."></script>` and the immediately following inline `window.plausible = ...; plausible.init()` `<script>` block from HTML/site files (`backgammon`, `calendar`, `cap-table`, `checkers`, `chess`, `contacts`, `inventory`, `spreadsheet`, `whiteboard`).
   - Remove `window.plausible` calls or no-op them in `src/analytics.js` / `src/lib/analytics.js` / `src/js/analytics.js` where they reference `plausible.io`.
   - Update the 3 test files that explicitly assert on the `plausible.io` `<script>` tag in HTML (`apps/whiteboard/tests/analytics.test.js`, `apps/cap-table/tests/public-content.test.js`, `apps/calendar/tests/booking-route.test.js`) so they assert that no external analytics script is injected.
5. **Replace Puter Cloud Hosts (`puter.com`, `puter.site`, `puter.work`, `docs.puter.com`, `developer.puter.com`):**
   - Replace `https://<worker>.puter.work` constants (e.g., `https://spreadsheet-email.puter.work`, `https://calendar-email.puter.work`, `https://invoicing-email.puter.work`, `https://field-service-email.puter.work`, `https://property-management-email.puter.work`, `https://signatures-email.puter.work`, `https://teamchat-email.puter.work`, `https://puter-meetings-rooms.puter.work`) with `/w/<worker>`.
   - Update host/origin allowlist helpers inside app workers and clients (such as `puterHost(hostname)` in `email-worker.js`, `rsvp-worker.js`, `sign-worker.js`, `team-worker.js`, and worker URL validators in `signatures`, `spreadsheet`, `calendar`, `meetings`, `teamchat`, `help-desk`, `wiki`, `whiteboard`, `video-studio`, `vector-studio`) so local origins (`localhost`, `*.localhost`, `127.0.0.1`, `http:`, and `/w/...` paths) are accepted instead of requiring `*.puter.com` / `*.puter.site` / `*.puter.work`.
   - Replace `api.puter.com`, `puter.com`, `*.puter.site`, `developer.puter.com`, and `docs.puter.com` links/strings in `.js`, `.ts`, `.html`, `.css`, `README.md`, and `STORE_LISTING.md` with local equivalents (`/api`, `http://localhost:8443`, `*.localhost`) or remove cloud marketing links.
6. **Remove Remaining External Runtime Fetches / CDNs:**
   - In `apps/3d/src/scripting/python.ts`: replace `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` with `/vendor/pyodide/` so it never reaches `cdn.jsdelivr.net`.
   - In `apps/fleet`: replace external NHTSA API endpoints (`https://vpic.nhtsa.dot.gov/...` and `https://api.nhtsa.gov/...`) with local `/api/fleet/vpic/` and `/api/fleet/recalls` paths (which return a clean local-unavailable response offline).
   - In `apps/presentation/src/assets/fonts/SOURCES.json`: remove external `fonts.gstatic.com` URLs (the `.ttf` font files themselves are already bundled locally in `apps/presentation/src/assets/fonts/`).
7. **Windows CRLF Compatibility Fix:**
   - In `apps/documents/tools/check-licenses.mjs` and `apps/help-desk/tools/check-licenses.mjs`: normalize `\r\n` to `\n` before SHA-256 hashing `LICENSE` so `npm run build` succeeds on Windows with `core.autocrlf=true`.

### Diff Reporting Against Pristine `b5d2584`
Immediately after running `/tmp/apply-codemod.mjs`, we will run `diff -rq /tmp/audit/orig-everything/src apps` and `git diff --stat` against `b5d2584` and print the per-app diff summary confirming that **only** the mechanical changes listed above were made and **zero** extra files exist in `apps/`.

---

## 4. Worker Runtime Design (`platform/server/workers.js`)

15 apps ship serverless workers (`teamchat`, `help-desk`, `meetings`, `survey`, `wiki`, `spreadsheet`, `calendar`, `invoicing`, `legal`, `fleet`, `field-service`, `property-management`, `signatures`, `vector-studio`, `video-studio`), plus `documents`, `photo-studio`, `whiteboard`, and `childcare` which also ship worker scripts.

### 4.1 Isolation & Execution Model
- Each worker runs in an isolated `node:vm` context created via `vm.createContext(...)`.
- **Allowed globals inside the VM:** `router`, `me`, `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `crypto` (`globalThis.crypto`), `console`, `setTimeout`, `clearTimeout`, `atob`, `btoa`, `structuredClone`, `Uint8Array`, `ArrayBuffer`, `Blob`.
- **Denied globals:** No `process`, no `require`, no `fs`, no `child_process`, and no external `fetch` or `WebSocket`.
- Worker source files (including ESM workers that use `export` or top-level statements) are transformed lightly on load (stripping `export default` / `export { ... }` if present so `vm.Script` evaluates cleanly in the isolated context) with a `timeout: 30000` ms guard.

### 4.2 `router`, `me.puter`, and `user.puter` Globals
1. **`router` global:**
   - Exposes `router.get(pattern, handler)`, `router.post`, `router.put`, `router.patch`, `router.delete`, `router.options`, `router.all`.
   - Pattern matcher supports exact segments, `:param` named parameters (URI-decoded into `ctx.params`), and wildcard `*` tails.
2. **`me.puter` (Worker Owner Context):**
   - Available both as the top-level `me` global inside the VM and as `ctx.me` on each request context.
   - Bound to the account that deployed the worker (or `system:<worker-name>` for pre-registered app email/room workers):
     - `me.puter.kv`: scoped to `(owner_id, 'worker:' + workerName)` in SQLite `kv_store`, supporting `get`, `set` (key/value and batch array `[{ key, value }]`), `del`/`remove`, `list` (prefix pattern + `returnValues`), `update`, `add`, `incr`, `decr`, `expire`, `expireAt`, `flush`.
     - `me.puter.email`: `send(msg)` and `sendTransactional(msg)` writing directly to `platform/server/mail.js`.
     - `me.puter.fs`: `read`, `write`, `mkdir`, `delete`, `stat`, `readdir` scoped to the owner's files.
     - `me.puter.auth.getUser()` and `me.puter.getUser()`: resolves `{ uuid, uid: uuid, username, email }`.
     - `me.puter.authToken`: owner's token/UUID.
3. **`user.puter` / `requestor.puter` (Caller Context):**
   - Available on `ctx.user` and `ctx.requestor` (since some workers read `ctx.user` and others read `ctx.requestor`).
   - Populated from the caller's session token forwarded by `puter.workers.exec` (or `Authorization` / `puter-auth` header):
     - `ctx.user = { uuid, uid: uuid, username, email, puter: callerPuter }`
     - `callerPuter.auth.getUser()` / `callerPuter.getUser()` resolves `{ uuid, uid: uuid, username, email }`.
     - `callerPuter.kv`, `callerPuter.fs`, `callerPuter.email` (`send`, `sendTransactional`), and `callerPuter.authToken` are bound to the calling user's account.
   - If a request is unauthenticated (no caller session), `ctx.user` and `ctx.requestor` are `null` (so workers that require authentication return `401` as expected by their tests).

### 4.3 How `workers.exec` and `/w/<name>/*` Route Calls
- **Pre-registered System Workers:** On startup, `platform/server/workers.js` scans `apps/*` for built/source system workers (`spreadsheet-email`, `calendar-email`, `calendar-rsvp`, `invoicing-email`, `field-service-email`, `property-management-email`, `signatures-email`, `signatures-sign`, `teamchat-email`, `puter-meetings-rooms`, etc.) and registers them automatically.
- **Dynamic App Workers (`puter.workers.create(name, filePath)`):** When an app calls `puter.fs.write('worker.js', code)` followed by `puter.workers.create(name, 'worker.js')` (or passes `/worker/<app>-worker.js`), `workers.js` reads the script from the user's `fs` (or from `apps/<app>/public/worker/` / `apps/<app>/dist/worker/`), compiles the route table, and persists the worker in SQLite `workers`.
- **Dispatch (`puter.workers.exec(target, init)` and HTTP `/w/<name>/*`):**
  1. Extracts the worker `name` and route `path` from `target`:
     - `https://<name>.puter.work/<path>` → `name`, `/<path>`
     - `http://<name>.localhost:<port>/<path>` → `name`, `/<path>`
     - `/w/<name>/<path>` → `name`, `/<path>`
     - bare `<name>` with `init.path` or `init.url` → `name`, `init.path || '/'`
  2. Constructs `ctx.request` (a standard `Request`-compatible object with `.url`, `.method`, `.headers` with `.get()`, `.text()`, `.json()`, and `puter-auth` header set when caller is signed in), `ctx.params`, `ctx.me`, `ctx.user`, and `ctx.requestor`.
  3. Invokes the matched route handler in the worker's VM context, serializes the returned `Response` or plain JSON object into `{ status, headers, body }`, and returns a real `Response` to the caller in `puter.workers.exec`.

---

## 5. Multi-User Design (`teamchat`, `perms`, `fs.share`)

1. **Pre-Seeded Accounts & Instant Account Switching:**
   - On first run, `platform/server/auth.js` seeds three local accounts in SQLite `users`:
     - `local` (`local@localhost`, default user)
     - `alice` (`alice@localhost`)
     - `bob` (`bob@localhost`)
   - Any additional username passed to `puter.auth.signIn({ username: 'charlie' })` or `POST /api/auth/signin` is created on the fly in SQLite `users`.
   - **Multi-Tab Isolation on One Machine:** If a tab is opened with `?user=bob` (or calls `puter.auth.signIn({ username: 'bob' })`), the SDK stores Bob's session token in `sessionStorage` (`puter.session.token`), which overrides the shared `localStorage` token for that tab. This lets a user open two tabs side-by-side on the same browser (Tab 1 as `alice`, Tab 2 as `bob`) and chat or co-edit in `teamchat`, `spreadsheet`, `whiteboard`, or `wiki`.
2. **`teamchat` Multi-User Flow:**
   - User 1 (`alice`) creates a workspace, which deploys a worker via `puter.workers.create(workerName, ...)` owned by `alice`.
   - `me.puter.kv` inside that worker is scoped to `alice`'s worker namespace (`worker:<workerName>`).
   - User 2 (`bob`) joins the workspace URL/worker and calls `puter.workers.exec(...)` with Bob's session token.
   - Inside the worker, `ctx.user.puter.auth.getUser()` identifies `bob` (`{ uuid, username: 'bob', email: 'bob@localhost' }`), while `ctx.me.puter.kv` reads/writes the shared workspace state in `alice`'s worker KV store.
3. **`fs.share`, `fs.unshare`, `fs.listShared`, `fs.getShares`:**
   - `puter.fs.share(path, targetUser, { mode: 'view' | 'edit' })` inserts a row into SQLite `fs_shares(owner_id, path, target_user, permission)`.
   - `puter.fs.unshare(path, targetUser)` removes the share row.
   - `puter.fs.getShares(path)` returns `{ people: [{ username, mode }], links: [...] }` for that path.
   - `puter.fs.listShared(path)` returns shared users for `path` (or, when called with no path, returns all incoming files shared *with* the current user by other local users).
   - When `bob` calls `puter.fs.read` or `puter.fs.write` on a path shared by `alice`, `platform/server/fs.js` checks `fs_shares` and resolves the file in `alice`'s storage directory if permitted.
4. **`perms.request` & `perms.check`:**
   - Stored in SQLite `perms(owner_id, app_name, permission, granted_path)`.
   - Supports app permissions (`'folder'`, `'ai'`, `'email'`, `'workers'`, etc.) and cross-user KV/FS share handles (`puter.events.onLocal` notifies subscribed WebSocket clients whenever a key or shared resource changes).

---

## 6. What We Delete From the Forks and Why (Including Zero Vendored Bloat)

### 6.1 Deleted from `yaya0631/everything-apps` (Discard Fork, Re-derive from `b5d2584`)
- **All 15 fork commits are discarded:**
  - `1d2588e8` (`src/cad` 4,060-line custom replacement): Replaced the pristine CAD app with a custom app tied to `fork-platform`'s proprietary `/api/cad` endpoints. Deleted in favor of pristine `src/cad` at `b5d2584`.
  - `e750f374` (`src/teamchat/public/worker/teamchat-worker.js` 12,562-line committed build output & `/h/<name>/` subpath rewrites across 10 apps): Committed generated bundle bloat and subpath workarounds that are unnecessary when serving each app on `<app>.localhost:<port>`.
  - `8189d758`, `a84e06a8`, `0e023619`, `522a5a6e`, `0af51c7f`, `c0b98f97`, `bba8dead`, `0936adcc`, `b760b00a` (custom AI assistant rewrites in `building-design`, `photo-studio`, `documents`, `whiteboard`): Unrequested feature additions that diverge from upstream `b5d2584`.
  - `48b1d7d8` & `852552d9` (`src/assets` invented app & icons): Upstream `b5d2584` has no `src/assets/src/`; per Section 7 of `BRIEF.md`, we keep `apps/assets` pristine and skip it in the build step rather than inventing an app.
- **Deleted from pristine `HeyPuter/everything@b5d2584`:**
  - Root `amplify.yml`, root `customHttp.yml`, per-app `customHttp.yml` (5 files), root `dev/puter-localhost.mjs`, root `assets/` (README marketing banners), `.github/`, per-app `package-lock.json` (51 files), and `src/whiteboard/tmp/` (~850 scratch files, 233 MB, 2 broken symlinks).

### 6.2 Deleted from `yaya0631/everything-platform` (Rebuild Cleanly in Section 3 Tree)
- **`verification/` (19 files, ~1,500 lines):** One-off agent progress logs (`REPORT.md`, `findings.json`, `progress.md`, `harness/*.mjs`). Deleted.
- **`platform/docs/` (8 files, ~3,873 lines):** Agent session logs (`AI-PROGRESS.md`, `AGENTS.md`, `VERIFY-REPORT-2026-10-22.md`, `phase3-workers-design.md`, etc.). Deleted.
- **`platform/vendor/pyodide/` (7 files, 58,349 lines):** **Dropped completely.** Nothing is vendored in `platform/`. In `apps/3d/src/scripting/python.ts`, `PYODIDE_INDEX_URL` is changed from `https://cdn.jsdelivr.net/...` to `/vendor/pyodide/`. `apps/3d` only loads Pyodide when a user clicks Run inside the optional Python scripting tab, where `python.ts` already wraps `loadPyodide()` in a `try / catch` and prints an error in the console panel if unavailable. Dropping Pyodide removes 58,349 lines of WASM/zip bloat with zero impact on 3D modeling, rendering, or tests.
- **Root E2E scripts & JSON dumps in `platform/` (24 files, ~7,500 lines):** `*-e2e.mjs`, `*-results.json`, `browser-smoke.mjs`, `functional-gate.mjs`, `verify-all.mjs`, `_smoke.txt`. Replaced by a single clean `platform/platform.test.js`.
- **Duplicate CAD + Hub dual server (`platform/panel/` 10 files, `platform/engines/`, `platform/tools/`, and 30 files in `platform/lib/`):** Replaced by the 8 focused files in `platform/server/` (`index.js`, `auth.js`, `fs.js`, `kv.js`, `workers.js`, `mail.js`, `hosting.js`, `ai.js`) and `platform/sdk/puter.js`.

---

## 7. Windows, Linux, and macOS Support

1. **Zero Symlinks:**
   - Removing `apps/whiteboard/tmp/` eliminates the only 2 symlinks in the upstream repo (`csv-baseline-main/node_modules` and `wcag-webhook-serial/src`).
   - Verified by `find . -type l` returning zero results (excluding `node_modules/.bin` created by npm).
2. **No CRLF / Line-Ending Breakage:**
   - `apps/documents/tools/check-licenses.mjs` and `apps/help-desk/tools/check-licenses.mjs` normalize `\r\n` to `\n` before checking SHA-256 hashes of `LICENSE` files so builds pass when Git on Windows checks out files with CRLF.
   - Worker script loader and test assertions normalize `\r\n` to `\n`.
3. **No Shell-Only Scripts or POSIX Path Assumptions:**
   - Root `package.json` scripts (`dev`, `build`, `start`, `test`) invoke `node platform/server/index.js ...` directly — no `.sh` files, no `rm -rf`, `cp -r`, or `FOO=bar` POSIX env prefixes.
   - `platform/server/index.js` runs per-app Vite builds and `build:worker` scripts by resolving Vite's JS entrypoint (`node_modules/vite/bin/vite.js`) and spawning `process.execPath` (`node`), avoiding `cmd.exe` / `.cmd` shim quoting issues on Windows.
   - All filesystem paths in `platform/server/*.js` use `node:path` (`path.join`, `path.resolve`, `path.posix` for virtual Puter paths) and `url.pathToFileURL` for dynamic imports.

---

## 8. Acceptance Checklist (Section 9) & Verification Commands

| # | Acceptance Criterion (from Section 9 of Brief) | Exact Verification Command / Test |
|---|---|---|
| **1** | Fresh clone, then `npm install`, then `npm start`, serves every app locally. One command, no manual steps. | `npm install && npm run build && npm start` — automated check fetches `http://<app>.localhost:<port>/` for all 50 buildable apps and verifies HTTP 200 + `<script src="/sdk/puter.js">`. |
| **2** | Top-level of the repo contains only: `apps/`, `platform/`, `README.md`, `LICENSE`, `package.json`, `.gitignore` (plus the lockfile). | `node -e "console.log(fs.readdirSync('.').filter(f => !['.git','.figma','node_modules'].includes(f)).sort())"` — must equal `['.gitignore', 'LICENSE', 'README.md', 'apps', 'package-lock.json', 'package.json', 'platform']`. |
| **3** | `apps/` has the same set of apps as the original `src/`, each with its original internal layout and no extra files. | `node /tmp/verify-layout.mjs` — compares directory list and file tree of `apps/<name>` vs `/tmp/audit/orig-everything/src/<name>` (verifying all 51 folders match and zero extra files exist). |
| **4** | With the network disconnected, sign in, create and save data in at least: `notes` (`fs` + `kv`), `spreadsheet` (worker + email path), `teamchat` (workers + multi-user), `video-studio` (`fs` + `ai` degrade), `chess` (`auth` only). Data survives a server restart. | End-to-end verification test (`node --test platform/platform.test.js` + headless browser / API flow) exercising `notes`, `spreadsheet`, `teamchat`, `video-studio`, and `chess`, stopping the server process, restarting it against the same `platform/data/`, and verifying all saved notes, workbooks, emails, chat messages, projects, and user sessions are intact. |
| **5** | A search for any Puter or analytics host in `apps/` and `platform/` returns nothing at runtime. | `grep -rE "puter\.(com|site)|js\.puter|plausible" apps platform --include=*.js --include=*.html --include=*.css` — returns zero runtime references. |
| **6** | Every method in section 4 is implemented or explicitly documented as unsupported, with the apps handling the "unsupported" case without crashing. | `node --test platform/platform.test.js` — runs one dedicated conformance test per method in Section 4 (`fs`, `kv`, `auth`, `workers`, `email`, `hosting`, `perms`, `ui`, `ai`, `net`, `env`, `exit`) and verifies graceful degradation on unsupported `ai` methods. |
| **7** | Inside `apps/`, the only differences from the pristine originals are: the SDK `<script>`/import change, removed external calls (section 7), and the fixes you list explicitly. Every other changed or added file is a failure. Provide the diff summary. | `diff -rq /tmp/audit/orig-everything/src apps` — script summarizes every modified/deleted file per app and asserts 0 added files and 0 unexplained diffs. |
| **8** | Works on Windows as well as Linux/macOS (no symlinks, no shell-only scripts, no CRLF/LF breakage, for example in `tools/check-licenses.mjs`). | `find apps platform -type l` (must be empty) + CRLF test on `documents/tools/check-licenses.mjs` and `help-desk/tools/check-licenses.mjs` + verifying `package.json` scripts use only `node`. |
