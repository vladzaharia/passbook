import { afterEach, describe, expect, it, vi } from 'vitest';
import { buzz, canBuzz, HAPTIC_PATTERNS, setHapticSender } from './haptics.ts';

afterEach(() => setHapticSender(null));

describe('haptic sender', () => {
  it('buzz uses the sender and neither the v1 bridge nor the Vibration API', () => {
    const send = vi.fn();
    const bridge = { postMessage: vi.fn() };
    const vibrate = vi.fn(() => true);
    setHapticSender(send);
    expect(buzz('ok', bridge, { vibrate }, true)).toBe(true);
    expect(send).toHaveBeenCalledWith([...HAPTIC_PATTERNS.ok]);
    expect(bridge.postMessage).not.toHaveBeenCalled();
    expect(vibrate).not.toHaveBeenCalled();
    expect(canBuzz(undefined, undefined, false)).toBe(true);
  });

  it("keeps today's path once the sender is cleared", () => {
    const bridge = { postMessage: vi.fn() };
    setHapticSender(vi.fn());
    setHapticSender(null);
    expect(buzz('ok', bridge, undefined, true)).toBe(true);
    expect(JSON.parse(bridge.postMessage.mock.calls[0]?.[0] as string).version).toBe(1);
    expect(canBuzz(undefined, undefined, false)).toBe(false);
  });
});
