import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ledger,
  makeCsr,
  NOW,
  resetLedger,
  seedCertificate,
  seedPassType,
  stubApple,
} from './harness.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MANAGED = 'pass.mobile.passbook.acme';
const cert = (id: string, exp: string, owner = 'PT1') => ({
  id,
  type: 'certificates',
  attributes: { certificateType: 'PASS_TYPE_ID', expirationDate: exp, certificateContent: 'AAAA' },
  relationships: { passTypeId: { data: { type: 'passTypeIds', id: owner } } },
});

/** Apple with INUSE (older) and whatever the provisioner orders (newer). */
function apple() {
  const certs = [cert('INUSE', '2027-06-01T00:00:00Z')];
  return stubApple((s) => {
    if (s.method === 'POST') {
      const c = cert(`NEW${certs.length}`, '2027-12-01T00:00:00Z');
      certs.push(c);
      return { status: 201, body: { data: c } };
    }
    const one = certs.find((c) => s.path.startsWith(`/v1/certificates/${c.id}`));
    if (one) return { body: { data: one } };
    if (s.method === 'GET') return { body: { data: certs } };
    return { status: 204 };
  });
}

beforeEach(resetLedger);

describe('audit C MED-1: the provisioner enforces its own order limits', () => {
  it.each([['pass.im.plrs.wallet'], ['pass.mobile.passbook.wallet'], ['pass.com.example.other']])(
    'never orders a certificate for %s over RPC',
    async (identifier) => {
      await seedPassType(identifier, 'PLAT');
      const { api, seen } = apple();
      await expect(
        api.createCertificate('PLAT', await makeCsr(identifier), false, 'attacker'),
      ).rejects.toThrow(/^ASC_REFUSED/);
      expect(seen).toHaveLength(0);
      expect((await ledger()).at(-1)).toMatchObject({
        phase: 'refused',
        method: 'createCertificate',
      });
    },
  );

  it('allows 2 orders per pass type in 30 days, then refuses; a new window reopens it', async () => {
    await seedPassType(MANAGED, 'PT1');
    const { api, seen, clock } = apple();
    const csr = await makeCsr(MANAGED);
    await api.createCertificate('PT1', csr, false);
    await api.createCertificate('PT1', csr, false);
    await expect(api.createCertificate('PT1', csr, false)).rejects.toThrow(/^ASC_BUDGET/);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);
    expect((await ledger()).at(-1)).toMatchObject({ phase: 'budget', method: 'createCertificate' });
    clock.now += 31 * DAY;
    await api.createCertificate('PT1', csr, false);
  });

  it('counts per pass type, not across types', async () => {
    await seedPassType(MANAGED, 'PT1');
    await seedPassType('pass.mobile.passbook.beta', 'PT2');
    const { api } = apple();
    await api.createCertificate('PT1', await makeCsr(MANAGED), false);
    await api.createCertificate('PT1', await makeCsr(MANAGED), false);
    await api.createCertificate('PT2', await makeCsr('pass.mobile.passbook.beta'), false);
  });

  it('records the order and logs a stable code; over half the daily budget logs budget_high at error', async () => {
    await seedPassType(MANAGED, 'PT1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { api } = apple();
      await api.createCertificate('PT1', await makeCsr(MANAGED), false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('provisioner.cert_ordered'));
      const insert = env.DB.prepare(
        "INSERT INTO asc_calls (call_id, phase, method, at) VALUES ('x', 'start', 'listCertificates', ?)",
      );
      await env.DB.batch(
        Array.from({ length: 100 }, (_, i) => insert.bind(NOW - 61_000 - i * 1000)),
      );
      const { api: later } = stubApple(() => ({ body: { data: [] } }));
      await later.listCertificates('PT1');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('provisioner.budget_high'));
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    const row = await env.DB.prepare('SELECT * FROM asc_certificates').first();
    expect(row).toMatchObject({ pass_type_asc_id: 'PT1', activated_at: null });
  });
});

describe('audit C MED-2: revoke is guarded by the provisioner state', () => {
  it('refuses the audit scenario: order a newer certificate, then revoke the in-use one at once', async () => {
    await seedPassType(MANAGED, 'PT1');
    const { api, seen } = apple();
    await api.createCertificate('PT1', await makeCsr(MANAGED), false, 'x');
    await expect(api.revokeCertificate('INUSE', 'compromised', 'x')).rejects.toThrow(
      /^ASC_REFUSED: A replacement must be active/,
    );
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('still refuses when the caller reports the new certificate active straight away', async () => {
    await seedPassType(MANAGED, 'PT1');
    const { api, seen } = apple();
    const out = await api.createCertificate('PT1', await makeCsr(MANAGED), false);
    await api.reportCertificateActive(out.ascId);
    await expect(api.revokeCertificate('INUSE', 'compromised')).rejects.toThrow(/^ASC_REFUSED/);
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('refuses a replacement that is 24 hours old but was never reported active', async () => {
    await seedPassType(MANAGED, 'PT1');
    const { api, seen, clock } = apple();
    await api.createCertificate('PT1', await makeCsr(MANAGED), false);
    clock.now += 25 * HOUR;
    await expect(api.revokeCertificate('INUSE', 'compromised')).rejects.toThrow(/^ASC_REFUSED/);
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('revokes once the replacement is 24 hours old and active', async () => {
    await seedPassType(MANAGED, 'PT1');
    const { api, seen, clock } = apple();
    const out = await api.createCertificate('PT1', await makeCsr(MANAGED), false);
    await api.reportCertificateActive(out.ascId);
    clock.now += 24 * HOUR + 1;
    await api.revokeCertificate('INUSE', 'compromised');
    expect(seen.some((s) => s.method === 'DELETE' && s.path === '/v1/certificates/INUSE')).toBe(
      true,
    );
  });

  it('allows one revoke per pass type per 7 days', async () => {
    await seedPassType(MANAGED, 'PT1');
    await seedCertificate('NEWER', 'PT1', 30 * DAY, true);
    const certs = [
      cert('A', '2027-01-01T00:00:00Z'),
      cert('B', '2027-02-01T00:00:00Z'),
      cert('NEWER', '2027-12-01T00:00:00Z'),
    ];
    const { api, seen, clock } = stubApple((s) => {
      const one = certs.find((c) => s.path.startsWith(`/v1/certificates/${c.id}`));
      if (s.method === 'DELETE') return { status: 204 };
      return { body: { data: one ?? certs } };
    });
    await api.revokeCertificate('A', 'compromised');
    clock.now += 2 * HOUR;
    await expect(api.revokeCertificate('B', 'compromised')).rejects.toThrow(/7 days/);
    clock.now += 7 * DAY;
    await api.revokeCertificate('B', 'compromised');
    expect(seen.filter((s) => s.method === 'DELETE').map((s) => s.path)).toEqual([
      '/v1/certificates/A',
      '/v1/certificates/B',
    ]);
  });

  it('reportCertificateActive refuses a certificate of a platform or unlisted pass type', async () => {
    await seedPassType('pass.im.plrs.wallet', 'PLAT');
    const { api } = stubApple((s) => ({
      body: {
        data: cert(
          s.path.includes('PX') ? 'PX' : 'C9',
          '2027-01-01T00:00:00Z',
          s.path.includes('PX') ? 'NOPE' : 'PLAT',
        ),
      },
    }));
    await expect(api.reportCertificateActive('C9')).rejects.toThrow(/^ASC_REFUSED/);
    await expect(api.reportCertificateActive('PX')).rejects.toThrow(/^ASC_REFUSED/);
  });
});
