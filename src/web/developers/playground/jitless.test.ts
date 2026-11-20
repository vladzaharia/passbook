import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { disableZodCompiling, ZOD_CONFIG_KEY } from './jitless.ts';

describe('playground jitless switch', () => {
  it('is the object zod reads its config from, so a zod upgrade that moves it fails here', () => {
    disableZodCompiling();
    expect(z.config()).toBe((globalThis as unknown as Record<string, unknown>)[ZOD_CONFIG_KEY]);
    expect(z.config().jitless).toBe(true);
  });
});
