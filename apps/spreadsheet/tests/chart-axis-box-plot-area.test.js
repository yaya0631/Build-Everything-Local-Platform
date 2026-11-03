// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = async () => { for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1); };

// A box round a scientific plot: Format Axis offers the plot area's border, all four sides at once.
async function mount() {
  const doc = new Doc({ name: 'Box' }), wb = doc.wb, id = wb.activeSheetId;
  [['x', 'y'], ['1', '2'], ['2', '5'], ['3', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'scatter'));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush();
  const box = view.el.querySelector('.chart-box');
  box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 }));
  await flush();
  return { chart: () => wb.chartById(id, chartId) };
}
const pane = () => view.el.querySelector('.chart-format-pane');
const boxCheck = () => [...pane().querySelectorAll('label.check')].find(n => n.textContent === 'Box around plot area')?.querySelector('input');
const border = () => view.el.querySelector('.chart-box .chart-body svg .chart-plot-border');
const set = async (input, value) => { input.value = value; input.dispatchEvent(new Event('change')); await flush(); };

it('boxes the plot from Format Axis in the axis line\'s colour and width, and takes the box away again', async () => {
  const { chart } = await mount();
  view.run('chart', { action: 'formatPane', element: 'yAxis' }); await flush();
  await set(pane().querySelector('select[aria-label="Border"]'), 'solid');
  await set(pane().querySelector('input[aria-label="Line Color"]'), '#112233');
  await set(pane().querySelector('input[aria-label="Width (pt)"]'), '1.5');
  expect(border()).toBeNull();
  boxCheck().click(); await flush();
  expect(chart().appearance).toMatchObject({ plotStroke: '#112233', plotStrokeWidth: 2 });
  expect(border().getAttribute('stroke')).toBe('#112233');

  // The horizontal axis shows the same box, and clearing it there clears it for both.
  view.run('chart', { action: 'formatPane', element: 'xAxis' }); await flush();
  expect(boxCheck().checked).toBe(true);
  boxCheck().click(); await flush();
  expect(chart().appearance.plotStroke).toBe('none');
  expect(border()).toBeNull();
  view.run('chart', { action: 'formatPane', element: 'yAxis' }); await flush();
  expect(boxCheck().checked).toBe(false);
});
