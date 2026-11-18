import { describe, expect, it, vi } from 'vitest';
import { createDirectionPin, PIN_LAPSE_MS } from './direction-pin.ts';
import type { ClockPort } from './ports.ts';

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const clock: ClockPort = {
    now: () => now,
    setTimeout(fn, ms) {
      timers.set(++id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [key, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(key);
        t.fn();
      }
    }
  };
  return { clock, advance };
}

describe('the direction pin', () => {
  it('starts on Auto', () => {
    expect(createDirectionPin(fakeClock().clock).get()).toBeNull();
  });
  it('lapses to Auto after 15 minutes without a scan', () => {
    const { clock, advance } = fakeClock();
    const pin = createDirectionPin(clock);
    const seen = vi.fn();
    pin.subscribe(seen);
    pin.set('out');
    expect(pin.get()).toBe('out');
    advance(PIN_LAPSE_MS - 1);
    expect(pin.get()).toBe('out');
    advance(1);
    expect(pin.get()).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
  });
  it('a scan keeps the pin alive', () => {
    const { clock, advance } = fakeClock();
    const pin = createDirectionPin(clock);
    pin.set('in');
    advance(PIN_LAPSE_MS - 1000);
    pin.touch();
    advance(PIN_LAPSE_MS - 1000);
    expect(pin.get()).toBe('in');
    advance(1000);
    expect(pin.get()).toBeNull();
  });
  it('touching Auto starts no timer, and Auto cancels one', () => {
    const { clock, advance } = fakeClock();
    const pin = createDirectionPin(clock);
    pin.touch();
    pin.set('in');
    pin.set(null);
    advance(PIN_LAPSE_MS * 2);
    expect(pin.get()).toBeNull();
  });
});
