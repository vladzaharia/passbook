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
      for (const [, d] of icon.svg.matchAll(/ d="([^"]*)"/g))
        expect(d, key).toMatch(/^M[-\d. ]/);
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

// Expected output of the kb compose.mjs (icons/rows) for two glyphs.
const KB_COMPOSE: Record<string, { svg: string; mono: string }> = {
  'spreadsheet-link-and-file-upload': {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g transform="rotate(-6 24 24)"><path transform="translate(0 2.4)" d="M8.5 10L35.3 10A2.2 2.2 0 0 0 39.7 10L41 10A3 3 0 0 1 44 13L44 35A3 3 0 0 1 41 38L39.7 38A2.2 2.2 0 0 0 35.3 38L8.5 38A4.5 4.5 0 0 1 4 33.5L4 14.5A4.5 4.5 0 0 1 8.5 10Z" fill="#0c7b6d"/><path d="M8.5 10L35.3 10A2.2 2.2 0 0 0 39.7 10L41 10A3 3 0 0 1 44 13L44 35A3 3 0 0 1 41 38L39.7 38A2.2 2.2 0 0 0 35.3 38L8.5 38A4.5 4.5 0 0 1 4 33.5L4 14.5A4.5 4.5 0 0 1 8.5 10Z" fill="#12B5A0"/><g transform="translate(-0.23 -2.43) scale(1.09)"><path d="M10.5 16H27.5Q29 16 29 17.5V31Q29 32.5 27.5 32.5H10.5Q9 32.5 9 31V17.5Q9 16 10.5 16ZM11.3 22H15.7V25.6H11.3ZM17.3 22H21.7V25.6H17.3ZM23.3 22H26.7V25.6H23.3ZM11.3 27.3H15.7V30.8H11.3ZM17.3 27.3H21.7V30.8H17.3ZM23.3 27.3H26.7V30.8H23.3Z" fill="#16132B" fill-rule="evenodd"/></g><path d="M37.5 14.2V33.8" stroke="#16132B" stroke-width="1.1" stroke-dasharray="1.6 2.3" fill="none"/></g></svg>',
    mono: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><mask id="rm-spreadsheet-link-and-file-upload" maskUnits="userSpaceOnUse" x="-20" y="-20" width="90" height="90"><rect x="-20" y="-20" width="90" height="90" fill="#fff"/><g transform="translate(-0.23 -2.43) scale(1.09)"><path d="M10.5 16H27.5Q29 16 29 17.5V31Q29 32.5 27.5 32.5H10.5Q9 32.5 9 31V17.5Q9 16 10.5 16ZM11.3 22H15.7V25.6H11.3ZM17.3 22H21.7V25.6H17.3ZM23.3 22H26.7V25.6H23.3ZM11.3 27.3H15.7V30.8H11.3ZM17.3 27.3H21.7V30.8H17.3ZM23.3 27.3H26.7V30.8H23.3Z" fill="#000" fill-rule="evenodd"/></g><path d="M37.5 14.2V33.8" stroke="#000" stroke-width="1.1" stroke-dasharray="1.6 2.3" fill="none"/></mask></defs><g transform="rotate(-6 24 24)" mask="url(#rm-spreadsheet-link-and-file-upload)"><path d="M8.5 10L35.3 10A2.2 2.2 0 0 0 39.7 10L41 10A3 3 0 0 1 44 13L44 35A3 3 0 0 1 41 38L39.7 38A2.2 2.2 0 0 0 35.3 38L8.5 38A4.5 4.5 0 0 1 4 33.5L4 14.5A4.5 4.5 0 0 1 8.5 10Z" fill="currentColor"/></g></svg>',
  },
  'area-data': {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g transform="rotate(-6 24 24)"><path transform="translate(0 2.4)" d="M8.5 10L35.3 10A2.2 2.2 0 0 0 39.7 10L41 10A3 3 0 0 1 44 13L44 35A3 3 0 0 1 41 38L39.7 38A2.2 2.2 0 0 0 35.3 38L8.5 38A4.5 4.5 0 0 1 4 33.5L4 14.5A4.5 4.5 0 0 1 8.5 10Z" fill="#0c7b6d"/><path d="M8.5 10L35.3 10A2.2 2.2 0 0 0 39.7 10L41 10A3 3 0 0 1 44 13L44 35A3 3 0 0 1 41 38L39.7 38A2.2 2.2 0 0 0 35.3 38L8.5 38A4.5 4.5 0 0 1 4 33.5L4 14.5A4.5 4.5 0 0 1 8.5 10Z" fill="#12B5A0"/><g transform="translate(0.37 -1.39) scale(1.058)"><path d="M10 22H28L28.6 31.4Q28.7 32.5 27.5 32.5H10.5Q9.3 32.5 9.4 31.4Z" fill="#16132B" /><path d="M15.5 23V20.2A3.5 3.5 0 0 1 22.5 20.2V23" fill="none" stroke="#16132B" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g><path d="M37.5 14.2V33.8" stroke="#16132B" stroke-width="1.1" stroke-dasharray="1.6 2.3" fill="none"/></g></svg>',
    mono: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><mask id="rm-area-data" maskUnits="userSpaceOnUse" x="-20" y="-20" width="90" height="90"><rect x="-20" y="-20" width="90" height="90" fill="#fff"/><g transform="translate(0.37 -1.39) scale(1.058)"><path d="M10 22H28L28.6 31.4Q28.7 32.5 27.5 32.5H10.5Q9.3 32.5 9.4 31.4Z" fill="#000" /><path d="M15.5 23V20.2A3.5 3.5 0 0 1 22.5 20.2V23" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></g><path d="M37.5 14.2V33.8" stroke="#000" stroke-width="1.1" stroke-dasharray="1.6 2.3" fill="none"/></mask></defs><g transform="rotate(-6 24 24)" mask="url(#rm-area-data)"><path d="M8.5 10L35.3 10A2.2 2.2 0 0 0 39.7 10L41 10A3 3 0 0 1 44 13L44 35A3 3 0 0 1 41 38L39.7 38A2.2 2.2 0 0 0 35.3 38L8.5 38A4.5 4.5 0 0 1 4 33.5L4 14.5A4.5 4.5 0 0 1 8.5 10Z" fill="currentColor"/></g></svg>',
  },
};
