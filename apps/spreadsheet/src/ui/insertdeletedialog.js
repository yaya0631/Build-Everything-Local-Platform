/**
 * The Insert and Delete dialogs (Ctrl+Shift+= and Ctrl+- on part of a sheet): shift the cells
 * right or down (left or up), or take entire rows or columns. Each choice is the editor's own command.
 */
import { el, fieldId } from './dom.js';
import { openModal } from './modal.js';

export function openInsertDeleteDialog(ctx, kind) {
  const insert = kind === 'insert';
  const range = ctx.range();
  const name = fieldId(insert ? 'insert-cells' : 'delete-cells');
  // The default: a selection wider than it is tall shifts down (up), otherwise right (left).
  const wide = range.c2 - range.c1 > range.r2 - range.r1;
  const choices = insert
    ? [['right', 'Shift cells right', !wide], ['down', 'Shift cells down', wide], ['row', 'Entire row', false], ['col', 'Entire column', false]]
    : [['left', 'Shift cells left', !wide], ['up', 'Shift cells up', wide], ['row', 'Entire row', false], ['col', 'Entire column', false]];
  const radios = choices.map(([value, label, checked]) => el('label.check', {},
    el('input', { type: 'radio', name, value, checked }), el('span', {}, label)));
  const submit = (e) => {
    e.preventDefault();
    const value = content.querySelector(`input[name="${name}"]:checked`)?.value;
    modal.close();
    if (value === 'row') ctx.run(insert ? 'insertRows' : 'deleteRows', insert ? 'above' : undefined);
    else if (value === 'col') ctx.run(insert ? 'insertCols' : 'deleteCols', insert ? 'left' : undefined);
    else if (value) ctx.run(insert ? 'insertCells' : 'deleteCells', value);
  };
  const content = el('form.insert-delete-cells', { onsubmit: submit },
    el('fieldset.check-group.vertical', { role: 'radiogroup', 'aria-label': insert ? 'Insert' : 'Delete' }, ...radios),
    el('div.row.row-end', { style: { marginTop: '14px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK')));
  const modal = openModal({ title: insert ? 'Insert' : 'Delete', content, initialFocus: content.querySelector('input:checked'), onClose: () => ctx.grid.focus() });
  return modal;
}
