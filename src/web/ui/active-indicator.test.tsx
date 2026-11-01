import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveIndicator } from './active-indicator.tsx';

let resize: () => void = () => {};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const frame = () => act(() => new Promise((done) => requestAnimationFrame(() => done(null))));

function setup() {
  const { container } = render(
    <nav>
      <a href="/a" aria-current="page">
        A
      </a>
      <a href="/b">B</a>
      <ActiveIndicator />
    </nav>,
  );
  const pill = container.querySelector<HTMLElement>('.wl-indicator');
  const [a, b] = container.querySelectorAll('a');
  if (!pill || !a || !b) throw new Error('missing nodes');
  return { pill, a, b };
}

describe('ActiveIndicator', () => {
  it('slides when the active item changes', async () => {
    const { pill, a, b } = setup();
    await frame();
    expect(pill.dataset.ready).toBe('');
    a.removeAttribute('aria-current');
    b.setAttribute('aria-current', 'page');
    await act(async () => {});
    expect(pill.dataset.ready).toBe('');
  });

  it('snaps on resize, then slides again', async () => {
    const { pill } = setup();
    await frame();
    act(() => resize());
    expect(pill.dataset.ready).toBeUndefined();
    await frame();
    expect(pill.dataset.ready).toBe('');
  });

  it('hides without an active item', async () => {
    const { pill, a } = setup();
    a.removeAttribute('aria-current');
    await act(async () => {});
    expect(pill.hidden).toBe(true);
  });
});
