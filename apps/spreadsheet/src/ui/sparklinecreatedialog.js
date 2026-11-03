import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { rangeName } from '../core/cell.js';

export function openSparklineCreateDialog(ctx, { type = null } = {}) {
  const sheetId = ctx.sheetId(), inputs = {};
  const content = el('form', { noValidate: true }), { alert, refuse } = fieldAlert('sparkline-create');
  const field = (key, label, value, choices) => {
    const input = choices ? el('select.select', { 'aria-label': label }, choices.map(([value, text]) => el('option', { value }, text)))
      : el('input.input', { type: 'text', 'aria-label': label, autocomplete: 'off' });
    input.value = value; inputs[key] = input;
    content.append(el('label.field', {}, el('span.field-label', {}, label), input));
  };
  field('source', 'Data range', '');
  field('location', 'Destination range', rangeName(ctx.range()));
  field('type', 'Chart type', ['line', 'column', 'stacked'].includes(type) ? type : 'line', [['line', 'Line'], ['column', 'Column'], ['stacked', 'Win/loss']]);
  field('orientation', 'One sparkline per', 'auto', [['auto', 'Automatic'], ['rows', 'Data row'], ['columns', 'Data column']]);
  content.append(el('p.small.muted', {}, 'Choose one destination cell for each data row or column. Cell values stay in place. You can change colors and axes in Format → Sparkline settings.'));
  content.append(alert, el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'Create')));
  content.addEventListener('submit', event => {
    event.preventDefault();
    const error = ctx.wb.createNativeSparklines(sheetId, Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value])));
    if (error) return refuse(inputs[error.field], error.message);
    modal.close();
  });
  const modal = openModal({ title: 'Create sparklines', content, initialFocus: inputs.source, onClose: () => ctx.grid.focus() });
  return modal;
}
