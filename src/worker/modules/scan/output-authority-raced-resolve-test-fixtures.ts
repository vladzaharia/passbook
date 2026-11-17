import { expect } from 'vitest';
import {
  type Change,
  changeAfterProjection,
  kit,
  noDisclosure,
  type OutputFixture,
  raceFence,
} from './repo-output-authority-split-test-fixtures.ts';
import { key } from './test-kit.ts';

/** Pass content, not authority: a read that raced one answers what it read, and the next read shows it. */
export const CONTENT_CHANGES = [
  'wallet',
  'wallet-personalization',
  'wallet-lineage',
  'wallet-version',
  'identity-aba',
  'rules',
  'source-privacy',
] as const;

export async function racedResolve(f: OutputFixture, change: Change) {
  const real = kit.env.DB;
  const race = raceFence(real, () => changeAfterProjection(f, real, change));
  Object.assign(kit.env, { DB: race.db });
  try {
    const response = await kit.post(f.scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: { passId: f.pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(race.fired()).toBe(true);
    const text = await response.text();
    const body = JSON.parse(text);
    // Identical to the pass's own release, or content: nothing a scanner may act on changed. One that
    // differs from the pass's own release is a real change: retryable, nothing disclosed. Every
    // authority change refuses as an absent pass.
    if (change === 'release' || (CONTENT_CHANGES as readonly string[]).includes(change))
      return expect(body).toMatchObject({ card: { passId: f.pass.id } });
    expect(response.status).toBe(change === 'release-adapter' ? 409 : 200);
    expect(body).toMatchObject(
      change === 'release-adapter'
        ? { code: 'SCAN_PASS_CHANGED' }
        : { kind: 'refused', reason: 'not_found', card: null, display: null, template: null },
    );
    noDisclosure(text, f.pass.id);
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}
