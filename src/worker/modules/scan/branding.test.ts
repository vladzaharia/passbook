import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { run } from '../../platform/db.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const encoded = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function uploadLogo(orgId: string, width: number, height: number): Promise<Uint8Array> {
  const x3 = makePng(width, height);
  const x2 = makePng((width * 2) / 3, (height * 2) / 3);
  const response = await fixture.call('PUT', `/orgs/${orgId}/branding/logo`, {
    x3: encoded(x3),
    x2: encoded(x2),
  });
  expect(response.status).toBe(200);
  return x3;
}

async function otherOrg() {
  const org = await makeOrg(fixture.kit.fx);
  await grantScanMembership(fixture.kit.fx, org.id, 'admin-1');
  return org;
}

/** A device paired through a scanning session in `orgId`; returns its id and cookie headers. */
async function pairedIn(orgId: string, name: string) {
  const made = await fixture.call('POST', '/scanning-sessions', { orgId, name, timeZone: 'UTC' });
  expect(made.status).toBe(201);
  const session = (await made.json()) as { id: string };
  const device = await fixture.device(session.id, name);
  return { id: device.id, headers: await fixture.pair(device.pairing?.code ?? '') };
}

async function sessionOf(headers: Record<string, string>) {
  const response = await fixture.call('GET', '/scan/session', undefined, headers);
  expect(response.status).toBe(200);
  return ScanSessionSchema.parse(await response.json());
}

const logo = (headers: Record<string, string>, query = '') =>
  fixture.call('GET', `/scan/branding/logo${query}`, undefined, headers);

describe('scanner branding', () => {
  it('reads an unbranded org as no accent and no logo', async () => {
    const org = await otherOrg();
    const { headers } = await pairedIn(org.id, 'Plain scanner');
    expect((await sessionOf(headers)).branding).toEqual({ accent: null, logo: null });
    const response = await logo(headers);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'IMAGE_NOT_FOUND' });
  });

  it("serves each scanner its own org's logo, never another org's", async () => {
    const { kit, call } = fixture;
    const own = await uploadLogo(kit.org.id, 480, 150);
    const patched = await call('PATCH', `/orgs/${kit.org.id}`, { branding: { accent: '#0f766e' } });
    expect(patched.status).toBe(200);
    const other = await otherOrg();
    const theirs = await uploadLogo(other.id, 360, 150);
    const mine = await pairedIn(kit.org.id, 'Own scanner');
    const foreign = await pairedIn(other.id, 'Foreign scanner');

    const session = await sessionOf(mine.headers);
    expect(session.branding).toEqual({
      accent: '#0f766e',
      logo: expect.objectContaining({
        w: 480,
        h: 150,
        sha: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
    expect(session.branding?.logo).not.toHaveProperty('storageVersion');
    expect((await sessionOf(foreign.headers)).branding).toEqual({
      accent: null,
      logo: expect.objectContaining({ w: 360, h: 150 }),
    });

    const served = await logo(mine.headers, `?v=${session.branding?.logo?.sha}`);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(own);
    const foreignServed = await logo(foreign.headers);
    expect(new Uint8Array(await foreignServed.arrayBuffer())).toEqual(theirs);

    const chosen = await logo(mine.headers, `?orgId=${other.id}&timeZone=UTC`);
    expect(chosen.status).toBe(422);
    expect(await chosen.json()).toMatchObject({ code: 'SCAN_SCOPE_NOT_ALLOWED' });
  });

  it('refuses an unpaired or revoked scanner', async () => {
    const { kit, call } = fixture;
    const unpaired = await logo({ origin: 'https://wallet.test' });
    expect(unpaired.status).toBe(401);
    expect(await unpaired.json()).toMatchObject({ code: 'SCANNER_UNAUTHENTICATED' });
    const { id, headers } = await pairedIn(kit.org.id, 'Revoked scanner');
    expect((await logo(headers)).status).toBe(200);
    expect((await call('POST', `/scanners/${id}/revoke`)).status).toBe(200);
    const revoked = await logo(headers);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ code: 'SCANNER_REVOKED' });
    expect((await call('GET', '/scan/session', undefined, headers)).status).toBe(401);
  });

  it('reads branding in the same authority-checked batch as the session and logo', async () => {
    const { kit } = fixture;
    for (const read of [
      (headers: Record<string, string>) => logo(headers),
      (headers: Record<string, string>) => fixture.call('GET', '/scan/session', undefined, headers),
    ]) {
      const { id, headers } = await pairedIn(kit.org.id, 'Raced scanner');
      const { result, fired } = await beforeBatch(
        kit.env,
        /SELECT branding FROM orgs/,
        async (db) => {
          await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), id]);
        },
        () => read(headers),
      );
      expect(fired).toBe(true);
      expect(result.status).toBe(401);
    }
  });

  it('answers a logo read raced by a configuration change with 409, and a revoke with SCANNER_REPAIR', async () => {
    const { kit } = fixture;
    const org = await otherOrg();
    const raced = async (change: (db: D1Database, id: string) => Promise<void>) => {
      const { id, headers } = await pairedIn(org.id, `Logo race ${kit.fx.ids.token(3)}`);
      // The control: an unbranded org answers a plain 404, not a refusal.
      expect((await logo(headers)).status).toBe(404);
      const { result, fired } = await beforeBatch(
        kit.env,
        /SELECT branding FROM orgs/,
        (db) => change(db, id),
        () => logo(headers),
      );
      expect(fired).toBe(true);
      return result;
    };
    const drift = await raced(async (db, id) => {
      await run(db, "UPDATE scanners SET time_zone='Europe/Paris' WHERE id=?", [id]);
    });
    expect(drift.status).toBe(409);
    expect(await drift.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
    const revoked = await raced(async (db, id) => {
      await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), id]);
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ code: 'SCANNER_REPAIR' });
  });

  it("lets a member read only their organization's logo", async () => {
    const { kit, fake } = fixture;
    const reader = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, reader.id, ['read_only']);
    const headers = fake.session({ userId: reader.id, roles: ['user'] });
    const other = await otherOrg();
    await uploadLogo(other.id, 360, 150);
    expect((await logo(headers, `?orgId=${kit.org.id}&timeZone=UTC`)).status).toBe(200);
    expect((await logo(headers, `?orgId=${other.id}&timeZone=UTC`)).status).toBe(403);
  });
});
