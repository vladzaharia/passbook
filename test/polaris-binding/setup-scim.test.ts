import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCIM_ENDPOINT, TOKEN, TOKEN2 } from './fake-setup.ts';
import { captureLogs, dumpAll, ledger, resetLedger, userCtx } from './harness.ts';
import { setupCimd, writes } from './setup-harness.ts';

beforeEach(resetLedger);
afterEach(() => vi.restoreAllMocks());
const run = (r = 's1', over = {}) => userCtx({ ref: r, reason: 'setup', ...over });
const base = (layout: string) => (layout === 'admin' ? '/api/admin' : '/api');

describe.each(['v2', 'admin'] as const)('SCIM (%s layout)', (layout) => {
  describe('ensureScim', () => {
    it('creates the connection at PassBook own endpoint and reads it back', async () => {
      const h = setupCimd(layout);
      const res = await h.api.ensureScim(TOKEN, run());
      expect(res).toEqual({ result: 'created', dryRun: false });
      const post = h.pocket.writes()[0];
      expect(post).toMatchObject({ method: 'POST', path: `${base(layout)}/scim/service-provider` });
      expect(post?.body).toEqual({
        endpoint: SCIM_ENDPOINT,
        token: TOKEN,
        oidcClientId: 'https://passbook.mobile/auth/oidc/client-metadata.json',
      });
      expect(h.fake.sc.provider?.endpoint).toBe(SCIM_ENDPOINT);
    });

    it('is already with the same token, and rotates with another', async () => {
      const h = setupCimd(layout);
      await h.api.ensureScim(TOKEN, run('a'));
      h.clock.now += 61_000;
      expect(await h.api.ensureScim(TOKEN, run('b'))).toEqual({ result: 'already', dryRun: false });
      expect(h.pocket.writes()).toHaveLength(1);
      h.clock.now += 61_000;
      expect(await h.api.ensureScim(TOKEN2, run('c'))).toEqual({
        result: 'rotated',
        dryRun: false,
      });
      expect(h.pocket.writes()[1]).toMatchObject({
        method: 'PUT',
        path: `${base(layout)}/scim/service-provider/sp-1`,
      });
      expect(h.fake.sc.provider?.token).toBe(TOKEN2);
    });

    it('refuses a provider the owner pointed elsewhere, and never overwrites it', async () => {
      const h = setupCimd(layout);
      h.fake.sc.provider = {
        id: 'sp-1',
        endpoint: 'https://owner.test/scim/v2',
        token: TOKEN2,
        lastSyncedAt: null,
      };
      await expect(h.api.ensureScim(TOKEN, run())).rejects.toMatchObject({
        code: 'IDP_SCIM_FOREIGN',
      });
      expect(writes(h)).toEqual([]);
      expect(h.fake.sc.provider?.endpoint).toBe('https://owner.test/scim/v2');
    });

    it('refuses an open client', async () => {
      const h = setupCimd(layout);
      h.pocket.s.client.restricted = false;
      await expect(h.api.ensureScim(TOKEN, run())).rejects.toMatchObject({
        message: 'IDP_CLIENT: client_open',
      });
      expect(writes(h)).toEqual([]);
    });

    it('refuses a malformed token without echoing it', async () => {
      const h = setupCimd(layout);
      for (const bad of ['short', `${TOKEN} `, 'é'.repeat(43), 'A'.repeat(129), 5 as never]) {
        const e = await h.api.ensureScim(bad, run()).catch((x: Error) => x);
        expect(e).toMatchObject({ code: 'IDP_REFUSED', message: 'IDP_REFUSED: Invalid token.' });
      }
      expect(h.pocket.s.seen).toHaveLength(0);
    });

    it('takes the endpoint from config only: nothing the caller adds reaches the request', async () => {
      const h = setupCimd(layout);
      const hostile = {
        ...run(),
        endpoint: 'https://evil.test/scim',
        url: 'https://evil.test',
        id: 'x',
      };
      await (h.api.ensureScim as (t: string, c: unknown, ...rest: unknown[]) => Promise<unknown>)(
        TOKEN,
        hostile,
        'https://evil.test/scim',
      );
      expect(JSON.stringify(h.pocket.s.seen)).not.toContain('evil.test');
      expect(h.fake.sc.provider?.endpoint).toBe(SCIM_ENDPOINT);
    });

    it('refuses a plain client id: there is no origin to derive', async () => {
      const h = setupCimd(layout, { patch: { PASSBOOK_CLIENT_ID: 'client-1' } });
      h.pocket.s.client.id = 'client-1';
      await expect(h.api.ensureScim(TOKEN, run())).rejects.toMatchObject({ code: 'IDP_REFUSED' });
      expect(writes(h)).toEqual([]);
    });

    it('sends nothing on a dry run, and is IDP_DRIFT when the token does not come back', async () => {
      const d = setupCimd(layout);
      expect(await d.api.ensureScim(TOKEN, { ...run(), dryRun: true })).toEqual({
        result: 'created',
        dryRun: true,
      });
      expect(writes(d)).toEqual([]);
      expect(d.fake.sc.provider).toBeNull();
      const h = setupCimd(layout);
      const orig = h.pocket.s.extra;
      h.pocket.s.extra = (m, p, b) => {
        const r = orig?.(m, p, b);
        if (m === 'POST' && h.fake.sc.provider) h.fake.sc.provider.token = TOKEN2;
        return r;
      };
      await expect(h.api.ensureScim(TOKEN, run())).rejects.toMatchObject({ code: 'IDP_DRIFT' });
    });

    it('is budgeted in scim_write: one a minute', async () => {
      const h = setupCimd(layout);
      await h.api.ensureScim(TOKEN, run('a'));
      await expect(h.api.ensureScim(TOKEN2, run('b'))).rejects.toMatchObject({
        code: 'IDP_BUDGET',
      });
    });

    it('never lets the token reach the ledger, the logs, a result or an error', async () => {
      const h = setupCimd(layout);
      const { lines, result } = await captureLogs(() => h.api.ensureScim(TOKEN, run()));
      const status = await h.api.setupStatus({ tokenHashes: [] });
      expect(
        JSON.stringify([lines, result, status, await ledger(), await dumpAll()]),
      ).not.toContain(TOKEN);
      const err = await h.api.ensureScim(`${TOKEN}!`, run('z')).catch((e: Error) => e);
      expect(String((err as Error).message)).not.toContain(TOKEN);
    });
  });

  describe('syncScim', () => {
    it('posts the sync of the client provider and answers synced', async () => {
      const h = setupCimd(layout);
      await h.api.ensureScim(TOKEN, run('a'));
      expect(await h.api.syncScim(run('b'))).toEqual({ result: 'synced', dryRun: false });
      expect(h.pocket.writes()[1]).toMatchObject({
        method: 'POST',
        path: `${base(layout)}/scim/service-provider/sp-1/sync`,
      });
      expect(h.fake.sc.provider?.lastSyncedAt).toBe(h.clock.now);
    });

    it('waits 30 s for the sync and 5 s for every other request', async () => {
      const h = setupCimd(layout);
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      await h.api.ensureScim(TOKEN, run('a'));
      await h.api.syncScim(run('b'));
      const calls = timeout.mock.calls.map((c) => c[0]);
      expect(calls.filter((t) => t === 30_000)).toHaveLength(1);
      expect(calls.filter((t) => t === 5_000).length).toBe(calls.length - 1);
      expect(h.pocket.s.seen.at(-1)?.path).toMatch(/\/sync$/);
    });

    it('refuses without a provider, or one pointed elsewhere', async () => {
      const h = setupCimd(layout);
      await expect(h.api.syncScim(run())).rejects.toMatchObject({ code: 'IDP_NOT_FOUND' });
      h.fake.sc.provider = {
        id: 'sp-1',
        endpoint: 'https://owner.test/scim/v2',
        token: TOKEN,
        lastSyncedAt: null,
      };
      h.clock.now += 61_000;
      await expect(h.api.syncScim(run('b'))).rejects.toMatchObject({ code: 'IDP_SCIM_FOREIGN' });
      expect(writes(h)).toEqual([]);
    });

    it('answers IDP_UPSTREAM without forwarding Polaris ID text', async () => {
      const h = setupCimd(layout);
      h.fake.sc.provider = {
        id: 'sp-1',
        endpoint: SCIM_ENDPOINT,
        token: TOKEN,
        lastSyncedAt: null,
      };
      h.pocket.s.failWith = {
        match: /POST .*\/sync$/,
        status: 500,
        body: { message: 'secret detail' },
      };
      const e = await h.api.syncScim(run()).catch((x: Error) => x);
      expect(e).toMatchObject({ code: 'IDP_UPSTREAM' });
      expect(String((e as Error).message)).not.toContain('secret detail');
    });

    it('sends nothing on a dry run, and is budgeted at one a minute', async () => {
      const h = setupCimd(layout);
      h.fake.sc.provider = {
        id: 'sp-1',
        endpoint: SCIM_ENDPOINT,
        token: TOKEN,
        lastSyncedAt: null,
      };
      expect(await h.api.syncScim({ ...run('a'), dryRun: true })).toEqual({
        result: 'synced',
        dryRun: true,
      });
      expect(writes(h)).toEqual([]);
      await h.api.syncScim(run('b'));
      await h.api.syncScim(run('c')).then(
        () => expect.unreachable(),
        (e: Error) => expect(e).toMatchObject({ code: 'IDP_BUDGET' }),
      );
    });

    it('stops when frozen', async () => {
      const h = setupCimd(layout);
      await h.api.freeze('check', run('f'));
      await expect(h.api.syncScim(run())).rejects.toMatchObject({ code: 'IDP_FROZEN' });
    });
  });
});
