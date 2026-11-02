import { describe, expect, it } from 'vitest';
import { readCapped } from './read-capped.ts';

const stream = (...parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
const tooLarge = () => new Error('big');

describe('readCapped', () => {
  it('joins chunks within the cap', async () => {
    const bytes = await readCapped(stream('ab', 'cd'), 4, tooLarge);
    expect(new TextDecoder().decode(bytes)).toBe('abcd');
  });

  it('throws as soon as the count passes the cap', async () => {
    await expect(readCapped(stream('ab', 'cde'), 4, tooLarge)).rejects.toThrow('big');
  });

  it('refuses a declared length over the cap without reading', async () => {
    await expect(readCapped(stream('a'), 4, tooLarge, 5)).rejects.toThrow('big');
  });

  it('returns nothing for a missing body', async () => {
    expect((await readCapped(null, 4, tooLarge)).byteLength).toBe(0);
  });
});
