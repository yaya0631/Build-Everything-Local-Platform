import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';

export function openScrollDialog(ctx, control) {
  const inputs = {}, content = el('form'), { alert, refuse } = fieldAlert('scroll');
  const add = (key, label, type = 'text') => {
    const input = inputs[key] = el('input.input', { type, value: String(control[key] ?? ''), 'aria-label': label,
      ...(type === 'number' ? { min: 0, max: 30000, step: 1, required: true } : {}) });
    content.append(el('label.field', {}, el('span.field-label', {}, label), input));
  };
  add('title', 'Name'); add('linkRef', 'Linked cell');
  for (const [key, label] of [['min', 'Minimum'], ['max', 'Maximum'], ['step', 'Arrow increment'], ['page', 'Page increment']]) add(key, label, 'number');
  for (const [key, label] of [['horizontal', 'Horizontal'], ['print', 'Print control']]) {
    inputs[key] = el('input', { type: 'checkbox', checked: control[key] });
    content.append(el('label.check', {}, inputs[key], el('span', {}, label)));
  }
  content.append(alert, el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'Save')));
  content.addEventListener('submit', e => {
    e.preventDefault();
    const patch = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim()]));
    const target = patch.linkRef && ctx.wb.rangeFromText(ctx.sheetId(), patch.linkRef);
    if (patch.max < patch.min) { refuse(inputs.max, 'Maximum must be at least the minimum.'); return; }
    if (patch.linkRef && (!target || target.range.r1 !== target.range.r2 || target.range.c1 !== target.range.c2)) { refuse(inputs.linkRef, 'Choose a single linked cell, or leave the link blank.'); return; }
    ctx.wb.updateChart(ctx.sheetId(), control.id, patch, 'Edit scroll bar'); modal.close();
  });
  const modal = openModal({ title: 'Edit scroll bar', content, initialFocus: inputs.title, onClose: () => ctx.grid.focus() });
  return modal;
}
