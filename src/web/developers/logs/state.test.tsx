import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearState, showFailed, showNoSandbox } from './state.tsx';

afterEach(() => {
  document.body.innerHTML = '';
});

const slot = () => {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
};

describe('log states', () => {
  it('draws no-sandbox with the way to make one', () => {
    const el = slot();
    showNoSandbox(el, false);
    expect(el.querySelector('.pstate')?.getAttribute('data-kind')).toBe('empty');
    expect(el.querySelector('a')?.getAttribute('href')).toContain('#sandbox');
  });

  it('draws a closed sandbox without an action', () => {
    const el = slot();
    showNoSandbox(el, true);
    expect(el.querySelector('a, button')).toBeNull();
  });

  it('draws an error whose Retry calls back', () => {
    const el = slot();
    const retry = vi.fn();
    showFailed(el, retry);
    expect(el.querySelector('.pstate')?.getAttribute('data-kind')).toBe('error');
    el.querySelector('button')?.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('clears a drawn state', () => {
    const el = slot();
    showFailed(el, vi.fn());
    clearState(el);
    expect(el.childElementCount).toBe(0);
  });
});
