/**
 * Fixed colours the blueprint quick setup and the Brand accent offer beside a logo's own. Each reads
 * with white text at 4.5:1 and holds 3:1 on the light and dark pages (test beside), so none
 * triggers Fix accent.
 */
export const ACCENT_PRESETS = [
  { name: 'Teal', hex: '#0f766e' },
  { name: 'Violet', hex: '#5b51d6' },
  { name: 'Crimson', hex: '#be123c' },
  { name: 'Orange', hex: '#c2410c' },
  { name: 'Blue', hex: '#2754dc' },
  { name: 'Slate', hex: '#566377' },
  { name: 'Green', hex: '#15803d' },
  { name: 'Magenta', hex: '#a21caf' },
  { name: 'Gold', hex: '#a16207' },
] as const;
