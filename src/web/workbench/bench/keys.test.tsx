import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSingleKeys } from '../shell/prefs.ts';
import { type BenchKey, resolveBenchKey, useBenchKeys } from './keys.ts';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  setSingleKeys(true);
});

const key = (
  k: string,
  target: EventTarget | null = document.body,
  mods: Partial<BenchKey> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target,
  ...mods,
});

describe('bench keys', () => {
  it('maps the list keys; g chords and ? belong to the shell', () => {
    const one = (k: string) => resolveBenchKey(key(k));
    expect(['j', 'k', 'y', 'c', 'Enter', 'Escape', 'x', 'g', '?'].map(one)).toEqual([
      'next',
      'prev',
      'copyId',
      'copyCurl',
      'open',
      'close',
      null,
      null,
      null,
    ]);
    expect(resolveBenchKey(key('Enter', document.body, { metaKey: true }))).toBe('primary');
    expect(resolveBenchKey(key('Enter', document.body, { ctrlKey: true }))).toBe('primary');
  });

  it('leaves typing alone, except Esc and ⌘↵; a focused control keeps Enter', () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    document.body.append(input, button);
    expect(resolveBenchKey(key('j', input))).toBeNull();
    expect(resolveBenchKey(key('Escape', input))).toBe('close');
    expect(resolveBenchKey(key('Enter', input, { metaKey: true }))).toBe('primary');
    expect(resolveBenchKey(key('Enter', button))).toBeNull();
    // A chord with a modifier is the browser's (⌘C), not the bench's.
    expect(resolveBenchKey(key('c', document.body, { metaKey: true }))).toBeNull();
  });

  it('stops every single key with the off-switch, keeping Esc, ⌘↵ and Enter on a row', () => {
    expect(resolveBenchKey(key('j'), false)).toBeNull();
    expect(resolveBenchKey(key('y'), false)).toBeNull();
    expect(resolveBenchKey(key('Escape'), false)).toBe('close');
    expect(resolveBenchKey(key('Enter', document.body, { metaKey: true }), false)).toBe('primary');
    expect(resolveBenchKey(key('Enter'), false)).toBe('open');
  });

  it('binds on the window, skips keys a control already took, and obeys the off-switch', () => {
    const next = vi.fn();
    function Bound() {
      useBenchKeys({ next });
      return null;
    }
    render(<Bound />);
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(next).toHaveBeenCalledTimes(1);
    const taken = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(next).toHaveBeenCalledTimes(1);
    setSingleKeys(false);
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
