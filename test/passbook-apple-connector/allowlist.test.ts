import { beforeEach, describe, expect, it } from 'vitest';
import { AppleProvisioner } from '../../workers/passbook-apple-connector/src/index.ts';
import { ledger, makeCsr, resetLedger, seedPassType, stubApple } from './harness.ts';

const PTI = 'pass.mobile.passbook.henrys';
const passTypeBody = (id: string, identifier: string) => ({
  data: { id, type: 'passTypeIds', attributes: { identifier, name: 'Henrys (PassBook)' } },
});

beforeEach(resetLedger);

describe('passbook-apple-connector allowlist', () => {
  it('exposes exactly the seven RPC methods', () => {
    expect(Object.getOwnPropertyNames(AppleProvisioner.prototype).sort()).toEqual(
      [
        'calls',
        'constructor',
        'createCertificate',
        'createPassType',
        'findPassType',
        'listCertificates',
        'reportCertificateActive',
        'revokeCertificate',
      ].sort(),
    );
  });

  it('creates a pass type under the managed prefix and remembers it', async () => {
    const { api, seen } = stubApple(() => ({ status: 201, body: passTypeBody('PT1', PTI) }));
    expect(await api.createPassType('henrys', 'Henrys (PassBook)')).toEqual({
      ascId: 'PT1',
      identifier: PTI,
      name: 'Henrys (PassBook)',
      outcome: 'created',
    });
    expect(seen[0]?.path).toBe('/v1/passTypeIds');
    expect(seen[0]?.body).toEqual({
      data: { type: 'passTypeIds', attributes: { identifier: PTI, name: 'Henrys (PassBook)' } },
    });
    expect((await api.createPassType('henrys', 'Henrys (PassBook)')).outcome).toBe('existing');
    expect(seen).toHaveLength(1);
  });

  it('adopts a pass type Apple already has when create answers 409', async () => {
    const { api } = stubApple(({ method }) =>
      method === 'POST'
        ? { status: 409, body: { errors: [{ code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE' }] } }
        : { body: { data: [passTypeBody('PT9', PTI).data] } },
    );
    expect(await api.createPassType('henrys', 'Henrys (PassBook)')).toMatchObject({
      ascId: 'PT9',
      outcome: 'adopted',
    });
  });

  it.each(['Wallet', 'wallet', 'a', 'has-hyphen', 'dotted.name', 'x'.repeat(31), 'admin'])(
    'refuses handle %s without calling Apple',
    async (handle) => {
      const { api, seen } = stubApple(() => ({ body: {} }));
      await expect(api.createPassType(handle, 'Name')).rejects.toThrow(/^ASC_REFUSED/);
      expect(seen).toHaveLength(0);
      expect((await ledger()).map((r) => r.phase)).toEqual(['refused']);
    },
  );

  it('refuses to find or certify identifiers and pass types outside the allowlist', async () => {
    const { api, seen } = stubApple(() => ({ body: {} }));
    await expect(api.findPassType('pass.com.other.thing')).rejects.toThrow(/^ASC_REFUSED/);
    await expect(api.findPassType('pass.im.plrs.wallet')).rejects.toThrow(/^ASC_REFUSED/);
    const csr = await makeCsr('pass.com.other.thing');
    await expect(api.createCertificate('UNKNOWN', csr, false)).rejects.toThrow(/^ASC_REFUSED/);
    await expect(api.listCertificates('UNKNOWN')).rejects.toThrow(/^ASC_REFUSED/);
    expect(seen).toHaveLength(0);
  });

  it('finds the seeded platform pass type and records its Apple id', async () => {
    await seedPassType('pass.im.plrs.wallet', null);
    const { api, seen } = stubApple(() => ({
      body: { data: [passTypeBody('PLAT', 'pass.im.plrs.wallet').data] },
    }));
    expect((await api.findPassType('pass.im.plrs.wallet'))?.ascId).toBe('PLAT');
    expect(seen[0]?.path).toBe('/v1/passTypeIds?filter[identifier]=pass.im.plrs.wallet&limit=10');
    await expect(api.listCertificates('PLAT')).resolves.toHaveLength(1);
  });

  it('issues a certificate only for an allowlisted pass type and a matching RSA-2048 CSR', async () => {
    await seedPassType(PTI, 'PT1');
    const certBody = {
      data: {
        id: 'C1',
        attributes: {
          certificateType: 'PASS_TYPE_ID_WITH_NFC',
          certificateContent: btoa('der-bytes'),
          expirationDate: '2027-11-20T12:00:00.000+0000',
          serialNumber: 'ABC',
        },
      },
    };
    const { api, seen } = stubApple(() => ({ status: 201, body: certBody }));
    const csr = await makeCsr(PTI);
    const out = await api.createCertificate('PT1', csr, true);
    expect(out).toMatchObject({
      ascId: 'C1',
      serialNumber: 'ABC',
      expiresAt: Date.parse('2027-11-20T12:00:00Z'),
    });
    expect(new TextDecoder().decode(out.der ?? new Uint8Array())).toBe('der-bytes');
    expect(seen[0]?.body).toEqual({
      data: {
        type: 'certificates',
        attributes: {
          certificateType: 'PASS_TYPE_ID_WITH_NFC',
          csrContent: btoa(String.fromCharCode(...csr)),
        },
        relationships: { passTypeId: { data: { type: 'passTypeIds', id: 'PT1' } } },
      },
    });

    await expect(
      api.createCertificate('PT1', await makeCsr('pass.mobile.passbook.other'), false),
    ).rejects.toThrow(/^ASC_REFUSED: CSR subject/);
    await expect(api.createCertificate('PT1', new Uint8Array(400), false)).rejects.toThrow(
      /^ASC_REFUSED/,
    );
    expect(seen).toHaveLength(1);
  });

  it('refuses a CSR that is not RSA', async () => {
    await seedPassType(PTI, 'PT1');
    const { ecKeys } = await import('./harness.ts');
    const { api, seen } = stubApple(() => ({ body: {} }));
    const csr = await makeCsr(PTI, ecKeys);
    await expect(api.createCertificate('PT1', csr, false)).rejects.toThrow(/^ASC_REFUSED/);
    expect(seen).toHaveLength(0);
  });
});
