/**
 * A calendar popover for date cells: Alt+Down or a double-click on a cell
 * formatted as a date opens it; picking a day writes the date (keeping any
 * time part) in one undo step.
 */

import { el } from './dom.js';
import { openMenu } from './menu.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { cellName } from '../core/cell.js';
import { todaySerial, dateTimeKind, ymdToSerial, serialToYMD } from '../core/format.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
// The days a date cell can show (format.js formatDate prints ##### outside them):
// from the calendar's day zero to the last day of 9999.
const FIRST_SERIAL = 0;
const LAST_SERIAL = ymdToSerial(9999, 12, 31);
const clampSerial = (serial) => Math.min(LAST_SERIAL, Math.max(FIRST_SERIAL, serial));

export function serialToParts(serial) {
  const { y, m, d } = serialToYMD(serial);
  return { y, m, d };
}

export function partsToSerial(y, m, d) {
  return ymdToSerial(y, m, d);
}

/** Six Monday-first weeks in the workbook calendar, including February 1900. */
export function calendarDays(y, m) {
  const first = partsToSerial(y, m, 1);
  const offset = (serialToYMD(first).weekday + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => {
    const day = serialToParts(first - offset + i);
    return { ...day, other: day.m !== m };
  });
}

export function openDatePicker(ctx, r, c) {
  const wb = ctx.wb;
  const sheetId = ctx.sheetId();
  // A protected cell takes no date; say so instead of opening a picker whose choice would vanish.
  if (wb.lockedAt?.(sheetId, r, c)) {
    toast(`${cellName(r, c)} is protected. Unprotect it to pick a date`, { icon: 'lock' });
    return null;
  }
  const value = wb.getValue(sheetId, r, c);
  // Finite spreadsheet numbers can still lie outside JavaScript's calendar.
  // Start at today in that case, and leave the original value until a pick.
  const current = typeof value === 'number' && Number.isFinite(value)
    && Number.isFinite(serialToParts(Math.floor(value)).y) ? Math.floor(value) : null;
  const frac = current != null ? value - current : 0;
  const today = todaySerial();
  // A cell holding a serial the sheet shows as ##### opens on the nearest day it can show.
  let focused = clampSerial(current ?? today);
  let { y, m } = serialToParts(focused);
  const body = el('div.datepicker', { role: 'group', 'aria-label': 'Calendar' });
  const error = el('p.field-error', { hidden: true, role: 'alert' });
  let menu = null;

  const focusDay = () => body.querySelector(`[data-serial="${focused}"]`)?.focus();
  const moveDay = (serial) => {
    focused = clampSerial(serial);
    ({ y, m } = serialToParts(focused));
    render();
    focusDay();
  };
  const moveMonth = (delta, control = null) => {
    const day = serialToParts(focused).d;
    const first = serialToParts(partsToSerial(y, m + delta, 1));
    const last = serialToParts(partsToSerial(first.y, first.m + 1, 1) - 1).d;
    // A month past the calendar's edge stops at the edge day, in its month.
    // January zero has no same-numbered day in another month. Month
    // navigation lands on its first day instead of returning to the old month.
    focused = clampSerial(partsToSerial(first.y, first.m, Math.max(1, Math.min(day, last))));
    ({ y, m } = serialToParts(focused));
    render();
    if (control) body.querySelector(`[aria-label="${control}"]`)?.focus();
    else focusDay();
  };

  const allowed = (value) => {
    const verdict = wb.validateValue(sheetId, r, c, value);
    if (!verdict.ok && verdict.rule?.strict !== false) {
      error.textContent = verdict.message || 'This date does not meet the cell’s validation rule.';
      error.hidden = false;
      return false;
    }
    return true;
  };
  const pick = (serial) => {
    if (serial < FIRST_SERIAL || serial > LAST_SERIAL || !allowed(serial + frac)) return;
    menu?.close();
    const prev = wb.getCell(sheetId, r, c);
    const kind = dateTimeKind(prev?.s, value);
    const fmt = prev?.s?.fmt === 'custom' && (kind === 'date' || kind === 'datetime') ? 'custom' : kind === 'datetime' ? 'datetime' : 'date';
    wb.setInput(sheetId, r, c, serial + frac, { literal: true, style: { fmt }, label: 'Pick date' });
    ctx.grid.focus();
  };
  const render = () => {
    const days = calendarDays(y, m);
    body.replaceChildren(
      el('div.dp-head', {},
        el('button.icon-btn', { type: 'button', html: icon('chevL', 16), 'aria-label': 'Previous month', disabled: partsToSerial(y, m, 1) <= FIRST_SERIAL + 1, onclick: () => moveMonth(-1, 'Previous month') }),
        el('span.dp-title', { 'aria-live': 'polite' }, `${MONTHS[m - 1]} ${y}`),
        el('button.icon-btn', { type: 'button', html: icon('chevR', 16), 'aria-label': 'Next month', disabled: partsToSerial(y, m + 1, 1) > LAST_SERIAL, onclick: () => moveMonth(1, 'Next month') })),
      el('div.dp-grid', {},
        ...WEEKDAYS.map((w) => el('span.dp-wd', { 'aria-hidden': 'true' }, w)),
        ...days.map((day) => {
          const serial = partsToSerial(day.y, day.m, day.d);
          return el('button.dp-day', {
            type: 'button', tabindex: -1, dataset: { serial }, disabled: serial < FIRST_SERIAL || serial > LAST_SERIAL,
            className: `dp-day${day.other ? ' other' : ''}${serial === today ? ' today' : ''}${serial === current ? ' selected' : ''}`,
            'aria-label': `${day.d} ${MONTHS[day.m - 1]} ${day.y}`, 'aria-pressed': String(serial === current),
            onfocus: () => { focused = serial; },
            onclick: () => pick(serial),
          }, String(day.d));
        })),
      el('div.dp-foot', {},
        el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => pick(today) }, 'Today'),
        current != null && el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { if (!allowed(null)) return; menu.close(); wb.setInput(sheetId, r, c, ''); ctx.grid.focus(); } }, 'Clear')),
      error);
  };
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') return;
    e.stopPropagation();
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (Object.hasOwn(offsets, e.key)) { e.preventDefault(); moveDay(focused + offsets[e.key]); }
    else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const weekday = (serialToYMD(focused).weekday + 6) % 7;
      moveDay(focused - weekday + (e.key === 'End' ? 6 : 0));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      moveMonth((e.key === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1));
    }
  });
  const rect = ctx.grid.cellRect(r, c);
  const anchor = { getBoundingClientRect: () => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }), setAttribute() {} };
  // The calendar is laid out before the menu opens, so the menu measures its real height
  // when deciding whether to sit below the cell or flip above it.
  render();
  menu = openMenu({ anchor, label: 'Pick a date', minWidth: 252, items: [{ custom: body }], onClose: () => ctx.grid.focus() });
  setTimeout(focusDay, 0);
  return menu;
}
