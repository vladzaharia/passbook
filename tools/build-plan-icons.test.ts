import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeIcons, planIconsCss } from './build-plan-icons.ts';

const icons = composeIcons(resolve(import.meta.dirname, '..'));

describe('plan and row icons', () => {
  it('has 7 plan icons and 112 row icons', () => {
    expect(Object.keys(icons.plans).sort()).toEqual([
      'business',
      'enterprise',
      'legacy',
      'premium',
      'standard',
      'starter',
      'trial',
    ]);
    expect(Object.keys(icons.rowIcons)).toHaveLength(112);
  });

  it('draws every path from a valid first command', () => {
    for (const [key, icon] of Object.entries(icons.rowIcons))
      for (const [, d] of icon.svg.matchAll(/ d="([^"]*)"/g)) expect(d, key).toMatch(/^M[-\d. ]/);
  });

  it('keeps accents out of every dark-theme selector', () => {
    const css = planIconsCss(icons).replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, selector, body] of blocks) {
      if (/dark|prefers-color-scheme/.test(selector ?? ''))
        expect(body).not.toMatch(/--(plan-accent|row-area)-/);
    }
    expect(css).not.toMatch(/dark|prefers-color-scheme/);
    expect(css).toContain('--plan-accent-business: #8B4DEB;');
    expect(css).toContain('--row-area-door: #22B45A;');
  });

  it('fits each glyph with its own $fit, matching the kb compose output', () => {
    for (const [key, want] of Object.entries(KB_COMPOSE)) {
      expect(icons.rowIcons[key]?.svg).toBe(want.svg);
      expect(icons.rowIcons[key]?.mono).toBe(want.mono);
    }
  });

  it('gives every glyph a $fit', () => {
    const dir = resolve(import.meta.dirname, '../assets/icons/rows');
    const files = readdirSync(dir).filter((f) => /^glyphs-.*\.json$/.test(f));
    let n = 0;
    for (const f of files) {
      const { $fit = {}, ...glyphs } = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
      expect(Object.keys($fit).sort(), f).toEqual(Object.keys(glyphs).sort());
      n += Object.keys(glyphs).length;
    }
    expect(n).toBeGreaterThanOrEqual(112);
  });
});

// Expected output of the kb compose.mjs (icons/rows) for four glyphs, two with BG knockouts.
const KB_COMPOSE: Record<string, { svg: string; mono: string }> = {
  'spreadsheet-link-and-file-upload': {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path transform="translate(0 2)" d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="#0c7b6d"/><path d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="#12B5A0"/><g transform="translate(-4.12 -12.89) scale(1.48)"><path d="M10.5 16H27.5Q29 16 29 17.5V31Q29 32.5 27.5 32.5H10.5Q9 32.5 9 31V17.5Q9 16 10.5 16ZM11.3 22H15.7V25.6H11.3ZM17.3 22H21.7V25.6H17.3ZM23.3 22H26.7V25.6H23.3ZM11.3 27.3H15.7V30.8H11.3ZM17.3 27.3H21.7V30.8H17.3ZM23.3 27.3H26.7V30.8H23.3Z" fill="#16132B" fill-rule="evenodd"/></g></svg>',
    mono: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><mask id="rm-spreadsheet-link-and-file-upload" maskUnits="userSpaceOnUse" x="-20" y="-20" width="90" height="90"><rect x="-20" y="-20" width="90" height="90" fill="#fff"/><g transform="translate(-4.12 -12.89) scale(1.48)"><path d="M10.5 16H27.5Q29 16 29 17.5V31Q29 32.5 27.5 32.5H10.5Q9 32.5 9 31V17.5Q9 16 10.5 16ZM11.3 22H15.7V25.6H11.3ZM17.3 22H21.7V25.6H17.3ZM23.3 22H26.7V25.6H23.3ZM11.3 27.3H15.7V30.8H11.3ZM17.3 27.3H21.7V30.8H17.3ZM23.3 27.3H26.7V30.8H23.3Z" fill="#000" fill-rule="evenodd"/></g></mask></defs><g transform="translate(0 1)" mask="url(#rm-spreadsheet-link-and-file-upload)"><path d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="currentColor"/></g></svg>',
  },
  'area-data': {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path transform="translate(0 2)" d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="#0c7b6d"/><path d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="#12B5A0"/><g transform="translate(-6.8 -15.5) scale(1.621)"><ellipse cx="19" cy="17.5" rx="8.5" ry="3" fill="#16132B"/><path d="M10.5 19.6A8.5 3 0 0 0 27.5 19.6V24A8.5 3 0 0 1 10.5 24Z" fill="#16132B"/><path d="M10.5 25.8A8.5 3 0 0 0 27.5 25.8V30A8.5 3 0 0 1 10.5 30Z" fill="#16132B"/></g></svg>',
    mono: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><mask id="rm-area-data" maskUnits="userSpaceOnUse" x="-20" y="-20" width="90" height="90"><rect x="-20" y="-20" width="90" height="90" fill="#fff"/><g transform="translate(-6.8 -15.5) scale(1.621)"><ellipse cx="19" cy="17.5" rx="8.5" ry="3" fill="#000"/><path d="M10.5 19.6A8.5 3 0 0 0 27.5 19.6V24A8.5 3 0 0 1 10.5 24Z" fill="#000"/><path d="M10.5 25.8A8.5 3 0 0 0 27.5 25.8V30A8.5 3 0 0 1 10.5 30Z" fill="#000"/></g></mask></defs><g transform="translate(0 1)" mask="url(#rm-area-data)"><path d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="currentColor"/></g></svg>',
  },
  'area-wallets': {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path transform="translate(0 2)" d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="#297da7"/><path d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="#3DB8F5"/><g transform="translate(-4.37 -10.72) scale(1.429)"><rect x="11.8" y="14.6" width="13" height="6" rx="1.4" fill="#16132B"/><rect x="8.4" y="17.6" width="21.2" height="16" rx="3.4" fill="#3DB8F5"/><rect x="9.5" y="18.6" width="19" height="14" rx="2.8" fill="#16132B"/><rect x="20.6" y="22.2" width="10.6" height="7" rx="2.6" fill="#3DB8F5"/><rect x="22" y="23.4" width="8.2" height="4.6" rx="1.8" fill="#16132B"/><circle cx="25" cy="25.7" r="1.1" fill="#3DB8F5"/></g></svg>',
    mono: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><mask id="rm-area-wallets" maskUnits="userSpaceOnUse" x="-20" y="-20" width="90" height="90"><rect x="-20" y="-20" width="90" height="90" fill="#fff"/><g transform="translate(-4.37 -10.72) scale(1.429)"><rect x="11.8" y="14.6" width="13" height="6" rx="1.4" fill="#000"/><rect x="8.4" y="17.6" width="21.2" height="16" rx="3.4" fill="#fff"/><rect x="9.5" y="18.6" width="19" height="14" rx="2.8" fill="#000"/><rect x="20.6" y="22.2" width="10.6" height="7" rx="2.6" fill="#fff"/><rect x="22" y="23.4" width="8.2" height="4.6" rx="1.8" fill="#000"/><circle cx="25" cy="25.7" r="1.1" fill="#fff"/></g></mask></defs><g transform="translate(0 1)" mask="url(#rm-area-wallets)"><path d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="currentColor"/></g></svg>',
  },
  'area-brand': {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path transform="translate(0 2)" d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="#a32e4b"/><path d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="#F0446E"/><g transform="translate(-7.77 -16.67) scale(1.672)"><path fill="#16132B" fill-rule="evenodd" d="M19.00 15.30L21.59 21.04L27.84 21.73L23.18 25.96L24.47 32.12L19.00 29.00L13.53 32.12L14.82 25.96L10.16 21.73L16.41 21.04Z"/></g></svg>',
    mono: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><mask id="rm-area-brand" maskUnits="userSpaceOnUse" x="-20" y="-20" width="90" height="90"><rect x="-20" y="-20" width="90" height="90" fill="#fff"/><g transform="translate(-7.77 -16.67) scale(1.672)"><path fill="#000" fill-rule="evenodd" d="M19.00 15.30L21.59 21.04L27.84 21.73L23.18 25.96L24.47 32.12L19.00 29.00L13.53 32.12L14.82 25.96L10.16 21.73L16.41 21.04Z"/></g></mask></defs><g transform="translate(0 1)" mask="url(#rm-area-brand)"><path d="M6.5 3H41.5A5.5 5.5 0 0 1 47 8.5V19.8A3.2 3.2 0 0 0 47 26.2V37.5A5.5 5.5 0 0 1 41.5 43H6.5A5.5 5.5 0 0 1 1 37.5V26.2A3.2 3.2 0 0 0 1 19.8V8.5A5.5 5.5 0 0 1 6.5 3Z" fill="currentColor"/></g></svg>',
  },
};
