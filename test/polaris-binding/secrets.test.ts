import { beforeEach, describe, expect, it } from 'vitest';
import {
  API_KEY,
  captureLogs,
  ctx,
  dumpAll,
  ledger,
  resetLedger,
  seedGrant,
  setup,
} from './harness.ts';

beforeEach(resetLedger);

const SECRETS = [API_KEY, 'SECRETTOKEN', 'abcdef', '/st/', 'found.person', '@example.test'];

describe.each(['v2', 'admin'] as const)(
  'secrets stay out of logs, errors and tables (%s)',
  (layout) => {
    it('through success, refusal, drift, auth, upstream and budget paths', async () => {
      const s = setup(layout);
      s.pocket.addUser('u1');
      s.pocket.addUser('u2');
      s.pocket.addUser('adm', { isAdmin: true });
      await seedGrant('u2');
      s.pocket.addUser('found', { email: 'found.person@example.test' });
      const errors: string[] = [];
      const run = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          errors.push(String((e as Error).message));
        }
      };

      const logs = await captureLogs(async () => {
        const link = await s.api.createSignup('developer', ctx({ ref: 'inv-1' }));
        expect((link as { url: string }).url).toContain('SECRETTOKEN1');
        s.pocket.signUp('tok-id-1', 'u-new');
        await s.api.proveSignup(['tok-id-1'], 'u-new');
        await s.api.apply('u1', { add: ['developer'] }, ctx({ ref: 'inv-1' }));
        await s.api.apply('u1', { remove: ['developer'] }, ctx({ reason: 'ended' }));
        await s.api.findByVerifiedEmail('found.person@example.test', ctx());
        await s.api.snapshot(ctx());
        await run(() => s.api.apply('adm', { add: ['developer'] }, ctx({ ref: 'inv-1' })));
        s.pocket.s.putTransform = (ids) => [...ids, 'g-admins'];
        await run(() => s.api.apply('u2', { add: ['console'] }, ctx({ ref: 'inv-2' })));
        s.pocket.s.putTransform = undefined;
        // A Polaris ID that echoes the key and a token in its error bodies.
        s.pocket.s.failWith = {
          match: /^POST /,
          status: 401,
          body: { message: `bad key ${API_KEY}`, token: 'SECRETTOKEN9abcdef' },
        };
        await run(() => s.api.createSignup('member', ctx({ ref: 'inv-3' })));
        s.pocket.s.failWith = {
          match: /signup-tokens/,
          status: 500,
          body: `SECRETTOKEN7abcdef ${API_KEY}`,
        };
        await run(() => s.api.createSignup('member', ctx({ ref: 'inv-4' })));
        await run(() => s.api.deleteSignup('tok-id-1', ctx()));
        s.pocket.s.failWith = undefined;
        s.pocket.s.config.allowUserSignups = 'open';
        s.clock.now += 11 * 60_000;
        await run(() => s.api.createSignup('member', ctx({ ref: 'inv-5' })));
      });

      const everything = [
        ...logs.lines,
        ...errors,
        await dumpAll(),
        JSON.stringify(await ledger()),
      ];
      for (const secret of SECRETS)
        for (const text of everything) expect(text).not.toContain(secret);
      expect(logs.lines.some((l) => l.includes('binding.idp_auth'))).toBe(true);
      expect(logs.lines.some((l) => l.includes('binding.drift'))).toBe(true);
      expect(errors.some((e) => e.startsWith('IDP_AUTH'))).toBe(true);
      // The key travelled only in the header of every request.
      expect(s.pocket.s.seen.every((r) => r.key === API_KEY)).toBe(true);
      expect(JSON.stringify(s.pocket.s.seen.map((r) => [r.path, r.body]))).not.toContain(API_KEY);
    });

    it('keeps Polaris ID error text out of the thrown message', async () => {
      const s = setup(layout);
      await s.api.health();
      s.pocket.s.failWith = {
        match: /^POST /,
        status: 409,
        body: { message: 'secret-detail-from-pocket-id' },
      };
      await expect(s.api.createSignup('member', ctx())).rejects.toThrow(
        /^IDP_CONFLICT: Polaris ID answered 409\.$/,
      );
    });
  },
);
