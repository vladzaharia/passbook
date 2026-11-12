import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeClock } from '../machine/store.test-support.ts';
import type { RawRead } from './types.ts';
import { WEDGE_SLOW, WEDGE_STANDARD } from './wedge-detector.ts';
import { createWedgeSource, WedgeFields } from './wedge-source.ts';

const CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NFC_CODE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.replace(/[^A-Z2-7]/g, 'A').slice(0, 26);

const CODE_OF: Record<string, string> = {
  '-': 'Minus',
  '/': 'Slash',
  '.': 'Period',
  ':': 'Semicolon',
};
const codeFor = (ch: string) =>
  /[A-Za-z]/.test(ch)
    ? `Key${ch.toUpperCase()}`
    : /\d/.test(ch)
      ? `Digit${ch}`
      : (CODE_OF[ch] ?? '');

function setup(over: { slow?: boolean } = {}) {
  const clock = fakeClock();
  const fields = new WedgeFields();
  const emitted: RawRead[] = [];
  const humans: string[] = [];
  const focus: boolean[] = [];
  const layout: number[] = [];
  const source = createWedgeSource({
    clock,
    fields,
    config: () => (over.slow ? WEDGE_SLOW : WEDGE_STANDARD),
    onHuman: (ch) => humans.push(ch),
    onFocus: (f) => focus.push(f),
    onBadLayout: (n) => layout.push(n),
  });
  const stop = source.start((r) => emitted.push(r));
  /** Sends one keydown to `target`; like a browser, inserts the character into an input unless prevented. */
  function key(target: Element, init: KeyboardEventInit & { type?: string } = {}) {
    const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    if (!ev.defaultPrevented && target instanceof HTMLInputElement && init.key?.length === 1)
      target.value += init.key;
    return ev;
  }
  function burst(
    target: Element,
    text: string,
    gap: number,
    end: 'Enter' | 'Tab' | null = 'Enter',
  ) {
    const events: KeyboardEvent[] = [];
    for (const [i, ch] of [...text].entries()) {
      if (i > 0) clock.advance(gap);
      events.push(key(target, { code: codeFor(ch), key: ch, shiftKey: /[A-Z]/.test(ch) }));
    }
    if (end) {
      clock.advance(gap);
      events.push(key(target, { code: end, key: end }));
    }
    return events;
  }
  return { clock, fields, emitted, humans, focus, layout, stop, key, burst };
}

let env: ReturnType<typeof setup>;
beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => env?.stop());

describe('createWedgeSource', () => {
  it('a burst while a button has focus is a scan and never presses the button', () => {
    env = setup();
    const button = document.createElement('button');
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    document.body.append(button);
    button.focus();
    const events = env.burst(button, CODE, 8);
    expect(env.emitted).toEqual([{ method: 'wedge', code: CODE }]);
    expect(events.at(-1)?.defaultPrevented).toBe(true);
    expect(events.slice(1, -1).every((e) => e.defaultPrevented)).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('a burst into a registered field restores the field, keeps focus and emits a scan', () => {
    env = setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    input.value = 'an';
    const setValue = vi.fn((v: string) => {
      input.value = v;
    });
    env.fields.register(input, setValue);
    const events = env.burst(input, CODE, 8);
    expect(setValue).toHaveBeenLastCalledWith('an');
    expect(input.value).toBe('an');
    expect(document.activeElement).toBe(input);
    expect(env.emitted).toEqual([{ method: 'wedge', code: CODE }]);
    expect(events.at(-1)?.defaultPrevented).toBe(true);
  });

  it('a person typing into a registered field is left alone', () => {
    env = setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const setValue = vi.fn();
    env.fields.register(input, setValue);
    const events = env.burst(input, 'anna', 120, null);
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
    expect(input.value).toBe('anna');
    expect(setValue).not.toHaveBeenCalled();
    expect(env.emitted).toEqual([]);
    env.clock.advance(1000);
    expect(env.humans).toEqual([]);
  });

  it('a burst into an unregistered input is ignored', () => {
    env = setup();
    const input = document.createElement('input');
    document.body.append(input);
    const events = env.burst(input, CODE, 8);
    expect(env.emitted).toEqual([]);
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
  });

  it('one slow key with nothing focused opens lookup with that character', () => {
    env = setup();
    env.key(document.body, { code: 'KeyA', key: 'a' });
    env.clock.advance(WEDGE_STANDARD.idleAcceptMs);
    expect(env.humans).toEqual(['a']);
    expect(env.emitted).toEqual([]);
  });

  it('10 characters at 5 ms with no terminator scan after 150 ms of quiet', () => {
    env = setup();
    env.burst(document.body, '0123456789', 5, null);
    expect(env.emitted).toEqual([]);
    env.clock.advance(WEDGE_STANDARD.idleAcceptMs);
    expect(env.emitted).toEqual([{ method: 'wedge', code: '0123456789' }]);
  });

  it('Tab terminates a scan and is prevented', () => {
    env = setup();
    const events = env.burst(document.body, CODE, 8, 'Tab');
    expect(events.at(-1)?.defaultPrevented).toBe(true);
    expect(env.emitted).toHaveLength(1);
  });

  it('keeps NFC-shaped keyboard input classified as a wedge', () => {
    env = setup();
    env.burst(document.body, NFC_CODE, 8);
    expect(env.emitted[0]?.method).toBe('wedge');
  });

  it('Ctrl, Meta and Alt chords and repeats reset the buffer', () => {
    env = setup();
    const t = document.body;
    for (const [i, ch] of [...'ABCDEF'].entries()) {
      env.clock.advance(i ? 8 : 0);
      env.key(t, { code: codeFor(ch), key: ch });
    }
    env.clock.advance(8);
    env.key(t, { code: 'KeyV', key: 'v', ctrlKey: true });
    env.clock.advance(8);
    env.key(t, { code: 'Enter', key: 'Enter' });
    expect(env.emitted).toEqual([]);
  });

  it('WEDGE_SLOW takes a Bluetooth reader that batches', () => {
    env = setup({ slow: true });
    env.burst(document.body, CODE, 70);
    expect(env.emitted).toHaveLength(1);
  });

  it('counts bursts whose characters came through the event.key fallback outside the alphabet', () => {
    env = setup();
    const t = document.body;
    for (let n = 0; n < 3; n++) {
      for (const [i, ch] of [...'éüöäß#'].entries()) {
        env.clock.advance(i ? 8 : 400);
        env.key(t, { code: '', key: ch });
      }
      env.clock.advance(8);
      env.key(t, { code: 'Enter', key: 'Enter' });
    }
    expect(env.layout).toEqual([1, 2, 3]);
    expect(env.emitted).toHaveLength(3);
  });

  it('reports window blur and focus', () => {
    env = setup();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    expect(env.focus).toEqual([false, true]);
  });

  it('stop removes the listeners', () => {
    env = setup();
    env.stop();
    env.burst(document.body, CODE, 8);
    expect(env.emitted).toEqual([]);
    window.dispatchEvent(new Event('blur'));
    expect(env.focus).toEqual([]);
  });
});
