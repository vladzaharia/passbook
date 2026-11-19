import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useContainerWidth } from './container-width.ts';

let fire: () => void = () => {};
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function Probe({ width }: { width: { v: number } }) {
  const [w, ref] = useContainerWidth();
  return (
    <div
      ref={(el) => {
        if (el)
          Object.defineProperty(el, 'clientWidth', { get: () => width.v, configurable: true });
        ref(el);
      }}
      data-w={w}
    />
  );
}

describe('useContainerWidth', () => {
  it('follows the element width', () => {
    const width = { v: 540 };
    const { container } = render(<Probe width={width} />);
    expect(container.firstElementChild).toHaveAttribute('data-w', '540');
    width.v = 900;
    act(() => fire());
    expect(container.firstElementChild).toHaveAttribute('data-w', '900');
  });
});
