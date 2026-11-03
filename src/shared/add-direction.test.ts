import { describe, expect, it } from 'vitest';
import { addDirection, addMode } from './add-direction.ts';
import type { DeviceInfo } from './device.ts';

const IPHONE: DeviceInfo = { device: 'iphone', inApp: false };
const MAC: DeviceInfo = { device: 'mac', inApp: false };
const OTHER: DeviceInfo = { device: 'other', inApp: false };
const URL = 'https://wallet.test/p/t';

describe('addDirection', () => {
  it('reads a, b or c from ?add= where allowed', () => {
    expect(addDirection('?add=a', true)).toBe('a');
    expect(addDirection('?x=1&add=c', true)).toBe('c');
    expect(addDirection('?add=d', true)).toBeNull();
    expect(addDirection('', true)).toBeNull();
  });

  it('ignores it elsewhere (production)', () => {
    expect(addDirection('?add=b', false)).toBeNull();
  });
});

describe('addMode', () => {
  it('leads with the QR off the phone and the badge on it', () => {
    expect(addMode('active', MAC, false, URL)).toBe('scan');
    expect(addMode('active', OTHER, false, URL)).toBe('scan');
    expect(addMode('active', IPHONE, false, URL)).toBe('phone');
    // No public page to encode: the badge alone.
    expect(addMode('active', MAC, false, null)).toBe('phone');
  });

  it('confirms instead of asking once on a device, and offers nothing for a dead pass', () => {
    expect(addMode('active', MAC, true, URL)).toBe('added');
    expect(addMode('active', IPHONE, true, URL)).toBe('added');
    expect(addMode('voided', MAC, false, URL)).toBe('off');
    expect(addMode('expired', IPHONE, true, URL)).toBe('off');
  });
});
