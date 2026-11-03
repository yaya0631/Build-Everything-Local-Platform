import { el } from './dom.js';
import { openModal, fieldAlert } from './modal.js';
import { toast } from './toast.js';
import { cellName } from '../core/cell.js';
import { nativeSparklineAt, nativeSparklineLocation, nativeSparklineColorValues, nativeSparklineDateMismatch } from '../core/native-sparkline-data.js';
import { effectiveColorPalette } from '../core/font-color.js';

export function openSparklineDialog(ctx) {
  const sheetId = ctx.sheetId(), { r, c } = ctx.active(), ref = cellName(r, c);
  const found = nativeSparklineAt(ctx.wb, sheetId, r, c);
  if (!found) { toast('Select a cell containing a sparkline', { icon: 'info' }); return null; }
  const { group, spark } = found, inputs = {}, originals = {}, colors = {};
  const content = el('form.sparkline-settings', { noValidate: true }), { alert, refuse: showError } = fieldAlert('sparkline');
  const refuse = (field, message) => {
    for (let details = field?.closest('details'); details; details = details.parentElement?.closest('details')) details.open = true;
    return showError(field, message);
  };
  const field = (parent, key, label, value, choices = null, attrs = {}) => {
    const input = choices ? el('select.select', { 'aria-label': label }, choices.map(([value, text]) => el('option', { value }, text)))
      : el('input.input', { type: 'text', 'aria-label': label, autocomplete: 'off', ...attrs });
    input.value = value ?? ''; inputs[key] = input; originals[key] = input.value;
    parent.append(el('label.field', {}, el('span.field-label', {}, label), input));
    return input;
  };
  const check = (parent, key, label) => {
    const input = inputs[key] = el('input', { type: 'checkbox', checked: group[key], 'aria-label': label });
    originals[key] = input.checked; parent.append(el('label.check', {}, input, el('span', {}, label)));
    return input;
  };
  const section = title => { const body = el('div.sparkline-options'); content.append(el('details', {}, el('summary', {}, title), body)); return body; };
  field(content, 'formula', `Data range for ${ref}`, spark.formula);
  content.append(el('p.small.muted', {}, group.sparklines.length === 1 ? `These settings apply only to ${ref}.` : `Appearance and axes apply to all ${group.sparklines.length} sparklines in this group. The data range above applies only to ${ref}.`));
  const main = el('div.sparkline-fields'); content.append(main);
  field(main, 'type', 'Chart type', group.type, [['line', 'Line'], ['column', 'Column'], ['stacked', 'Win/loss']]);
  field(main, 'lineWeight', 'Line weight (pt)', group.lineWeight, null, { type: 'number', min: 0, max: 1584, step: 'any', required: true });
  field(content, 'displayEmptyCellsAs', 'Empty cells', group.displayEmptyCellsAs, [['gap', 'Gaps'], ['zero', 'Zero'], ['span', 'Connect data points']]);
  check(content, 'displayHidden', 'Include hidden rows and columns');
  const axes = section('Axes'), limits = el('div.sparkline-fields'); axes.append(limits);
  for (const [mode, bound, label] of [['minAxisType', 'manualMin', 'Minimum'], ['maxAxisType', 'manualMax', 'Maximum']]) {
    const select = field(limits, mode, `${label} scale`, group[mode], [['individual', 'Each sparkline'], ['group', 'Same for group'], ['custom', 'Custom']]);
    const number = field(limits, bound, `${label} value`, group[bound], null, { type: 'number', step: 'any' });
    const sync = () => { number.disabled = select.value !== 'custom'; number.required = !number.disabled; };
    select.addEventListener('change', sync); sync();
  }
  check(axes, 'displayXAxis', 'Show horizontal axis'); check(axes, 'rightToLeft', 'Plot right to left');
  const dateAxis = check(axes, 'dateAxis', 'Use a date axis');
  const dates = field(axes, 'dateFormula', 'Date range for the group', group.dateFormula);
  const syncDates = () => { dates.disabled = !dateAxis.checked; }; dateAxis.addEventListener('change', syncDates); syncDates();
  const markers = section('Markers and colors'), points = el('div.sparkline-fields'); markers.append(points);
  for (const [key, label] of [['markers', 'All markers (line)'], ['high', 'Highest points'], ['low', 'Lowest points'], ['negative', 'Negative points'], ['first', 'First points'], ['last', 'Last points']]) check(points, key, label);
  const paints = nativeSparklineColorValues(group, effectiveColorPalette(ctx.wb.colorPalette)), colorFields = el('div.sparkline-fields'); markers.append(colorFields);
  for (const [key, label] of [['Series', 'Series'], ['Axis', 'Axis'], ['Markers', 'Markers'], ['High', 'Highest points'], ['Low', 'Lowest points'], ['Negative', 'Negative points'], ['First', 'First points'], ['Last', 'Last points']]) {
    const input = field(colorFields, `color${key}`, `${label} color`, paints[key.toLowerCase()], null, { type: 'color', className: 'chart-color-input' });
    // Untouched theme/indexed colors and tints retain their original meaning.
    input.addEventListener('input', () => {
      if (input.value === originals[`color${key}`]) delete colors[`color${key}`];
      else colors[`color${key}`] = { rgb: `FF${input.value.slice(1).toUpperCase()}` };
    });
  }
  content.append(alert, el('div.row.row-end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'Save')));
  const validRange = input => {
    const location = nativeSparklineLocation(ctx.wb, sheetId, input.value.trim(), { r, c });
    return location && !location.sheetEnd && ctx.wb.sheetByName(location.sheet) && (location.r1 === location.r2 || location.c1 === location.c2) ? location : null;
  };
  content.addEventListener('submit', event => {
    event.preventDefault();
    for (const input of Object.values(inputs)) if (input.type === 'number' && !input.disabled) {
      const number = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(number)) return refuse(input, 'Enter a finite number.');
      if (input.min !== '' && number < Number(input.min) || input.max !== '' && number > Number(input.max)) return refuse(input, `Enter a number from ${input.min} to ${input.max}.`);
    }
    const settings = { ...colors };
    for (const [key, input] of Object.entries(inputs)) {
      if (key === 'formula' || key.startsWith('color') || input.disabled) continue;
      const value = input.type === 'checkbox' ? input.checked : input.value;
      if (value !== originals[key]) settings[key] = input.type === 'number' ? Number(value) : value || null;
    }
    const formula = inputs.formula.value.trim(), changedSource = inputs.formula.value !== (spark.formula ?? '');
    if (changedSource && formula && !validRange(inputs.formula)) return refuse(inputs.formula, 'Choose a single row or column of data, or a name that refers to one.');
    if (dateAxis.checked && (dateAxis.checked !== group.dateAxis || dates.value !== originals.dateFormula) && !validRange(dates)) return refuse(dates, 'Choose a single row or column of dates.');
    if (dateAxis.checked && (changedSource || dateAxis.checked !== group.dateAxis || dates.value !== originals.dateFormula)) {
      if (!validRange(dates)) return refuse(dates, 'Choose a single row or column of dates.');
      const members = group.sparklines.map(member => member.ref === ref ? { ...member, formula } : member);
      if (nativeSparklineDateMismatch(ctx.wb, sheetId, dates.value.trim(), members))
        return refuse(dates, 'The date range must have the same number of cells as each sparkline’s data.');
    }
    const minimum = inputs.minAxisType.value === 'custom' ? Number(inputs.manualMin.value) : null;
    const maximum = inputs.maxAxisType.value === 'custom' ? Number(inputs.manualMax.value) : null;
    if (minimum != null && maximum != null && minimum > maximum) return refuse(inputs.manualMax, 'Maximum must be at least the minimum.');
    const error = ctx.wb.updateNativeSparkline(sheetId, ref, { settings, ...(changedSource ? { formula: formula || null } : {}), expectedGroupUid: group.uid });
    if (error) return refuse(null, error);
    modal.close();
  });
  const modal = openModal({ title: 'Sparkline settings', content, initialFocus: inputs.formula, onClose: () => ctx.grid.focus() });
  return modal;
}
