import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type BenchKey, resolveBenchKey, useBenchKeys } from './keys.ts';
import { BenchKeys } from './shortcuts.tsx';

beforeAll(() => {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const key = (k: string, target: EventTarget | null = document.body, mods: Partial<BenchKey> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target,
  ...mods,
});

describe('bench keys', () => {
  it('maps the design table, and g then a letter switches tools', () => {
    const one = (k: string) => resolveBenchKey(key(k), false).action;
    expect(['j', 'k', 'y', 'c', '?', 'Enter', 'Escape', 'x'].map(one)).toEqual([
      'next',
      'prev',
      'copyId',
      'copyCurl',
      'help',
      'open',
      'close',
      null,
    ]);
    expect(resolveBenchKey(key('g'), false)).toEqual({ action: null, chord: true });
    expect(['c', 'w', 'l', 'k', 'x'].map((k) => resolveBenchKey(key(k), true).action)).toEqual([
      'tool:console',
      'tool:webhooks',
      'tool:logs',
      'tool:keys',
      null,
    ]);
    expect(resolveBenchKey(key('Enter', document.body, { metaKey: true }), false).action).toBe('primary');
    expect(resolveBenchKey(key('Enter', document.body, { ctrlKey: true }), false).action).toBe('primary');
  });

  it('leaves typing alone, except Esc and ⌘↵; a focused control keeps Enter', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    document.body.append(input, button);
    expect(resolveBenchKey(key('j', input), false).action).toBeNull();
    expect(resolveBenchKey(key('g', input), false).chord).toBe(false);
    expect(resolveBenchKey(key('Escape', input), false).action).toBe('close');
    expect(resolveBenchKey(key('Enter', input, { metaKey: true }), false).action).toBe('primary');
    expect(resolveBenchKey(key('Enter', button), false).action).toBeNull();
    // A chord with a modifier is the browser's (⌘C), not the bench's.
    expect(resolveBenchKey(key('c', document.body, { metaKey: true }), false).action).toBeNull();
  });

  it('binds on the window, skips keys a control already took, and lets a g wait 1.2 s', () => {
    vi.useFakeTimers();
    const next = vi.fn();
    const logs = vi.fn();
    function Bound() {
      useBenchKeys({ next, 'tool:logs': logs });
      return null;
    }
    render(<Bound />);
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(next).toHaveBeenCalledTimes(1);
    const taken = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(next).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(logs).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'g' });
    act(() => vi.advanceTimersByTime(1300));
    fireEvent.keyDown(document.body, { key: 'l' });
    expect(logs).toHaveBeenCalledTimes(1);
  });

  it('? opens every shortcut in a sheet', () => {
    render(<BenchKeys tool="logs" />);
    fireEvent.keyDown(document.body, { key: '?' });
    const sheet = screen.getByRole('dialog', { name: 'Shortcuts' });
    expect(sheet.querySelectorAll('.bench-keys-r').length).toBeGreaterThan(8);
    expect(sheet.textContent).toContain('Copy the id');
  });
});
