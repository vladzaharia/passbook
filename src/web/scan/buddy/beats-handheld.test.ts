import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'beats-6.css'), 'utf8');
const rules = css.replace(/@keyframes[\s\S]*?\n\}\n/g, '');

describe('the handheld beats', () => {
  it.each(['nod', 'count'])('%s is defined for motion', (beat) => {
    expect(rules).toContain(`[data-beat="${beat}"]`);
  });

  it('every animation sits behind no-preference, and reduced motion adds none', () => {
    const outside = rules.replace(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*$/,
      '',
    );
    expect(outside).not.toMatch(/animation|rotate|translate|scale/);
    expect(css).not.toContain('prefers-reduced-motion: reduce');
  });

  it('every beat ends within 700 ms of the verdict', () => {
    const wait = 150;
    for (const m of rules.matchAll(
      /animation: \S+ (\d+)ms \S+(?: \S+)? (?:var\(--wl-beat-at\)|calc\(var\(--wl-beat-at\) \+ (\d+)ms\))/g,
    ))
      expect(wait + Number(m[1]) + Number(m[2] ?? 0)).toBeLessThanOrEqual(700);
  });

  it('the beats load with the scanner', () => {
    expect(readFileSync(join(__dirname, 'beats.css'), 'utf8')).toContain('beats-6.css');
  });
});
