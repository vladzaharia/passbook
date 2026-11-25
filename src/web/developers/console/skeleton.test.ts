import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '../styles/dev-run.css'), 'utf8');

/** The declarations of every rule whose selector mentions `needle`, minus @media wrappers. */
function rules(needle: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if ((m[1] ?? '').includes(needle)) out.push(m[2] ?? '');
  return out;
}

describe('the Try it skeleton', () => {
  const loading = rules('[data-state="loading"]');
  it('has rules for the loading state', () => {
    expect(loading.length).toBeGreaterThan(1);
  });
  it('changes no box: it hides with visibility and draws on pseudo-elements out of the flow', () => {
    const forbidden =
      /(^|;|\s)(display|width|height|min-height|min-block-size|block-size|padding|margin|border|flex|grid|gap|font-size|line-height)\s*:/;
    for (const decl of loading) {
      const flow = decl.replace(/inset:[^;]*;|animation:[^;]*;|border-radius:[^;]*;/g, '');
      expect(flow, decl).not.toMatch(forbidden);
    }
    expect(loading.some((d) => d.includes('visibility: hidden'))).toBe(true);
    expect(loading.some((d) => d.includes('position: absolute'))).toBe(true);
  });
  it('animates opacity only, and not under reduced motion', () => {
    const keyframes = css.match(/@keyframes dp-sk\s*\{[\s\S]*?\}\s*\}/)?.[0] ?? '';
    expect(keyframes).toContain('opacity');
    expect(keyframes).not.toMatch(/(width|height|top|left|margin)/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.try\[data-state="loading"\]/,
    );
  });
  it('gives the stub and body one size whatever is inside', () => {
    expect(css).toMatch(/\.try \.stub \{[^}]*block-size: 21rem/);
    expect(css).toMatch(/\.try \.body \{[^}]*min-block-size: 12.25rem/);
  });
});

describe('the held console and quickstart slots', () => {
  const held = rules('[data-hydrating]::before');
  it('draw the loading pattern while the session is read, out of the flow', () => {
    expect(
      held.some((d) => d.includes('visibility: visible') && d.includes('position: absolute')),
    ).toBe(true);
  });
  it('show it after a delay and in opacity only, with nothing finite under reduced motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*:is\([^)]*\)\[data-hydrating\]::before\s*\{\s*animation:\s*dp-sk-in 200ms ease-out 150ms backwards/,
    );
    expect(css.match(/@keyframes dp-sk-in\s*\{[\s\S]*?\}\s*\}/)?.[0]).toMatch(/opacity: 0/);
  });
});
