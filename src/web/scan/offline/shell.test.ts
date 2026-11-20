import { describe, expect, it } from 'vitest';
import { keptSession } from './shell.ts';

describe('kept session', () => {
  it('is none when storage has nothing', async () => {
    expect(await keptSession()).toBeNull();
  });
});
