import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FitBox } from './fit-box.tsx';

let width = 0;
let height = 0;
const observers: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => height,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  observers.length = 0;
});

function scaleFor(box: { w: number; h: number; layout: number; max: number }) {
  width = box.w;
  height = box.h;
  const { container } = render(
    <FitBox maxHeight={box.max} layoutWidth={box.layout}>
      <p>page</p>
    </FitBox>,
  );
  act(() => {
    for (const cb of observers) cb();
  });
  const inner = container.querySelector<HTMLElement>('.fit-inner');
  return Number(/scale\(([\d.]+)\)/.exec(inner?.style.transform ?? '')?.[1]);
}

describe('FitBox', () => {
  it('fits a tall page by its height', () => {
    // 480 wide, 680 tall (A4): 400 of height lets it draw at 400 / 680.
    expect(scaleFor({ w: 500, h: 680, layout: 480, max: 400 })).toBeCloseTo(400 / 680, 3);
  });

  it('fits a wide strip by its width', () => {
    // 480 wide, 90 tall in a 240 wide box: half size, nowhere near the height limit.
    expect(scaleFor({ w: 240, h: 90, layout: 480, max: 400 })).toBeCloseTo(0.5, 3);
  });

  it('never shows more than the whole of either', () => {
    const s = scaleFor({ w: 300, h: 1200, layout: 480, max: 420 });
    expect(480 * s).toBeLessThanOrEqual(300);
    expect(1200 * s).toBeLessThanOrEqual(420.001);
  });
});
