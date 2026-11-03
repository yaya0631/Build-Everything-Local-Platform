/**
 * Insert Timelines (a choice of the PivotTable's date fields) and Timeline Settings (caption and
 * which parts show), the two dialogs of a timeline.
 */
import { el, fieldId } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { insertTimeline, pivotDateFields } from '../core/timeline.js';
import { decodeXlsxString } from '../core/xlsx-string.js';

export function openInsertTimelineDialog(ctx, pivot) {
  const { wb } = ctx;
  const sheetId = ctx.sheetId();
  const fields = pivotDateFields(wb, pivot);
  if (!fields.length) {
    toast(`PivotTable ${decodeXlsxString(pivot.name)} has no field of dates to build a timeline from`, { icon: 'info', duration: 3200 });
    return null;
  }
  const { alert, refuse } = fieldAlert('timeline');
  const boxes = fields.map((field, i) => {
    const id = fieldId('timeline-field');
    const input = el('input', { type: 'checkbox', id, checked: fields.length === 1 && i === 0 });
    return { field, input, node: el('label.find-option', { for: id }, input, el('span', {}, field.name)) };
  });
  const submit = e => {
    e?.preventDefault();
    const chosen = boxes.filter(b => b.input.checked);
    if (!chosen.length) { modal.close(); return; }
    const ids = [];
    try { wb.transaction('Insert timeline', () => { for (const b of chosen) ids.push(insertTimeline(wb, sheetId, pivot, b.field.index)); }); }
    catch (error) { refuse(null, error.message || 'The timeline could not be inserted.'); return; }
    modal.close();
    if (ids.length) {
      ctx.grid.selectChart?.(ids.at(-1));
      toast('Timeline inserted. Click a period, or drag across several, to filter the PivotTable', { icon: 'timeline', duration: 2800 });
    }
  };
  const content = el('form', { onsubmit: submit },
    el('p.small.muted', {}, `Choose the date fields of PivotTable ${decodeXlsxString(pivot.name)} to filter with a timeline.`),
    el('div.field', { role: 'group', 'aria-label': 'Date fields' }, el('div.dedupe-cols', {}, ...boxes.map(b => b.node))),
    alert,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: 'Insert Timelines', content, initialFocus: boxes[0].input, onClose: () => ctx.grid.focus() });
  return modal;
}

export function openTimelineSettingsDialog(ctx, control) {
  const { wb } = ctx;
  const caption = el('input.input', { type: 'text', value: control.title || '', 'aria-label': 'Caption' });
  const checks = [['showHeader', 'Header'], ['showSelectionLabel', 'Selection label'], ['showTimeLevel', 'Time level'], ['showHorizontalScrollbar', 'Scrollbar'], ['lockedPosition', 'Lock position'], ['print', 'Print timeline']]
    .map(([key, label]) => ({ key, input: el('input', { type: 'checkbox', checked: key === 'lockedPosition' ? !!control[key] : control[key] !== false }), label }));
  const submit = e => {
    e?.preventDefault();
    wb.updateChart(ctx.sheetId(), control.id, { title: caption.value, ...Object.fromEntries(checks.map(c => [c.key, c.input.checked])) }, 'Edit timeline');
    modal.close();
  };
  const content = el('form', { onsubmit: submit },
    el('label.field', {}, el('span.field-label', {}, 'Caption'), caption),
    el('div.field', {}, el('span.field-label', {}, 'Show'), ...checks.map(c => el('label.check', {}, c.input, el('span', {}, c.label)))),
    el('p.field-hint', {}, `Filters PivotTable ${decodeXlsxString(control.report.name)} by ${control.field}.`),
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'Save')));
  const modal = openModal({ title: 'Timeline Settings', content, initialFocus: caption, onClose: () => ctx.grid.focus() });
  return modal;
}
