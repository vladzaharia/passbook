import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fixtureOutcome } from '../machine/fixture-data.test-support.ts';
import { buzz, HAPTIC_PATTERNS } from './haptics.ts';
import { useVerdictHaptic } from './use-verdict-haptic.ts';

describe('buzz', () => {
  it('uses one pulse for ok, two for a heads-up and three for a refusal', () => {
    expect(HAPTIC_PATTERNS.ok).toHaveLength(1);
    expect(HAPTIC_PATTERNS.heads_up).toHaveLength(3);
    expect(HAPTIC_PATTERNS.refused).toHaveLength(5);
  });

  it('goes through the native bridge when there is one, and not the Vibration API', () => {
    const bridge = { postMessage: vi.fn() };
    const vibrate = vi.fn(() => true);
    expect(buzz('refused', bridge, { vibrate }, true)).toBe(true);
    expect(bridge.postMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(bridge.postMessage.mock.calls[0]?.[0] as string)).toEqual({
      version: 1,
      op: 'haptic',
      pattern: [...HAPTIC_PATTERNS.refused],
    });
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('a shell that does not report haptics gets the Vibration API, not the op', () => {
    const bridge = { postMessage: vi.fn() };
    const vibrate = vi.fn(() => true);
    expect(buzz('ok', bridge, { vibrate }, false)).toBe(true);
    expect(bridge.postMessage).not.toHaveBeenCalled();
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('ignores a kind that is not its own', () => {
    expect(buzz('constructor', undefined, { vibrate: vi.fn() })).toBe(false);
    expect(buzz('toString', undefined, { vibrate: vi.fn() })).toBe(false);
  });

  it('falls back to the Vibration API on the web', () => {
    const vibrate = vi.fn(() => true);
    expect(buzz('ok', undefined, { vibrate })).toBe(true);
    expect(vibrate).toHaveBeenCalledWith([...HAPTIC_PATTERNS.ok]);
  });

  it('does nothing where neither exists (iOS Safari), or for a kind with no pattern', () => {
    expect(buzz('ok', undefined, {} as Navigator)).toBe(false);
    expect(buzz('ready', { postMessage: vi.fn() }, { vibrate: vi.fn() }, true)).toBe(false);
    expect(buzz('system', undefined, { vibrate: vi.fn() })).toBe(false);
  });
});

describe('useVerdictHaptic', () => {
  function spy() {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    return vibrate;
  }

  it('buzzes once per verdict, not per render', () => {
    const vibrate = spy();
    const ok = fixtureOutcome('ok');
    const { rerender } = renderHook(({ o }) => useVerdictHaptic(o), { initialProps: { o: ok } });
    rerender({ o: ok });
    rerender({ o: ok });
    expect(vibrate).toHaveBeenCalledTimes(1);
    rerender({ o: fixtureOutcome('refused', 'voided') });
    expect(vibrate).toHaveBeenCalledTimes(2);
    expect(vibrate).toHaveBeenLastCalledWith([...HAPTIC_PATTERNS.refused]);
  });

  it('is silent with no verdict, a replay or a decision made on the device', () => {
    const vibrate = spy();
    const { rerender } = renderHook(({ o }) => useVerdictHaptic(o), {
      initialProps: { o: null as ReturnType<typeof fixtureOutcome> | null },
    });
    rerender({ o: fixtureOutcome('ok', null, { replay: true }) });
    rerender({ o: fixtureOutcome('refused', 'network', { local: true }) });
    expect(vibrate).not.toHaveBeenCalled();
  });
});
