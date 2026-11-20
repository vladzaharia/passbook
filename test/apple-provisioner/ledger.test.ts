import { env } from 'cloudflare:workers';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ascPublicKey,
  ledger,
  NOW,
  P8_BODY,
  provisionerEnv,
  resetLedger,
  seedPassType,
  stubApple,
} from './harness.ts';

const cert = (id: string, owner: string) => ({
  data: {
    id,
    type: 'certificates',
    relationships: { passTypeId: { data: { type: 'passTypeIds', id: owner } } },
  },
});

beforeEach(resetLedger);

describe('apple-provisioner budget', () => {
  it('fails closed after 30 calls a minute, per method', async () => {
    await seedPassType('pass.mobile.passbook.henrys', 'PT1');
    const { api, seen } = stubApple(() => ({ body: { data: [] } }));
    for (let i = 0; i < 30; i++) await api.listCertificates('PT1');
    await expect(api.listCertificates('PT1')).rejects.toThrow(/^ASC_BUDGET/);
    expect(seen).toHaveLength(30);
    expect((await ledger()).at(-1)).toMatchObject({ phase: 'budget', method: 'listCertificates' });
    await expect(api.findPassType('pass.mobile.passbook.henrys')).resolves.toBeNull();
  });

  it('allows calls again once the minute has passed, and caps the day at 200', async () => {
    await seedPassType('pass.mobile.passbook.henrys', 'PT1');
    const { api, clock } = stubApple(() => ({ body: { data: [] } }));
    for (let i = 0; i < 30; i++) await api.listCertificates('PT1');
    clock.now += 61_000;
    await api.listCertificates('PT1');
    const insert = env.DB.prepare(
      "INSERT INTO asc_calls (call_id, phase, method, at) VALUES ('x', 'start', 'listCertificates', ?)",
    );
    await env.DB.batch(
      Array.from({ length: 169 }, (_, i) => insert.bind(NOW + 61_000 - 120_000 - i)),
    );
    await expect(api.listCertificates('PT1')).rejects.toThrow(/^ASC_BUDGET/);
  });
});

describe('apple-provisioner ledger', () => {
  it('records start and end rows with request ids and no secrets', async () => {
    await seedPassType('pass.mobile.passbook.henrys', 'PT1');
    const { api } = stubApple(() => ({ body: { data: [] } }));
    await api.listCertificates('PT1', 'run-7');
    const rows = await ledger();
    expect(rows.map((r) => r.phase)).toEqual(['start', 'end']);
    expect(rows[1]).toMatchObject({
      method: 'listCertificates',
      target: 'PT1',
      caller: 'run-7',
      status: '200',
      apple_request_id: 'req-1',
    });
    expect(await api.calls(0)).toHaveLength(2);
    const dump = JSON.stringify(rows);
    for (const secret of [
      P8_BODY,
      'PRIVATE KEY',
      'eyJ',
      'Bearer',
      provisionerEnv.ASC_KEY_ID,
      'csr',
    ])
      expect(dump).not.toContain(secret);
  });

  it('is append-only', async () => {
    const { api } = stubApple(() => ({ body: { data: [] } }));
    await api.findPassType('pass.mobile.passbook.henrys');
    await expect(env.DB.prepare("UPDATE asc_calls SET status = 'x'").run()).rejects.toThrow(
      /append-only/,
    );
    await expect(env.DB.prepare('DELETE FROM asc_calls').run()).rejects.toThrow(/append-only/);
  });

  it('mints ES256 JWTs with a 10 minute expiry', async () => {
    const { api, seen } = stubApple(() => ({ body: { data: [] } }));
    await api.findPassType('pass.mobile.passbook.henrys');
    const token = seen[0]?.auth.replace('Bearer ', '') ?? '';
    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: 'ES256',
      kid: 'KEYID12345',
      typ: 'JWT',
    });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      iss: provisionerEnv.ASC_ISSUER_ID,
      aud: 'appstoreconnect-v1',
      iat: NOW / 1000,
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(600);
    await jwtVerify(token, ascPublicKey, { currentDate: new Date(NOW) });
  });
});

describe('apple-provisioner revoke', () => {
  const owner = (id: string) => ({ body: cert('C1', id) });

  it('revokes with reason compromised, for an allowlisted pass type, once an hour', async () => {
    await seedPassType('pass.mobile.passbook.henrys', 'PT1');
    const { api, seen, clock } = stubApple(({ method }) =>
      method === 'DELETE' ? { status: 204 } : owner('PT1'),
    );
    await api.revokeCertificate('C1', 'compromised');
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /v1/certificates/C1?include=passTypeId',
      'DELETE /v1/certificates/C1',
    ]);
    await expect(api.revokeCertificate('C2', 'compromised')).rejects.toThrow(/^ASC_BUDGET/);
    clock.now += 3_600_001;
    await api.revokeCertificate('C2', 'compromised');
  });

  it('refuses another reason, a bad id and a certificate of an unlisted pass type', async () => {
    await seedPassType('pass.mobile.passbook.henrys', 'PT1');
    const { api, seen } = stubApple(({ method }) =>
      method === 'DELETE' ? { status: 204 } : owner('OTHER'),
    );
    await expect(api.revokeCertificate('C1', 'superseded' as 'compromised')).rejects.toThrow(
      /^ASC_REFUSED/,
    );
    await expect(api.revokeCertificate('../x', 'compromised')).rejects.toThrow(/^ASC_REFUSED/);
    await expect(api.revokeCertificate('C1', 'compromised')).rejects.toThrow(/^ASC_REFUSED/);
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('keeps the hourly slot after a refused lookup', async () => {
    await seedPassType('pass.mobile.passbook.henrys', 'PT1');
    let ownerId = 'OTHER';
    const { api } = stubApple(({ method }) =>
      method === 'DELETE' ? { status: 204 } : owner(ownerId),
    );
    await expect(api.revokeCertificate('C1', 'compromised')).rejects.toThrow(/^ASC_REFUSED/);
    ownerId = 'PT1';
    await api.revokeCertificate('C1', 'compromised');
  });
});
