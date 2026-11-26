import { env } from 'cloudflare:workers';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertCsr } from '../../workers/passbook-apple-connector/src/csr.ts';
import { LIMITS } from '../../workers/passbook-apple-connector/src/ledger.ts';
import { ledger, makeCsr, resetLedger, seedPassType, stubApple } from './harness.ts';

const MANAGED = 'pass.mobile.passbook.henrys';

beforeEach(resetLedger);

async function csrWith(change: (csr: pkijs.CertificationRequest) => void): Promise<Uint8Array> {
  const keys = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const csr = new pkijs.CertificationRequest();
  csr.version = 0;
  csr.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: MANAGED }),
    }),
  );
  await csr.subjectPublicKeyInfo.importKey(keys.publicKey);
  change(csr);
  await csr.sign(keys.privateKey, 'SHA-256');
  return new Uint8Array(csr.toSchema().toBER());
}

describe('CSR strictness', () => {
  it('accepts the plain CSR', async () => {
    await expect(assertCsr(await makeCsr(MANAGED), MANAGED)).resolves.toBeUndefined();
  });

  it('refuses trailing bytes after the DER', async () => {
    const der = await makeCsr(MANAGED);
    const padded = new Uint8Array([...der, 0, 0]);
    await expect(assertCsr(padded, MANAGED)).rejects.toThrow(/^ASC_REFUSED/);
  });

  it('refuses requested attributes', async () => {
    const der = await csrWith((csr) => {
      csr.attributes = [
        new pkijs.Attribute({
          type: '1.2.840.113549.1.9.14',
          values: [new asn1js.Sequence()],
        }),
      ];
    });
    await expect(assertCsr(der, MANAGED)).rejects.toThrow(/^ASC_REFUSED: CSR must carry no/);
  });

  it('refuses a public exponent other than 65537', async () => {
    const keys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([3]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    await expect(assertCsr(await makeCsr(MANAGED, keys), MANAGED)).rejects.toThrow(
      /^ASC_REFUSED: CSR key exponent/,
    );
  });
});

describe('findPassType', () => {
  it('allowlists a managed pass type an earlier attempt created, so its certificate can follow', async () => {
    const { api } = stubApple(({ method }) =>
      method === 'POST'
        ? {
            status: 201,
            body: { data: { id: 'C1', attributes: { certificateType: 'PASS_TYPE_ID' } } },
          }
        : { body: { data: [{ id: 'PT7', attributes: { identifier: MANAGED, name: 'Henrys' } }] } },
    );
    await api.findPassType(MANAGED);
    const row = await env.DB.prepare(
      'SELECT asc_id, source FROM asc_pass_types WHERE identifier = ?',
    )
      .bind(MANAGED)
      .first();
    expect(row).toEqual({ asc_id: 'PT7', source: 'created' });
    await api.createCertificate('PT7', await makeCsr(MANAGED), false);
  });
});

describe('ledger resilience and refusal budget', () => {
  it('returns the Apple result when the closing ledger row cannot be written', async () => {
    await seedPassType(MANAGED, 'PT1');
    const { api } = stubApple(() => ({
      status: 201,
      body: { data: { id: 'C1', attributes: { certificateType: 'PASS_TYPE_ID' } } },
    }));
    await env.DB.prepare(
      "CREATE TRIGGER fail_end BEFORE INSERT ON asc_calls WHEN NEW.phase = 'end' BEGIN SELECT RAISE(ABORT, 'ledger down'); END",
    ).run();
    try {
      await expect(
        api.createCertificate('PT1', await makeCsr(MANAGED), false),
      ).resolves.toMatchObject({
        ascId: 'C1',
      });
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_end').run();
    }
  });

  it('stops writing refusal rows past the per-minute budget, and still refuses', async () => {
    const { api } = stubApple(() => ({ body: {} }));
    for (let i = 0; i < LIMITS.perMinute + 10; i++)
      await expect(api.findPassType('pass.com.other.thing')).rejects.toThrow(/^ASC_REFUSED/);
    const refused = (await ledger()).filter((r) => r.phase === 'refused');
    expect(refused).toHaveLength(LIMITS.perMinute);
  });
});
