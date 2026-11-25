import { beforeEach, describe, expect, it } from 'vitest';
import { API_KEY, captureLogs, dumpAll, ledger, resetLedger, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

const SECRETS = [API_KEY, 'SECRETTOKEN', 'abcdef', '/st/'];

describe.each(['v2', 'admin'] as const)(
  'secrets stay out of logs, errors and tables (%s)',
  (layout) => {
    it('through success, refusal, drift, auth, upstream and budget paths', async () => {
      const s = setup(layout);
      s.pocket.addUser('u1');
      s.pocket.addUser('u2');
      s.pocket.addUser('adm', { isAdmin: true });
      await seedGrant('u2');
      const errors: string[] = [];
      const run = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          errors.push(String((e as Error).message));
        }
      };

      const logs = await captureLogs(async () => {
        const link = await s.api.createSignup('inv-1');
        expect(link.url).toContain('SECRETTOKEN1');
        s.pocket.signUp('tok-id-1', 'u-new');
        await s.api.proveSignup(['tok-id-1'], 'u-new');
        await s.api.addDeveloper('u1', 'inv-1');
        await s.api.removeDeveloper('u1', 'ended');
        await run(() => s.api.addDeveloper('adm', 'inv-1'));
        s.pocket.s.putTransform = (ids) => [...ids, 'g-admins'];
        await run(() => s.api.addDeveloper('u2', 'inv-2'));
        s.pocket.s.putTransform = undefined;
        // A Pocket ID that echoes the key and a token in its error bodies.
        s.pocket.s.failWith = {
          match: /^POST /,
          status: 401,
          body: { message: `bad key ${API_KEY}`, token: 'SECRETTOKEN9abcdef' },
        };
        await run(() => s.api.createSignup('inv-3'));
        s.pocket.s.failWith = {
          match: /signup-tokens/,
          status: 500,
          body: `SECRETTOKEN7abcdef ${API_KEY}`,
        };
        await run(() => s.api.createSignup('inv-4'));
        await run(() => s.api.deleteSignup('tok-id-1'));
        s.pocket.s.failWith = undefined;
        s.pocket.s.config.allowUserSignups = 'open';
        s.clock.now += 11 * 60_000;
        await run(() => s.api.createSignup('inv-5'));
      });

      const everything = [
        ...logs.lines,
        ...errors,
        await dumpAll(),
        JSON.stringify(await ledger()),
      ];
      for (const secret of SECRETS)
        for (const text of everything) expect(text).not.toContain(secret);
      expect(logs.lines.some((l) => l.includes('provisioner.idp_auth'))).toBe(true);
      expect(logs.lines.some((l) => l.includes('provisioner.drift'))).toBe(true);
      expect(errors.some((e) => e.startsWith('IDP_AUTH'))).toBe(true);
      // The key travelled only in the header of every request.
      expect(s.pocket.s.seen.every((r) => r.key === API_KEY)).toBe(true);
      expect(JSON.stringify(s.pocket.s.seen.map((r) => [r.path, r.body]))).not.toContain(API_KEY);
    });

    it('keeps Pocket ID error text out of the thrown message', async () => {
      const s = setup(layout);
      await s.api.health();
      s.pocket.s.failWith = {
        match: /^POST /,
        status: 409,
        body: { message: 'secret-detail-from-pocket-id' },
      };
      await expect(s.api.createSignup('r1')).rejects.toThrow(
        /^IDP_CONFLICT: Pocket ID answered 409\.$/,
      );
    });
  },
);
