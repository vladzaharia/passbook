import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFaceHeight } from './use-face-height.ts';

let observers: Array<() => void> = [];
const sizes = new WeakMap<Element, number>();

class FakeRO {
  constructor(cb: () => void) {
    observers.push(cb);
  }
  observe() {}
  disconnect() {}
}

function Probe({ face }: { face: 'email' | 'code' }) {
  const s = useFaceHeight(face);
  return (
    <div data-testid="flipper" data-turning={s.turning || undefined} data-h={s.height ?? ''}>
      <section ref={s.email} data-side="email" />
      <section ref={s.code} data-side="code" />
    </div>
  );
}

const reduced = (on: boolean) =>
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce') }));

beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', FakeRO);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return sizes.get(this) ?? (this.dataset.side === 'code' ? 420 : 260);
  });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useFaceHeight', () => {
  it('follows the active face and re-measures on resize', () => {
    reduced(false);
    const { getByTestId, rerender, container } = render(<Probe face="email" />);
    expect(getByTestId('flipper').dataset.h).toBe('260');
    rerender(<Probe face="code" />);
    expect(getByTestId('flipper').dataset.h).toBe('420');
    sizes.set(container.querySelector('[data-side="code"]') as Element, 380);
    act(() => {
      for (const cb of observers) cb();
    });
    expect(getByTestId('flipper').dataset.h).toBe('380');
  });

  it('marks the flip as turning, then settles', () => {
    reduced(false);
    const { getByTestId, rerender } = render(<Probe face="email" />);
    rerender(<Probe face="code" />);
    expect(getByTestId('flipper').dataset.turning).toBe('true');
    act(() => vi.advanceTimersByTime(900));
    expect(getByTestId('flipper').dataset.turning).toBeUndefined();
  });

  it('never animates the height under reduced motion', () => {
    reduced(true);
    const { getByTestId, rerender } = render(<Probe face="email" />);
    rerender(<Probe face="code" />);
    expect(getByTestId('flipper').dataset.turning).toBeUndefined();
    expect(getByTestId('flipper').dataset.h).toBe('420');
  });
});
