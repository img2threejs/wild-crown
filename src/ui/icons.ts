/**
 * The interface's one icon set: 24-unit geometric line icons drawn with a single 1.75 stroke in `currentColor`, so every
 * glyph inherits the surface's ink or route colour. Decorative by default (`aria-hidden`); give the parent the label.
 */
const PATHS = {
  follow: '<path d="M4 12h14"/><path d="m13 6 6 6-6 6"/>',
  stay: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  focus: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  defend: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 6 6"/>',
  distract: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/>',
  special: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7Z"/>',
  recall: '<path d="M8 7H16a4 4 0 0 1 0 8H7"/><path d="m11 11-4 4 4 4"/>',
  leaf: '<path d="M5 19C5 10 10 5 19 5c0 9-5 14-14 14Z"/><path d="M5 19 13 11"/>',
  root: '<path d="M12 3v8"/><path d="M12 11c-3 0-5 2-6 6M12 11c3 0 5 2 6 6M12 11v10"/>',
  spark: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/><circle cx="12" cy="12" r="1.5"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  exit: '<path d="M14 4h5v16h-5"/><path d="M4 12h11"/><path d="m11 8 4 4-4 4"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="10" rx="1"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  heading: '<path d="M12 3 19 20l-7-4-7 4Z"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, className = 'wc-icon'): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}
