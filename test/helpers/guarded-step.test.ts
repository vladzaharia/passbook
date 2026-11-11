import { describe, expect, it } from 'vitest';
import { derivedHmacKey } from '../../src/worker/platform/crypto.ts';
import { makeEnv } from './env.ts';
import { guardWrites } from './guarded-step.ts';

describe('guardWrites', () => {
  it('preserves enumerable bindings while replacing the database', async () => {
    const base = await makeEnv();
    const guarded = guardWrites(base);
    expect(guarded.env.DB).not.toBe(base.DB);
    expect(guarded.env.BUCKET).toBe(base.BUCKET);
    expect(Object.entries(guarded.env)).toContainEqual(['KEK_V1', base.KEK_V1]);
    await expect(derivedHmacKey(guarded.env, 'guarded-step-test')).resolves.toBeDefined();
  });
});
