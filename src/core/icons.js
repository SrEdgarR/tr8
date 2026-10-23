/* ---------- icons: inlined Lucide subset (src/00-icons.js), rendered to inline svg ---------- */
import { ICONS } from 'virtual:icons';
import { esc } from './utils.js';

export const _icCache = {};
export function ic(name, size = 16, cls = '') {
  const k = name + '|' + size + '|' + cls;
  if (_icCache[k]) return _icCache[k];
  const inner = ICONS[name] || '<rect x="5" y="5" width="14" height="14" rx="3"/>';
  return (_icCache[k] =
    `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
}
/* TR8 wordmark follows the theme text colour; MARK matches public/favicon.svg. */
export const LOGO_D =
  'M2 2H30V9H20V38H12V9H2Z M36 2H49C59 2 65 7 65 15C65 21 62 25 57 27L67 38H57L48 28H44V38H36Z M44 9V21H49C54 21 57 19 57 15C57 11 54 9 49 9Z M89 1C99 1 105 5 105 12C105 16 103 19 99 20C104 22 107 25 107 29C107 36 100 40 89 40C78 40 72 36 72 29C72 25 75 22 79 20C75 18 73 16 73 12C73 5 79 1 89 1Z M89 8C84 8 81 10 81 13C81 16 84 18 89 18C94 18 97 16 97 13C97 10 94 8 89 8Z M89 24C83 24 80 26 80 29C80 32 83 34 89 34C95 34 99 32 99 29C99 26 95 24 89 24Z';
export const LOGO = (h = 22) =>
  `<svg class="logo" height="${h}" width="${Math.round((h * 109) / 40)}" viewBox="0 0 109 40" role="img" aria-label="TR8"><path d="${LOGO_D}" fill="currentColor" fill-rule="evenodd"/></svg>`;
export const MARK = (px = 22) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="28" fill="#1d1c1a"/><path d="${LOGO_D}" transform="translate(9 44)" fill="#fff" fill-rule="evenodd"/></svg>`;
export function wsLogo(w, px = 22) {
  return w && w.brand
    ? `<span class="ws-logo brand" style="width:${px}px;height:${px}px">${MARK(px)}</span>`
    : `<span class="ws-logo" style="--c:${w.c};width:${px}px;height:${px}px;font-size:${Math.max(9, Math.round(px * 0.46))}px">${esc(w.name[0])}</span>`;
}
