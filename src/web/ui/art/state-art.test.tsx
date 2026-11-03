import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { EmptyState } from '../empty-state.tsx';
import { ErrorState } from '../error-state.tsx';
import { preloadArt } from './index.ts';
import { StateArt, type StateArtName } from './state-art.tsx';

/** What a buddy composition shows: mood, scene, wallet state and the prop's art. */
function composition(root: ParentNode) {
  const buddy = root.querySelector('[data-buddy]');
  return {
    mood: buddy?.querySelector('[data-part="w"]')?.getAttribute('data-mood'),
    scene: buddy?.getAttribute('data-scene'),
    state: buddy?.querySelector('[data-art="wallet"]')?.getAttribute('data-state'),
    prop: buddy?.querySelector('.wl-buddy-prop svg')?.getAttribute('data-art') ?? null,
  };
}
const ssr = (name: StateArtName) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<StateArt name={name} playOnLoad />);
  return host;
};

describe('state art', () => {
  beforeAll(async () => {
    await preloadArt();
  });

  // One composition per meaning, SPA and SSR (F7).
  it.each([
    ['broken', <ErrorState key="e" title="Something went wrong." />],
    ['lost', <EmptyState key="l" heading art="wallet" artState="lost" title="Page not found" />],
    ['torn', <EmptyState key="t" heading art="torn" title="Pass not found" />],
    ['no-access', <EmptyState key="f" heading art="lock" title="You do not have access" />],
  ] as const)('acts out %s as the app does', (name, app) => {
    const spa = composition(render(app).container);
    expect(spa.mood).toBe('sad');
    expect(composition(ssr(name))).toEqual(spa);
    expect(ssr(name).querySelector('[data-buddy]')).toHaveAttribute('data-run', 'load');
  });

  it('gives each state one meaning: the hourglass waits, the gold pass droops when expired', () => {
    const names: StateArtName[] = ['login', 'confirm', 'break-glass', 'expired', 'throttled'];
    for (const name of names) {
      const body = ssr(name);
      const svg = body.querySelector('[data-art="wallet"]');
      expect(body.querySelector('[data-hourglass], [data-part="hg"]') !== null, name).toBe(
        name === 'throttled',
      );
      expect(svg?.querySelector('.dim .c3') !== null, name).toBe(name === 'expired');
      expect(body.querySelector('[data-part="ck"]') !== null, name).toBe(name === 'confirm');
      expect(body.querySelector('[data-part="key"]') !== null, name).toBe(name === 'break-glass');
      // Seated at L, with the band's idle beat (B11); a click waves hello.
      expect(svg).toHaveAttribute('data-size', 'xl');
      expect(svg).not.toHaveAttribute('data-beat');
      expect(body.querySelector('[data-replay]')).toHaveAttribute('data-scene', 'hello');
      const sad = name === 'expired' || name === 'throttled';
      expect(svg?.querySelector('[data-part="w"]')?.getAttribute('data-mood'), name).toBe(
        sad ? 'sad' : null,
      );
    }
    // A refused form makes any of them sad.
    const failed = renderToStaticMarkup(<StateArt name="break-glass" failed />);
    expect(failed).toContain('data-mood="sad"');
  });
});
