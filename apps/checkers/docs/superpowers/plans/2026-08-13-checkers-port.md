# Checkers Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the single-file checkers game as a structural mirror of `chess.localhost:8443` — same architecture, visual design, and feature set, with American checkers in place of chess.

**Architecture:** Vanilla JS, no runtime framework, built with Vite. A pure rules engine over a 32-cell board (`src/engine/checkers.js`) that deals only in complete turns; a negamax AI over it; a DOM-only board view; a controller (`src/main.js`) that owns all app state including the hop-at-a-time jump chain; and four supporting modules for clock, persistence, PDN export, and Puter Peer online play.

**Tech Stack:** Vite 8, Vitest 4, `lucide` icons, `@fontsource/inter`, Puter Peer API (loaded lazily from the CDN, not an npm dependency).

**Reference implementation:** `../chess.localhost:8443` is the app being mirrored. Many tasks say "port from" a file there. That means: read that file, keep its structure, comments, and naming, and change only what the spec says changes. It does **not** mean rewrite from scratch.

**Spec:** `docs/superpowers/specs/2026-08-13-checkers-port-design.md`

## Global Constraints

- Target deploy: **checkers.localhost:8443**. Every canonical URL, `og:url`, PDN `Site` tag, manifest `start_url`, and sitemap entry uses it.
- Rules: American checkers (English draughts). **Capture is mandatory**; among several capturing sequences the player chooses freely. **Black moves first.** Crowning ends the turn immediately. **A player with no legal move loses.**
- Colours are `'b'` and `'w'` internally, displayed "Black" and "White". Upper case in a board cell means a king: `'b' 'B' 'w' 'W'`.
- Squares are PDN numbers **1–32**. `num = row*4 + (col>>1) + 1`, dark squares are those where `(row+col)` is odd, row 0 at the top. Black's back row is 1–4, White's is 29–32; Black starts on 1–12, White on 21–32.
- Directions are indexed `0: up-left (-1,-1)`, `1: up-right (-1,+1)`, `2: down-left (+1,-1)`, `3: down-right (+1,+1)`. Black men use dirs 2,3; White men use dirs 0,1; kings use all four.
- The engine deals **only in complete turns**. No engine method ever accepts or returns a partial jump sequence, except the read-only `preview()`.
- No `promotion` parameter anywhere — crowning is automatic.
- Storage keys: `checkers-game`, `checkers-settings`.
- Never commit a placeholder Plausible ID copied from the chess app. See Task 16.
- All user-facing text is written with `textContent`, never `innerHTML`. Opponent names and invite codes come off the wire.
- Every task ends with a passing `npm test` and a commit.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json`, `vite.config.js` | build and test config |
| `index.html` | app shell — topbar, board, sidebar, dialogs |
| `src/style.css` | all styling |
| `src/main.js` | controller: app state, modes, interaction, chain lock, rendering orchestration |
| `src/analytics.js` | Plausible wrapper (ported verbatim) |
| `src/engine/geometry.js` | square numbering and the `STEPS`/`JUMPS` tables |
| `src/engine/checkers.js` | position, move generation, apply/undo, status |
| `src/engine/ai.js` | evaluation and search |
| `src/ui/boardView.js` | board DOM, pointer and keyboard input |
| `src/game/chain.js` | filtering a move list down to a jump sequence in progress |
| `src/game/clock.js` | time controls and the two countdowns (ported verbatim) |
| `src/game/persistence.js` | saved-game read/write/validate |
| `src/game/pdn.js` | PDN export |
| `src/net/online.js` | Puter Peer session |
| `tests/*.test.js` | one file per module under test |

Geometry is split out of `checkers.js` because it is pure data with no dependency on position state, it is the single most important thing to get right, and it deserves its own test file. `chain.js` is split out of `main.js` for the same reason: it is the one piece of genuinely new logic in the port, and in the controller it would be untestable without a DOM.

---

# Phase 1 — Engine

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `vite.config.js`, `tests/scaffold.test.js`
- Reference: `../chess.localhost:8443/package.json`, `../chess.localhost:8443/vite.config.js`

**Interfaces:**
- Consumes: nothing
- Produces: a working `npm test` and `npm run dev`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "checkers-puter",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "description": "Play checkers against the computer or a friend — locally or online. No frameworks, just the web.",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vite": "^8.2.0",
    "vitest": "^4.1.10"
  },
  "dependencies": {
    "@fontsource/inter": "^5.3.0",
    "lucide": "^1.28.0"
  }
}
```

- [ ] **Step 2: Write `vite.config.js`**

```js
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
```

- [ ] **Step 3: Write a scaffold test**

```js
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Install and run**

Run: `npm install && npm test`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vite.config.js tests/scaffold.test.js
git commit -m "Add the Vite and Vitest scaffold"
```

---

## Task 2: Board geometry

The single most important task in the plan. A mirrored numbering produces a board that is entirely self-consistent and wrong against every published game, so the tests here assert against known-good facts from outside the code: the printed diagram, and the two most common opening moves in checkers.

**Files:**
- Create: `src/engine/geometry.js`, `tests/geometry.test.js`

**Interfaces:**
- Produces:
  - `squareToRowCol(num) → [row, col]` — `num` is 1–32
  - `rowColToSquare(row, col) → number` — 0 for a light square
  - `STEPS: number[][]` — 33 rows (index 0 unused) of 4; `STEPS[num][dir]` is the adjacent square, or 0
  - `JUMPS: (null | {over: number, land: number})[33][4]`
  - `DIRS_BLACK = [2, 3]`, `DIRS_WHITE = [0, 1]`, `DIRS_KING = [0, 1, 2, 3]`
  - `CROWN_ROW = { b: 7, w: 0 }`
  - `isCrowningSquare(num, color) → boolean`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import {
  squareToRowCol, rowColToSquare, STEPS, JUMPS, isCrowningSquare,
} from '../src/engine/geometry.js';

describe('square numbering', () => {
  it('puts square 1 on the top row and 32 on the bottom', () => {
    expect(squareToRowCol(1)).toEqual([0, 1]);
    expect(squareToRowCol(4)).toEqual([0, 7]);
    expect(squareToRowCol(29)).toEqual([7, 0]);
    expect(squareToRowCol(32)).toEqual([7, 6]);
  });

  it('round-trips every square', () => {
    for (let n = 1; n <= 32; n++) {
      const [r, c] = squareToRowCol(n);
      expect(rowColToSquare(r, c)).toBe(n);
    }
  });

  it('reports light squares as 0', () => {
    expect(rowColToSquare(0, 0)).toBe(0);
    expect(rowColToSquare(7, 7)).toBe(0);
  });

  // Guards against a mirrored board: these are the two most-played opening
  // moves in checkers, and both must be single diagonal steps in the right
  // direction. 11-15 is Black's "Old Faithful"; 23-19 is a standard reply.
  it('makes the classic openings legal single steps', () => {
    expect(STEPS[11][2]).toBe(15);  // Black steps down-left
    expect(STEPS[23][1]).toBe(19);  // White steps up-right
  });

  it('gives edge squares no off-board neighbours', () => {
    expect(STEPS[1][0]).toBe(0);    // top row has nothing above it
    expect(STEPS[5][0]).toBe(0);    // left file has nothing up-left
    expect(STEPS[29][2]).toBe(0);   // bottom row has nothing below it
  });

  it('builds jumps as a step onto a landing square two away', () => {
    expect(JUMPS[11][2]).toEqual({ over: 15, land: 18 });
    expect(JUMPS[1][2]).toBe(null); // no landing square: 1 is on the edge file
  });

  it('knows the crowning rows', () => {
    expect(isCrowningSquare(29, 'b')).toBe(true);
    expect(isCrowningSquare(32, 'b')).toBe(true);
    expect(isCrowningSquare(1, 'b')).toBe(false);
    expect(isCrowningSquare(1, 'w')).toBe(true);
    expect(isCrowningSquare(29, 'w')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/geometry.test.js`
Expected: FAIL — cannot resolve `../src/engine/geometry.js`.

- [ ] **Step 3: Implement the module**

```js

import { colorOf, isKing } from './checkers.js';
import { squareToRowCol } from './geometry.js';

const WIN = 100000;
const INFINITY = 1000000;

export const MAN = 100;
export const KING = 175;

export const LEVELS = {
  easy: { depth: 2, window: 120, label: 'Easy' },
  medium: { depth: 6, window: 30, label: 'Medium' },
  hard: { depth: 8, window: 0, label: 'Hard' },
};

// Hard was tuned down from a starting guess of depth 10 against measured
// per-move worst cases: 3604ms at depth 10, 1232ms at depth 9, 499ms at
// depth 8. Easy runs ~1ms/move and Medium ~25-30ms/move.

/**
 * Static evaluation from Black's perspective.
 *
 * Material and shape only. A mobility term would have to call moves(), which
 * generates every jump chain on the board — at every leaf of a depth-10
 * search that costs more than it is worth, and the search already sees
 * mobility directly in the moves it enumerates.
 */
export function evaluate(game) {
  const board = game.board();
  let score = 0;
  for (let n = 1; n <= 32; n++) {
    const piece = board[n];
    if (!piece) continue;
    const black = colorOf(piece) === 'b';
    const [row, col] = squareToRowCol(n);
    let value = isKing(piece) ? KING : MAN;
    if (!isKing(piece)) {
      // Men are worth more the closer they are to crowning.
      value += (black ? row : 7 - row) * 4;
      // Holding your own back row denies the opponent a crowning square.
      if ((black && row === 0) || (!black && row === 7)) value += 6;
    }
    // An edge piece cannot be jumped, but cannot jump either.
    value += col === 0 || col === 7 ? -4 : 2;
    score += black ? value : -value;
  }
  return score;
}

/** Evaluation from the point of view of the side to move. */
function sideScore(game) {
  return game.turn() === 'b' ? evaluate(game) : -evaluate(game);
}

/** Captures first, longest chain first: the cheapest useful ordering. */
function orderMoves(moves) {
  return moves.slice().sort((a, b) => b.captured.length - a.captured.length);
}

/**
 * Search on while the side to move is obliged to jump. Forced capture makes
 * this exact: there is no "quiet" position in which a capture is pending, so
 * the horizon can never fall in the middle of an exchange.
 */
function quiescence(game, alpha, beta, ply) {
  if (!game.mustCapture()) return sideScore(game);
  const moves = game.moves();
  if (moves.length === 0) return -WIN + ply;
  let best = -INFINITY;
  for (const move of moves) {
    game.move({ path: move.path });
    const score = -quiescence(game, -beta, -alpha, ply + 1);
    game.undo();
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

function search(game, depth, alpha, beta, ply) {
  const moves = orderMoves(game.moves());
  // No move is a loss in checkers, not a draw — there is no stalemate.
  if (moves.length === 0) return -WIN + ply;
  if (game.isDraw()) return 0;
  if (depth === 0) return quiescence(game, alpha, beta, ply);
  let best = -INFINITY;
  for (const move of moves) {
    game.move({ path: move.path });
    const score = -search(game, depth - 1, -beta, -alpha, ply + 1);
    game.undo();
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

export function findBestMove(game, level = 'medium', rng = Math.random) {
  const cfg = typeof level === 'string' ? LEVELS[level] : level;
  if (!cfg) throw new Error(`Unknown difficulty level: ${level}`);

  const rootMoves = orderMoves(game.moves());
  if (rootMoves.length === 0) return null;

  const scored = [];
  let alpha = -INFINITY;
  for (const move of rootMoves) {
    game.move({ path: move.path });
    const score = -search(game, cfg.depth - 1, -INFINITY, -alpha + cfg.window, 1);
    game.undo();
    // A beta cutoff in the child search means `score` is only an upper bound.
    scored.push({ move, score, exact: score > alpha - cfg.window });
    if (score > alpha) alpha = score;
  }

  const best = Math.max(...scored.map((s) => s.score));
  // An upper bound can land exactly on the threshold while the true value is
  // far below it; re-search those with a full window so the random pick never
  // selects a move from outside the intended band.
  for (const s of scored) {
    if (!s.exact && s.score >= best - cfg.window) {
      game.move({ path: s.move.path });
      s.score = -search(game, cfg.depth - 1, -INFINITY, INFINITY, 1);
      game.undo();
    }
  }
  const candidates = scored.filter((s) => s.score >= best - cfg.window);
  return candidates[Math.floor(rng() * candidates.length)].move;
}

/**
 * Async wrapper: yields to the event loop so the UI can paint a "thinking"
 * state, and enforces a minimum think time so replies feel deliberate.
 */
export function chooseMove(game, level, { minThinkMs = 450 } = {}) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const started = performance.now();
      const move = findBestMove(game, level);
      const elapsed = performance.now() - started;
      setTimeout(() => resolve(move), Math.max(0, minThinkMs - elapsed));
    }, 30);
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/ai.test.js`
Expected: all 10 pass.

- [ ] **Step 5: Tune the depths against a real budget**

Run:
```bash
node -e "
const {Checkers}=await import('./src/engine/checkers.js');
const {findBestMove,LEVELS}=await import('./src/engine/ai.js');
for(const [name,cfg] of Object.entries(LEVELS)){
  const g=new Checkers(); const t=performance.now();
  for(let i=0;i<8&&!g.isGameOver();i++) g.move({path:findBestMove(g,cfg).path});
  console.log(name,cfg.depth,Math.round(performance.now()-t)+'ms for 8 plies');
}
" --input-type=module
```
Expected: `hard` stays under about 1500ms per move. If it does not, lower `LEVELS.hard.depth` until it does and note the measured figure in a comment beside `LEVELS`. Middlegame positions branch more than the opening, so leave headroom.

- [ ] **Step 6: Commit**

```bash
git add src/engine/ai.js tests/ai.test.js
git commit -m "Add the computer opponent"
```

---

# Phase 3 — Interface

## Task 8: App shell and stylesheet

**Files:**
- Create: `index.html`, `src/style.css`, `src/analytics.js`
- Reference: `../chess.localhost:8443/index.html`, `../chess.localhost:8443/src/style.css`, `../chess.localhost:8443/src/analytics.js`

**Interfaces:**
- Produces: every element id `main.js` reaches for in Task 10, and the CSS custom properties the board uses.

Port the chess shell and stylesheet. Keep the structure, the comments, and the class names. Changes:

**`index.html`**
- All copy: "chess" → "checkers", and the description becomes "Play checkers for free, right in your browser. Challenge the computer, pass & play with a friend on one device, or invite a friend to a private online game."
- Canonical, `og:url`, JSON-LD `url` → `http://checkers.localhost:8443/`
- Settings key in the pre-paint theme script → `checkers-settings`
- **Delete** the entire `#promo-dialog` block
- `#moves-empty` copy → `No moves yet — Black begins.`
- `aria-label` on the board → `Checkers board`
- Leave the Plausible ````

- [ ] **Step 2: Port `customHttp.yml`**

Copy it across. The CSP is unchanged in substance — `js.localhost:8443` and `api.localhost:8443` for the SDK, `wss:` for peer signalling, inline styles allowed for the Puter consent dialog.

**Recompute the inline-script hashes** after building, since the theme script's text changed (`chess-settings` → `checkers-settings`) and the Plausible block changed:

```bash
npm run build
python3 -c "import re,hashlib,base64;[print('sha256-'+base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()) for s in re.findall(r'<script>(.*?)</script>',open('dist/index.html').read(),re.S)]"
```
Paste the results into `script-src`.

- [ ] **Step 3: Write the README**

Port the chess README's shape. Describe the ruleset (forced capture, crowning ends the turn, no-move loses), the engine and its perft validation, the AI, the `game/` modules, the dev commands, and — under a **Regenerating images** heading — the Playwright and sharp steps from Task 15, since neither is a project dependency.

- [ ] **Step 4: Verify the build**

Run: `npm run build && npm run preview`
Expected: a clean build, and the production bundle plays a full game against the computer with no console errors.

- [ ] **Step 5: Full check**

Run: `npm test`
Expected: every suite passes — geometry, position, moves, rules, perft, ai, chain, boardView, clock, persistence, pdn, online.

- [ ] **Step 6: Commit**

```bash
git add customHttp.yml README.md index.html
git commit -m "Add the deploy configuration and the README"
```

---

## Deferred to you

Two things this plan cannot finish:

1. **The Plausible script id** for checkers.localhost:8443. Task 16 ships a commented placeholder; paste the real id in when you have it, then recompute the CSP hashes.
2. **DNS and hosting** for checkers.localhost:8443. `customHttp.yml` is AWS Amplify's format, matching how the chess app is deployed.
