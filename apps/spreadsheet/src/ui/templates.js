/**
 * Template picker: a grid of starting points (blank, budget, invoice, ...).
 * Picking one opens a new, unsaved document built from it.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { TEMPLATES } from '../core/templates.js';
import { templateThumbnail } from './template-thumbnail.js';

export function openTemplatePicker({ onPick }) {
  const cards = TEMPLATES.map((t) => el('button.template-card', {
    type: 'button', dataset: { template: t.id },
    onclick: () => { modal.close(); onPick(t.id); },
  },
    el('span.template-thumb', { 'aria-hidden': 'true' }, templateThumbnail(t.id) || el('span.template-icon', { html: icon(t.icon, 22) })),
    el('span.template-name', {}, t.name),
    el('span.template-desc', {}, t.description)));
  // A group, not a list: the cards are buttons, and a list of buttons reads as a list of nothing.
  const content = el('div.template-grid', { role: 'group', 'aria-label': 'Templates' }, ...cards);
  const modal = openModal({ title: 'New from template', content, wide: true });
  cards[0]?.focus();
  return modal;
}
