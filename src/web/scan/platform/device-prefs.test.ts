import { describe, expect, it, vi } from 'vitest';
import { loadDevicePrefs, saveDevicePref } from './device-prefs.ts';

const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

describe('device prefs', () => {
  it('start off, and come back as saved', () => {
    const store = memory();
    expect(loadDevicePrefs(store)).toEqual({ sunlight: false, leftHand: false });
    saveDevicePref('sunlight', true, store);
    saveDevicePref('leftHand', true, store);
    expect(loadDevicePrefs(store)).toEqual({ sunlight: true, leftHand: true });
    saveDevicePref('sunlight', false, store);
    expect(loadDevicePrefs(store)).toEqual({ sunlight: false, leftHand: true });
  });

  it('survive a store that throws', () => {
    const broken = {
      getItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      setItem: vi.fn(() => {
        throw new Error('blocked');
      }),
    };
    expect(loadDevicePrefs(broken)).toEqual({ sunlight: false, leftHand: false });
    expect(() => saveDevicePref('sunlight', true, broken)).not.toThrow();
  });
});
