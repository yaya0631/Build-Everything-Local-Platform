/**
 * Column stats: a quick profile of one column — counts, sum and average,
 * spread, the most frequent values, and a small distribution.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { colName } from '../core/cell.js';
import { formatGeneral, formatValue, dateTimeKind } from '../core/format.js';
import { columnStats } from '../core/stats.js';
import { looksLikeHeader } from './sortdialog.js';

export function openColumnStats(ctx, col) {
  const sheetId = ctx.sheetId();
  const wb = ctx.wb;
  const sheet = wb.sheet(sheetId);
  const used = wb.usedRange(sheetId);
  if (!used) return null;
  const body = el('div.colstats');
  let c = Math.max(used.c1, Math.min(used.c2, col));
  // The date or time style most of the column's numbers carry, if any: its
  // summary then reads as dates, as the cells do, not as their serial numbers.
  const dateStyleOf = (range) => {
    const kinds = new Map();
    for (let r = range.r1; r <= range.r2; r++) {
      const cell = wb.getCell(sheetId, r, c);
      if (!cell || (cell.v == null && cell.f == null)) continue;
      const v = cell.f != null ? wb.getValue(sheetId, r, c) : cell.v;
      if (typeof v !== 'number') continue;
      const kind = dateTimeKind(cell.s, v);
      const entry = kinds.get(kind) || { count: 0, style: cell.s };
      entry.count++;
      kinds.set(kind, entry);
    }
    let best = null;
    for (const [kind, entry] of kinds) if (!best || entry.count > best.entry.count) best = { kind, entry };
    return best?.kind ? { kind: best.kind, style: best.entry.style } : null;
  };
  const render = (focusLabel = null) => {
    const wholeUsed = { r1: used.r1, c1: c, r2: used.r2, c2: c };
    const header = looksLikeHeader(wb, sheetId, { r1: used.r1, c1: used.c1, r2: used.r2, c2: used.c2 });
    const range = header ? { ...wholeUsed, r1: used.r1 + 1 } : wholeUsed;
    const title = header ? wb.getDisplay(sheetId, used.r1, c) : '';
    const s = columnStats(wb, sheetId, c, range);
    const dated = s.numbers ? dateStyleOf(range) : null;
    const fmt = (n) => (n == null ? '–' : dated ? formatValue(n, dated.style) : formatGeneral(n));
    // Dates do not add up; the distance between two of them is a number of days.
    const spread = dated && dated.kind !== 'time' ? `${formatGeneral(s.max - s.min)} days` : fmt(s.max - s.min);
    const stat = (label, value) => el('div.stat', {}, el('span.stat-label', {}, label), el('span.stat-value', {}, value));
    const maxCount = Math.max(1, ...s.top.map((t) => t.count));
    const maxBucket = Math.max(1, ...s.buckets.map((b) => b.count));
    const bucketText = (b) => `${fmt(b.from)} – ${fmt(b.to)}: ${b.count}`;
    body.replaceChildren(...[
      el('div.colstats-head', {},
        el('button.icon-btn', { type: 'button', html: icon('chevL', 16), 'aria-label': 'Previous column', disabled: c <= used.c1, onclick: () => { c--; render('Previous column'); } }),
        el('div.colstats-title', {}, el('strong', {}, `Column ${colName(c)}`), title ? el('span.muted', {}, ` · ${title}`) : null),
        el('button.icon-btn', { type: 'button', html: icon('chevR', 16), 'aria-label': 'Next column', disabled: c >= used.c2, onclick: () => { c++; render('Next column'); } })),
      el('div.stat-grid', {},
        stat('Filled', String(s.count)), stat('Empty', String(s.empty)), stat('Unique', String(s.unique)),
        stat('Numbers', String(s.numbers)), stat('Text', String(s.textCount)), stat('Errors', String(s.errors))),
      s.numbers ? el('div.stat-grid', {},
        dated ? null : stat('Sum', fmt(s.sum)), stat('Average', fmt(s.avg)), stat('Median', fmt(s.median)),
        stat('Min', fmt(s.min)), stat('Max', fmt(s.max)), stat('Range', spread)) : null,
      s.buckets.length ? el('div.field', {}, el('span.field-label', {}, 'Distribution'),
        // The bars are a picture; its words are the buckets, as the tooltips give them.
        el('div.hist', { role: 'img', 'aria-label': `Distribution: ${s.buckets.map(bucketText).join(', ')}` }, ...s.buckets.map((b) => el('div.hist-bar', { title: bucketText(b), style: { height: `${Math.max(2, (b.count / maxBucket) * 100)}%` } }))),
        el('div.hist-axis', {}, el('span', {}, fmt(s.buckets[0].from)), el('span', {}, fmt(s.buckets[s.buckets.length - 1].to)))) : null,
      s.top.length ? el('div.field', {}, el('span.field-label', {}, 'Most frequent'),
        el('div.freq', {}, ...s.top.map((t) => el('div.freq-row', {},
          el('span.freq-value', { title: t.value }, t.value),
          el('span.freq-bar', {}, el('span.freq-fill', { style: { width: `${(t.count / maxCount) * 100}%` } })),
          el('span.freq-count', {}, String(t.count)))))) : el('p.small.muted', {}, 'This column is empty.'),
      el('p.small.muted', {}, `${range.r2 - range.r1 + 1} rows${header ? ' below the header' : ''} on ${sheet.name}.`),
    ].filter(Boolean));
    if (focusLabel) {
      const target = body.querySelector(`button[aria-label="${focusLabel}"]:not(:disabled)`)
        || body.querySelector('.colstats-head button:not(:disabled)');
      target?.focus({ preventScroll: true });
    }
  };
  render();
  return openModal({ title: 'Column stats', content: body, onClose: () => ctx.grid?.focus?.() });
}
