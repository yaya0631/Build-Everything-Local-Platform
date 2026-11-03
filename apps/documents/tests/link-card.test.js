// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { createLinkCard } from '../src/views/link-card.js';

const rect = { left: 20, top: 40, width: 60, height: 16 };
const fakeEditor = () => ({ model: { range: [3, 3] }, session: { path: null }, openHyperlink: vi.fn(), removeHyperlink: vi.fn() });
afterEach(() => document.body.replaceChildren());

it('shows a web address as a link that the editor follows, and goes once the caret moves', () => {
  const ed = fakeEditor(), card = createLinkCard({ editor: () => ed, edit: vi.fn(), host: document.createElement('div') });
  const link = { target: 'https://example.com/a' };
  card.show({ start: 1, end: 5, link, rect });
  const address = card.node.querySelector('a');
  expect(card.node.hidden).toBe(false); expect(address.getAttribute('href')).toBe('https://example.com/a'); expect(address.rel).toBe('noopener noreferrer');
  expect(card.node.querySelector('.link-card-note').hidden).toBe(true);
  expect(address.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
  expect(ed.openHyperlink).toHaveBeenCalledWith(link); expect(card.node.hidden).toBe(true);
  card.show({ start: 1, end: 5, link, rect }); card.changed(); expect(card.node.hidden).toBe(false);
  ed.model.range = [4, 4]; card.changed(); expect(card.node.hidden).toBe(true);
});

it('keeps an address it cannot open as plain text, and edits or removes the link', () => {
  const ed = fakeEditor(), edit = vi.fn(), card = createLinkCard({ editor: () => ed, edit, host: document.createElement('div') });
  card.show({ start: 1, end: 5, link: { target: 'file:///C:/report.docx' }, rect });
  const address = card.node.querySelector('a');
  expect(address.hasAttribute('href')).toBe(false); expect(address.classList.contains('is-retained')).toBe(true);
  expect(card.node.querySelector('.link-card-note').hidden).toBe(false);
  address.click(); expect(ed.openHyperlink).not.toHaveBeenCalled(); expect(card.node.hidden).toBe(false);
  card.node.querySelector('[aria-label="Edit link"]').click(); expect(edit).toHaveBeenCalledOnce(); expect(card.node.hidden).toBe(true);
  card.show({ start: 1, end: 5, link: { anchor: 'intro' }, rect });
  expect(card.node.querySelector('a').textContent).toBe('Bookmark: intro'); expect(card.node.querySelector('a').hasAttribute('href')).toBe(false);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(card.node.hidden).toBe(true);
  card.show({ start: 1, end: 5, link: { anchor: 'intro' }, rect });
  card.node.querySelector('[aria-label="Remove link"]').click(); expect(ed.removeHyperlink).toHaveBeenCalledOnce();
});
