/**
 * Watch Window (Formulas ▸ Watch Window): a floating panel listing watched cells with their sheet, name,
 * cell, value and formula, kept current as the workbook changes. Add Watch takes the selected cells;
 * Delete Watch removes the chosen rows; a double-click goes to the cell.
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { cellName } from '../core/cell.js';
import { parseRefText } from '../core/refs.js';

export function createWatchWindow(ctx) {
  let chosen = new Set();
  const body = el('tbody');
  const table = el('table.watch-table', {},
    el('thead', {}, el('tr', {}, ...['Book', 'Sheet', 'Name', 'Cell', 'Value', 'Formula'].map((h) => el('th', { scope: 'col' }, h)))), body);
  const addBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => ctx.run('addWatch') }, el('span', { html: icon('watch', 16) }), el('span', {}, 'Add Watch…'));
  const deleteBtn = el('button.btn.btn-sm', { type: 'button', onclick: () => {
    ctx.wb.removeWatches(ctx.wb.watches.filter((w) => chosen.has(key(w))));
    chosen = new Set();
  } }, 'Delete Watch');
  const close = el('button.icon-btn', { type: 'button', 'aria-label': 'Close Watch Window', html: icon('x', 16), onclick: () => api.hide() });
  const head = el('div.watch-head', {}, el('span.watch-title', {}, 'Watch Window'), close);
  const root = el('section.watch-window', { role: 'region', 'aria-label': 'Watch Window', hidden: true },
    head, el('div.watch-actions', {}, addBtn, deleteBtn), el('div.watch-scroll', {}, table));
  const key = (w) => `${w.sheetId}|${w.r}|${w.c}`;
  const nameOf = (sheet, r, c) => {
    for (const n of ctx.wb.names || []) {
      if (n.hidden) continue;
      const ref = parseRefText(String(n.ref || '').replace(/^=/, ''));
      if (ref && (ref.sheet || sheet.name) === sheet.name && ref.r1 === r && ref.c1 === c && ref.r2 === r && ref.c2 === c) return n.name;
    }
    return '';
  };
  function render() {
    if (root.hidden) return;
    const book = ctx.docName?.() || '';
    body.replaceChildren(...ctx.wb.watches.map((w) => {
      const sheet = ctx.wb.sheet(w.sheetId);
      if (!sheet) return null;
      const cell = ctx.wb.getCell(w.sheetId, w.r, w.c);
      const row = el('tr', { tabindex: 0, 'aria-selected': String(chosen.has(key(w))),
        onclick: (e) => { if (!(e.metaKey || e.ctrlKey)) chosen = new Set(); chosen.add(key(w)); render(); },
        ondblclick: () => ctx.goTo(sheet.id, w.r, w.c) },
        el('td', {}, book), el('td', {}, sheet.name), el('td', {}, nameOf(sheet, w.r, w.c)), el('td', {}, cellName(w.r, w.c)),
        el('td', {}, ctx.wb.getDisplay(w.sheetId, w.r, w.c)), el('td.mono', {}, cell?.f != null && !ctx.wb.formulaHiddenAt?.(w.sheetId, w.r, w.c) ? `=${cell.f}` : ''));
      return row;
    }).filter(Boolean));
    deleteBtn.disabled = !chosen.size;
  }
  // The window moves by its title bar, kept inside the page.
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const start = { x: e.clientX, y: e.clientY, left: root.offsetLeft, top: root.offsetTop };
    const move = (ev) => {
      root.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, start.left + ev.clientX - start.x))}px`;
      root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, start.top + ev.clientY - start.y))}px`;
      root.style.right = 'auto'; root.style.bottom = 'auto';
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  const unsubscribe = ctx.subscribe(render);
  const api = {
    el: root,
    get open() { return !root.hidden; },
    show() { root.hidden = false; render(); },
    hide() { root.hidden = true; ctx.grid.focus(); },
    toggle() { if (root.hidden) api.show(); else api.hide(); },
    destroy() { unsubscribe(); root.remove(); },
  };
  return api;
}
