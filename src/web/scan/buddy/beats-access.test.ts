import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'beats-5.css'), 'utf8');
const [motion, reduced] = css.split('@media (prefers-reduced-motion: reduce)');

describe('the access beats', () => {
  it.each(['gate', 'bye', 'relent'])('%s is defined for motion', (beat) => {
    expect(motion).toContain(`[data-beat="${beat}"]`);
  });
  it('every animation sits behind no-preference', () => {
    const outside = (motion ?? '').replace(
      /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*$/,
      '',
    );
    expect(outside.replace(/@keyframes[\s\S]*?\n\}\n/g, '')).not.toMatch(/animation:/);
  });
  it('reduced motion holds the end pose, with no animation', () => {
    expect(reduced).toContain('[data-beat="gate"]');
    expect(reduced).toContain('[data-beat="bye"]');
    expect(reduced).not.toMatch(/animation/);
  });
  it('the beats load with the scanner', () => {
    expect(readFileSync(join(__dirname, 'beats.css'), 'utf8')).toContain('beats-5.css');
  });
});
