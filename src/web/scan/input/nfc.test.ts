import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectNfcBridge } from './nfc-bridge.ts';
import { createNfcSource } from './nfc-source.ts';

afterEach(() => {
  delete (globalThis as { passbookNative?: unknown }).passbookNative;
  delete (window as { passbookNative?: unknown }).passbookNative;
});

describe('nfc bridge (interface only)', () => {
  it('is null on the web', () => {
    expect(detectNfcBridge()).toBeNull();
  });

  it('finds window.passbookNative.nfc when a native shell injects it', () => {
    const nfc = { available: async () => true, read: async () => ({ message: 'X' }) };
    (window as unknown as { passbookNative: unknown }).passbookNative = { nfc };
    expect(detectNfcBridge()).toBe(nfc);
  });

  it('a Hold near tap becomes an nfc read', async () => {
    const read = vi.fn(async () => ({ message: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }));
    const source = createNfcSource({ available: async () => true, read });
    const emitted: unknown[] = [];
    const stop = source.start((r) => emitted.push(r));
    await source.holdNear();
    expect(emitted).toEqual([{ method: 'nfc', code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }]);
    stop();
    await source.holdNear();
    expect(emitted).toHaveLength(1);
  });

  it('a cancelled read emits nothing', async () => {
    const source = createNfcSource({
      available: async () => true,
      read: async () => {
        throw new Error('cancelled');
      },
    });
    const emitted: unknown[] = [];
    source.start((r) => emitted.push(r));
    await source.holdNear();
    expect(emitted).toEqual([]);
  });
});
