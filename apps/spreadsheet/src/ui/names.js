/**
 * Named ranges manager: list, add, edit, and delete the workbook's names.
 * Names can also be created from the name box; this is where they are
 * reviewed.
 */

import { el, clear, isComposing } from './dom.js';
import { tableRows } from '../core/tables.js';
import { icon } from './icons.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';

/** `define` opens the New Name dialog by itself, as Define Name does, without the review list behind it. */
export function openNamesManager(ctx, { define = false } = {}) {
  const PAGE_SIZE = 100;
  const list = el('div.names-list.names-review-scroll');
  const body = el('tbody');
  const header = el('tr');
  const tableView = el('table.names-review', { 'aria-label': 'Named ranges' }, el('thead', {}, header), body);
  const search = el('input.input', { type: 'search', 'aria-label': 'Search names', placeholder: 'Search names, scopes or references', autocomplete: 'off', spellcheck: false });
  const filter = el('select.select', { 'aria-label': 'Filter names' },
    ...[['all', 'All names'], ['sheet', 'Worksheet scope'], ['workbook', 'Workbook scope'], ['defined', 'Defined names'], ['table', 'Table names']].map(([value, label]) => el('option', { value }, label)),
    el('option', { disabled: true }, 'Names with errors (unavailable)'), el('option', { disabled: true }, 'Names without errors (unavailable)'));
  const summary = el('span.small.muted', { role: 'status' });
  let start = 0, sortKey = null, descending = false;
  const previous = el('button.btn.btn-ghost.btn-sm', { type: 'button', 'aria-label': 'Previous names page', onclick: () => { start = Math.max(0, start - PAGE_SIZE); render(); } }, 'Previous');
  const next = el('button.btn.btn-ghost.btn-sm', { type: 'button', 'aria-label': 'Next names page', onclick: () => { start += PAGE_SIZE; render(); } }, 'Next');
  const columns = [['name', 'Name'], ['value', 'Value preview'], ['ref', 'Refers to'], ['scope', 'Scope'], ['kind', 'Type']];
  for (const [key, label] of columns) header.append(el('th', { scope: 'col', dataset: { sort: key } },
    key === 'value' ? label : el('button', { type: 'button', 'aria-label': `Sort names by ${label}`, onclick: () => {
      descending = sortKey === key ? !descending : false; sortKey = key; start = 0; render();
    } }, label)));
  header.append(el('th', { scope: 'col' }, 'Actions'));
  list.append(tableView);
  search.addEventListener('input', () => { start = 0; render(); });
  filter.addEventListener('change', () => { start = 0; render(); });
  const nameInput = el('input.input', { type: 'text', placeholder: 'Name, e.g. Sales', 'aria-label': 'Name', autocomplete: 'off', spellcheck: false });
  const refInput = el('input.input', { type: 'text', placeholder: 'Sheet1!$A$1:$B$5  or  =LAMBDA(x, x*2)', 'aria-label': 'Refers to', autocomplete: 'off', spellcheck: false, value: ctx.wb.refTextFor(ctx.sheetId(), ctx.grid.range) || '' });
  const scopeInput = el('select.select', { 'aria-label': 'Scope' },
    el('option', { value: '' }, 'Workbook'),
    ...ctx.wb.sheets.map((sheet) => el('option', { value: sheet.name }, sheet.name)));
  // A name keeps its scope while it is edited: moved to a sheet, it would be gone from every
  // formula on the other sheets, and the rename that follows a new spelling cannot follow a move.
  const scopeHint = el('span.field-hint', { hidden: true }, 'Kept while editing. For another scope, save a new name and delete this one.');
  const { alert: error, refuse, clear: clearError } = fieldAlert('names');
  const saveBtn = el('button.btn.btn-primary', { type: 'submit' }, 'Save name');
  let editor = null;
  let editing = null; // the existing name the form is changing: { name, sheet }
  const stopEditing = () => {
    editing = null; saveBtn.textContent = 'Save name'; cancelEdit.hidden = true; scopeInput.disabled = false; scopeHint.hidden = true;
    if (editor) { editor.panel.setAttribute('aria-label', 'New Name'); editor.panel.querySelector('.modal-title').textContent = 'New Name'; }
  };
  const clearForm = () => { nameInput.value = ''; refInput.value = ''; scopeInput.value = ''; clearError(); };
  // A way out of editing that keeps the name as it was: typing a different spelling while editing
  // renames the name everywhere, where a new name may have been meant.
  const cancelEdit = el('button.btn.btn-ghost', { type: 'button', hidden: true, onclick: () => { stopEditing(); clearForm(); nameInput.focus(); } }, 'New name instead');
  // Clearing the name means starting over with a new one, not renaming the edited one to nothing.
  nameInput.addEventListener('input', () => { if (editing && !nameInput.value.trim()) stopEditing(); });

  // Previews read at most six cells of a literal, non-relative A1 reference.
  // Opening this manager must not start evaluating arbitrary named formulas.
  function preview(record) {
    if (record.kind === 'Defined name' && record.entry.relative) return '—';
    if (record.kind === 'Table' && !record.dataRange) return '{}';
    const ref = record.kind === 'Table' ? { ...record.dataRange, sheet: record.sheet.name } : ctx.wb.parseNamedRef(record.ref);
    if (ref && !ref.sheetEnd && !ref.spill) {
      const sheet = ctx.wb.sheetByName(ref.sheet);
      if (!sheet) return '#REF!';
      const r1 = ref.r1 ?? 0, c1 = ref.c1 ?? 0;
      const r2 = ref.r2 ?? sheet.rows - 1, c2 = ref.c2 ?? sheet.cols - 1;
      const values = [];
      for (let r = r1; r <= r2 && values.length < 6; r++) for (let c = c1; c <= c2 && values.length < 6; c++) values.push(ctx.wb.getDisplay(sheet.id, r, c));
      const more = (r2 - r1 + 1) * (c2 - c1 + 1) > values.length;
      return values.length === 1 && !more ? values[0] : `{${values.join('; ')}${more ? '; …' : ''}}`;
    }
    const text = record.ref.replace(/^=/, '').trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text))) return String(Number(text));
    if (/^(?:TRUE|FALSE|#REF!|#NAME\?|#VALUE!|#DIV\/0!|#N\/A|#NUM!|#NULL!)$/i.test(text)) return text.toUpperCase();
    if (/^"(?:[^"]|"")*"$/.test(text)) return text.slice(1, -1).replace(/""/g, '"');
    return '—';
  }

  function records() {
    const tables = ctx.wb.sheets.flatMap(sheet => (sheet.tables || []).map(table => {
      const rows = tableRows(table);
      const dataRange = rows.empty ? null : { ...table.range, r1: rows.dataStart, r2: rows.dataEnd };
      return { name: table.name, label: table.name, ref: ctx.wb.refTextFor(sheet.id, dataRange || table.range), scope: 'Workbook', kind: 'Table', sheet, table, dataRange };
    }));
    const names = ctx.wb.names.filter(n => !n.hidden).map(entry => ({ name: entry.name, label: ctx.wb.nameLabel(entry), ref: entry.ref, scope: entry.sheet || 'Workbook', kind: 'Defined name', entry }));
    const term = search.value.trim().toLocaleLowerCase();
    let rows = [...tables, ...names].filter(row => (filter.value !== 'sheet' || !!row.entry?.sheet)
      && (filter.value !== 'workbook' || !row.entry?.sheet) && (filter.value !== 'defined' || !!row.entry)
      && (filter.value !== 'table' || !!row.table) && (!term || [row.label, row.ref, row.scope, row.kind].some(value => value.toLocaleLowerCase().includes(term))));
    if (sortKey) rows = rows.sort((a, b) => a[sortKey].localeCompare(b[sortKey], undefined, { numeric: true, sensitivity: 'base' }) * (descending ? -1 : 1));
    return rows;
  }

  function focusAfterDelete(index) {
    const rows = body.querySelectorAll('tr');
    (rows[Math.min(index, rows.length - 1)]?.querySelector('[data-action="delete"]') || newButton).focus({ preventScroll: true });
  }

  function render() {
    clear(body);
    const rows = records();
    start = Math.min(start, Math.max(0, Math.floor((rows.length - 1) / PAGE_SIZE) * PAGE_SIZE));
    const shown = rows.slice(start, start + PAGE_SIZE);
    summary.textContent = rows.length ? `${start + 1}–${start + shown.length} of ${rows.length} names` : 'No matching names';
    previous.hidden = next.hidden = rows.length <= PAGE_SIZE;
    previous.disabled = start === 0; next.disabled = start + PAGE_SIZE >= rows.length;
    for (const th of header.children) {
      if (th.dataset.sort === sortKey) th.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
    }
    if (!rows.length) {
      body.append(el('tr', {}, el('td', { colSpan: 6 }, ctx.wb.names.some(n => !n.hidden) || ctx.wb.sheets.some(s => s.tables?.length)
        ? 'No names match these filters.' : 'No named ranges yet. Choose New name, or use the name box on the sheet.')));
      return;
    }
    shown.forEach((record, index) => {
      const { entry: n, table, sheet, label } = record;
      const go = el('button.names-main', { type: 'button', title: table ? 'Go to table' : 'Go to range', onclick: () => {
        modal.close(); ctx.run('goToName', table ? table.name : { name: n.name, sheet: n.sheet || null });
      } }, el('span.names-name', { dir: 'auto' }, label));
      const editButton = el('button.icon-btn', { type: 'button', html: icon('pencil', 16), 'aria-label': table ? `Edit table ${table.name}` : `Edit ${label}`, onclick: () => {
        if (table) { modal.close(); ctx.run('editTableById', { sheetId: sheet.id, id: table.id }); return; }
        openEditor(n);
      } });
      const remove = el('button.icon-btn', { type: 'button', html: icon('trash', 16), 'aria-label': table ? `Convert ${table.name} to a plain range` : `Delete ${label}`, dataset: { action: 'delete' }, onclick: () => {
        if (table) {
          if (ctx.wb.isProtected(sheet.id)) { toast(`${sheet.name} is protected. Unprotect it to convert ${table.name}`, { icon: 'lock' }); return; }
          ctx.wb.deleteTable(sheet.id, table.id); toast(`${table.name} is a plain range again`, { icon: 'table' });
        } else {
          ctx.wb.deleteName(n.name, n.sheet);
          if (editing && editing.name.toLowerCase() === n.name.toLowerCase() && editing.sheet === (n.sheet || null)) { stopEditing(); clearForm(); }
          toast(`Deleted ${label}`, { icon: 'trash' });
        }
        render(); focusAfterDelete(index);
      } });
      const value = preview(record);
      body.append(el('tr.names-review-row', {}, el('td', {}, go),
        el('td.names-value', { title: value === '—' ? 'Preview unavailable for this expression' : value }, value),
        el('td.names-ref', { title: record.ref }, record.ref), el('td', {}, el('span', { dir: 'auto' }, record.scope)),
        el('td', {}, record.kind), el('td.names-review-actions', {}, editButton, remove)));
      go.addEventListener('keydown', e => {
        if (isComposing(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
        const to = { ArrowDown: start + index + 1, ArrowUp: start + index - 1, Home: 0, End: rows.length - 1,
          PageDown: start + index + PAGE_SIZE, PageUp: start + index - PAGE_SIZE }[e.key];
        if (to == null) return;
        e.preventDefault(); e.stopPropagation();
        const target = Math.max(0, Math.min(rows.length - 1, to)); start = Math.floor(target / PAGE_SIZE) * PAGE_SIZE;
        render(); const button = body.querySelectorAll('.names-main')[target - start]; button?.focus({ preventScroll: true }); button?.scrollIntoView?.({ block: 'nearest' });
      });
    });
  }

  const submit = (e) => {
    e.preventDefault();
    if (!editor || editor.panel.closest('[inert]')) return;
    const name = nameInput.value;
    const ref = refInput.value.trim().replace(/^=/, '');
    const scope = editing ? editing.sheet : scopeInput.value || null; // an edited name stays in its scope
    let msg;
    // The workbook redefines an existing name given its spelling; adding one must not silently
    // retarget a name every formula already uses. The pencil edits it.
    const key = name.trim().toLowerCase();
    if (!editing && ctx.wb.names.some((n) => (n.sheet || null) === scope && n.name.toLowerCase() === key)) {
      return refuse(nameInput, 'That name is already used. Edit it from the list to change what it refers to');
    }
    // The workbook judges the spelling before the reference: a message about the name (or about a formula
    // that binds the new spelling as a variable) belongs to the Name field, any other to Refers to.
    const nameProblem = ctx.wb.validateName(name, editing ? editing.name : null, { sheet: scope });
    // Editing keeps one name: a new spelling renames it everywhere instead of adding a second one.
    if (editing) msg = ctx.wb.renameName(editing.name, editing.sheet, name, ref);
    else msg = ctx.wb.defineName(name, ref, scope);
    if (msg) return refuse(msg === nameProblem || /LET or LAMBDA/.test(msg) ? nameInput : refInput, msg);
    clearError();
    toast(`Saved ${name.trim()}`); // the workbook takes the spelling as typed, a change of case included
    const edited = !!editing, savedLabel = ctx.wb.nameLabel(ctx.wb.namedEntry(name.trim(), scope)).toLowerCase();
    editor.close();
    render();
    const row = [...body.children].find(row => row.querySelector('.names-name')?.textContent.toLowerCase() === savedLabel);
    (edited && row?.querySelector('[aria-label^="Edit "]') || newButton).focus({ preventScroll: true });
  };

  // Keep the review list intact while the existing form is in a child dialog. Filters, sort and
  // pagination survive both cancellation and saving; the shared modal stack traps focus in the editor.
  const form = el('form.names-form', { onsubmit: submit },
    el('div.names-editor-fields', {},
      el('label.field', {}, el('span.field-label', {}, 'Name'), nameInput),
      el('label.field', {}, el('span.field-label', {}, 'Scope'), scopeInput, scopeHint),
      el('label.field', {}, el('span.field-label', {}, 'Comment'),
        el('textarea.input', { disabled: true, rows: 3, 'aria-label': 'Name comment', placeholder: 'Name comments are unavailable' })),
      el('label.field', {}, el('span.field-label', {}, 'Refers to'),
        el('div.names-editor-reference', {}, refInput,
          el('button.icon-btn', { type: 'button', disabled: true, html: icon('table', 16), 'aria-label': 'Choose a range (unavailable)', title: 'Range picking is unavailable; type the reference instead' })))),
    error,
    el('div.row.row-end.names-editor-footer', {}, cancelEdit,
      el('button.btn.btn-ghost', { type: 'button', onclick: () => editor?.close() }, 'Cancel'), saveBtn));

  function openEditor(entry = null) {
    editor?.close(); stopEditing(); clearForm();
    if (entry) {
      editing = { name: entry.name, sheet: entry.sheet || null };
      saveBtn.textContent = 'Save changes'; cancelEdit.hidden = false;
      nameInput.value = entry.name; refInput.value = entry.ref; scopeInput.value = entry.sheet || '';
      scopeInput.disabled = true; scopeHint.hidden = false;
    } else refInput.value = ctx.wb.refTextFor(ctx.sheetId(), ctx.grid.range) || '';
    editor = openModal({ title: entry ? 'Edit Name' : 'New Name', content: form, className: 'names-editor', initialFocus: nameInput,
      onClose: () => { editor = null; stopEditing(); clearForm(); if (define) ctx.grid?.focus?.(); } });
    if (entry && matchMedia('(min-width: 640px)').matches) nameInput.select();
  }

  const newButton = el('button.btn', { type: 'button', 'aria-label': 'New name', onclick: () => openEditor() }, 'New name');
  const content = el('div', {},
    el('div.names-review-tools', {}, newButton, search, el('div.select-wrap', {}, filter)),
    el('div.row.names-review-pages', {}, summary, previous, next), list,
    el('p.field-hint', {}, 'Value previews show constants or up to six cells of a direct range. Formula previews and error filters are unavailable.'),
    el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Close')));
  if (define) { openEditor(); return; }
  const modal = openModal({ title: 'Name Manager', content, wide: true, className: 'names-manager', initialFocus: newButton,
    onClose: () => { editor?.close(); ctx.grid?.focus?.(); } });
  render();
}
