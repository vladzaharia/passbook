import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ledger, makeCsr, resetLedger, seedPassType, stubApple } from './harness.ts';

const ROOT = 'pass.mobile.passbook';
const ptBody = (id: string, identifier: string) => ({
  id,
  type: 'passTypeIds',
  attributes: { identifier, name: 'X' },
});
const asc = 'https://api.appstoreconnect.apple.com';

beforeEach(resetLedger);

describe('PI-1 fix: M2 mismatched pass type is never remembered', () => {
  it('refuses a 201 for another identifier, stores nothing and orders no certificate', async () => {
    const foreign = stubApple(() => ({
      status: 201,
      body: { data: ptBody('FOREIGN', 'pass.mobile.passbook.henrys') },
    }));
    await expect(foreign.api.createPlatformPassType('root')).rejects.toThrow(/^ASC_REFUSED/);
    const rows = await env.DB.prepare('SELECT * FROM asc_pass_types').all();
    expect(rows.results).toHaveLength(0);
    // The retry hits Apple again instead of answering `existing` with the foreign id.
    const retry = stubApple(() => ({ status: 201, body: { data: ptBody('PTR', ROOT) } }));
    expect(await retry.api.createPlatformPassType('root')).toMatchObject({
      ascId: 'PTR',
      outcome: 'created',
    });
    expect(retry.seen).toHaveLength(1);
  });

  it('refuses a mismatched 201 for createPassType too', async () => {
    const { api } = stubApple(() => ({
      status: 201,
      body: { data: ptBody('P', 'pass.mobile.passbook.henrys') },
    }));
    await expect(api.createPassType('acme', 'Acme')).rejects.toThrow(/^ASC_REFUSED/);
    expect((await env.DB.prepare('SELECT * FROM asc_pass_types').all()).results).toHaveLength(0);
  });
});

describe('PI-1 fix: L1 owner-only revoke', () => {
  it.each([ROOT, 'pass.mobile.passbook.devtest'])(
    'refuses to revoke a %s certificate',
    async (id) => {
      await seedPassType(id, 'PT1');
      const { api, seen } = stubApple(() => ({
        body: {
          data: {
            id: 'C1',
            attributes: { certificateType: 'PASS_TYPE_ID' },
            relationships: { passTypeId: { data: { type: 'passTypeIds', id: 'PT1' } } },
          },
        },
      }));
      await expect(api.revokeCertificate('C1', 'compromised')).rejects.toThrow(
        /^ASC_REFUSED: Platform pass type certificates are revoked by the owner/,
      );
      expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
    },
  );
});

describe('PI-1 fix: L2 adopt lookup pages through every result', () => {
  it('follows links.next to the exact match and asks for 200 rows', async () => {
    const { api, seen } = stubApple(({ method, path }) => {
      if (method === 'POST') return { status: 409, body: { errors: [] } };
      if (path.includes('page=2')) return { body: { data: [ptBody('PTR', ROOT)] } };
      return {
        body: {
          data: Array.from({ length: 10 }, (_, i) =>
            ptBody(`H${i}`, `pass.mobile.passbook.h${i}x`),
          ),
          links: { next: `${asc}/v1/passTypeIds?filter[identifier]=${ROOT}&limit=200&page=2` },
        },
      };
    });
    expect(await api.createPlatformPassType('root')).toMatchObject({
      ascId: 'PTR',
      outcome: 'adopted',
    });
    expect(seen[1]?.path).toContain('limit=200');
    expect(seen).toHaveLength(3);
  });

  it('ignores a next link that leaves the Apple host', async () => {
    const { api, seen } = stubApple(({ method }) =>
      method === 'POST'
        ? { status: 409, body: { errors: [] } }
        : { body: { data: [], links: { next: 'https://evil.example/v1/passTypeIds?page=2' } } },
    );
    await expect(api.createPlatformPassType('root')).rejects.toThrow();
    expect(seen).toHaveLength(2);
  });
});

describe('PI-1 fix: L7 reserved handles and shared budget', () => {
  it.each(['admin', 'passbook', 'google', 'api'])(
    'refuses a certificate order for reserved handle %s',
    async (handle) => {
      const id = `pass.mobile.passbook.${handle}`;
      await seedPassType(id, 'PTX');
      const { api, seen } = stubApple(() => ({ body: {} }));
      await expect(api.createCertificate('PTX', await makeCsr(id), false)).rejects.toThrow(
        /^ASC_REFUSED: Reserved handle/,
      );
      expect(seen).toHaveLength(0);
    },
  );

  it('counts createPlatformPassType calls in the createPassType bucket', async () => {
    const { api } = stubApple(() => ({ status: 201, body: { data: ptBody('PTR', ROOT) } }));
    await api.createPlatformPassType('root');
    expect(
      (await ledger()).filter((r) => r.method === 'createPassType' && r.phase === 'start'),
    ).toHaveLength(1);
    expect((await ledger()).some((r) => r.method === 'createPlatformPassType')).toBe(false);
  });
});
