import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { LiveBuddy } from './live-buddy.tsx';

const css = (f: string) =>
  readFileSync(join(process.cwd(), 'src/web/ui/art/scenes', f), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

describe('LiveBuddy', () => {
  it('listens with the lens drawn, then catches happy with the envelope and the check', () => {
    const { container, rerender } = render(<LiveBuddy found={false} />);
    const buddy = () => container.querySelector('[data-buddy]') as HTMLElement;
    expect(buddy().dataset.scene).toBe('listen-live');
    expect(container.querySelector('[data-lens]')).not.toBeNull();
    expect(container.querySelector('[data-check]')).toBeNull();
    rerender(<LiveBuddy found />);
    expect(buddy().dataset.scene).toBe('catch-live');
    expect(container.querySelector('[data-env]')?.getAttribute('opacity')).toBe('0');
    expect(container.querySelector('[data-check]')).not.toBeNull();
    expect(container.querySelector('[data-part="joy"]')).not.toBeNull();
  });

  it('stays decorative', async () => {
    const { container } = render(<LiveBuddy found={false} />);
    expect(container.textContent).toBe('');
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('listen-live and catch-live stylesheets', () => {
  it('loop only listening, only under no-preference, on transform and opacity', () => {
    const text = css('listen-live.css');
    expect(text.match(/infinite/g)?.length).toBe(3);
    expect(css('catch-live.css')).not.toMatch(/infinite/);
    expect(text).not.toMatch(/(width|height|top|left|margin):/);
    const anim = text.indexOf('animation:');
    expect(
      text.lastIndexOf('@media (prefers-reduced-motion: no-preference)', anim),
    ).toBeGreaterThan(text.indexOf('rotate: 5deg'));
  });

  it('hold the catch pose: the pass peeks 6 px and the keyframes end there', () => {
    const text = css('catch-live.css');
    expect(text).toMatch(/\[data-part="c2"\] \{\s*translate: 0 -6px;/);
    expect(text).toMatch(/54%,\s*100% \{\s*translate: 0 -6px;/);
    expect(text).toMatch(/72%,\s*100% \{\s*scale: 1;\s*opacity: 1;/);
    // The rest pose is only overridden while motion is welcome and the scene has not run.
    expect(text).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{\s*\[data-scene="catch-live"\]:not\(\[data-run\]\)/,
    );
  });
});
