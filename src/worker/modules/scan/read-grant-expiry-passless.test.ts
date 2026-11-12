import { describe, expect, it, vi } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { clearSettingsCache } from '../settings/service.ts';
import {
  interceptBatches,
  kit,
  registerLookupOutputFixture,
  templateId,
} from './lookup-output-test-fixtures.ts';
import { grants, principal } from './read-grant-expiry-core-test-fixtures.ts';
import { key } from './test-kit.ts';

registerLookupOutputFixture();

describe('passless resolve final-clock authority', () => {
  it.each(['session idle', 'session absolute'] as const)(
    'does not reveal a mode hint when %s expires during input proof preparation',
    async (kind) => {
      const pass = await kit.scanPass(
        templateId,
        { memberName: 'Private Other Mode Member' },
        { mode: 'test' },
      );
      if (!pass.scanCode) throw new Error('Missing scan code');
      const code = pass.scanCode;
      const actor = await principal(kind);
      const body = () => ({
        idempotencyKey: key(),
        input: { code, method: 'camera' },
        clientTs: kit.clock.now(),
      });
      const baseline = await actor.post('resolve', body());
      expect(baseline.status).toBe(200);
      expect(ScanOutcomeSchema.parse(await baseline.json())).toMatchObject({
        reason: 'test_pass',
        card: null,
      });
      expect(await grants()).toBe(0);

      const real = kit.env.DB;
      const counted = countD1(real);
      let candidateBatch = false;
      let fired = false;
      const traced = interceptBatches(counted.db, async (sql) => {
        if (sql.some((text) => text.includes('INSERT INTO credential_ref_keyset')))
          candidateBatch = true;
      });
      Object.assign(kit.env, { DB: traced.db });
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
      try {
        expect((await actor.post('resolve', {})).status).toBe(422);
        const guard = counted.count();
        counted.reset();
        clearSettingsCache(traced.db);
        const digest = vi
          .spyOn(crypto.subtle, 'digest')
          .mockImplementation(async (algorithm, data) => {
            const result = await nativeDigest(algorithm, data);
            if (candidateBatch && !fired && new TextDecoder().decode(data) === code) {
              fired = true;
              kit.clock.advance(actor.advance);
            }
            return result;
          });
        try {
          const response = await actor.post('resolve', body());
          expect(fired).toBe(true);
          expect(counted.count() - guard).toBeLessThanOrEqual(5);
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(ScanOutcomeSchema.parse(JSON.parse(text))).toMatchObject({
            kind: 'refused',
            reason: 'not_found',
            card: null,
            display: null,
            template: null,
          });
          for (const secret of [
            pass.id,
            pass.serial,
            code,
            'Private Other Mode Member',
            'test_pass',
          ])
            expect(text).not.toContain(secret);
        } finally {
          digest.mockRestore();
        }
      } finally {
        Object.assign(kit.env, { DB: real });
      }
      expect(await grants()).toBe(0);
    },
  );
});
