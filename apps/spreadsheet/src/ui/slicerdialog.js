import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';

export function openSlicerDialog(ctx, control) {
  const form = el('form'), { alert, refuse } = fieldAlert('slicer'), inputs = {};
  for (const [key, label, type, value] of [['title', 'Caption', 'text', control.title], ['columnCount', 'Columns', 'number', control.columnCount], ['rowHeight', 'Item height (pixels)', 'number', control.rowHeight / 9525]]) {
    const input = inputs[key] = el('input.input', { type, value: String(value), 'aria-label': label, ...(type === 'number' ? { min: key === 'columnCount' ? 1 : 0, step: key === 'columnCount' ? 1 : 'any', required: true } : {}) });
    form.append(el('label.field', {}, el('span.field-label', {}, label), input));
  }
  for (const [key, label] of [['showCaption', 'Show caption'], ['lockedPosition', 'Lock position'], ['print', 'Print slicer'], ['hideItemsWithNoData', 'Hide items with no data']]) {
    if (key === 'hideItemsWithNoData' && control.pivotCache != null) continue; // Native visibility belongs to the shared cache.
    const input = inputs[key] = el('input', { type: 'checkbox', checked: control[key] });
    form.append(el('label.check', {}, input, el('span', {}, label)));
  }
  form.append(alert, el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'Save')));
  form.addEventListener('submit', event => {
    event.preventDefault(); const columns = Number(inputs.columnCount.value), height = Number(inputs.rowHeight.value);
    if (!Number.isInteger(columns) || columns < 1 || columns > 20000) { refuse(inputs.columnCount, 'Enter a whole number of columns from 1 to 20,000.'); return; }
    if (!Number.isFinite(height) || height < 0 || height * 9525 > 4294967295) { refuse(inputs.rowHeight, 'Enter an item height of 0 pixels or more.'); return; }
    ctx.wb.updateChart(ctx.sheetId(), control.id, { title: inputs.title.value, columnCount: columns, rowHeight: Math.round(height * 9525), showCaption: inputs.showCaption.checked, lockedPosition: inputs.lockedPosition.checked, print: inputs.print.checked,
      ...(inputs.hideItemsWithNoData ? { hideItemsWithNoData: inputs.hideItemsWithNoData.checked } : {}) }, 'Edit slicer');
    modal.close();
  });
  const modal = openModal({ title: 'Edit slicer', content: form, initialFocus: inputs.title, onClose: () => ctx.grid.focus() }); return modal;
}
