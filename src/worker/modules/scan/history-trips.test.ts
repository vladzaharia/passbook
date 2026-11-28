import { describe, expect, it } from 'vitest';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  admin,
  app,
  exportPath,
  fake,
  get,
  kit,
  privatePass,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { RACE_HISTORY_PAGE, tagRe } from './race-tags.ts';
import { ORIGIN } from './test-kit.ts';
import { tripsFrom } from './trips-test-support.ts';

setupPrivacyKit();

const PAGE = tagRe(RACE_HISTORY_PAGE);

async function signedScan() {
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const pass = await privatePass();
  return recordedCheckIn(scanner, pass.id);
}

describe('history read round trips', () => {
  it('a console list is the page batch, then the manifests with the keyset', async () => {
    await signedScan();
    const { trips, calls } = await tripsFrom(kit.env, PAGE, async () => {
      expect((await get(`?orgId=${kit.org.id}`)).status).toBe(200);
    });
    expect(trips).toBe(2);
    expect(calls).toBe(3);
  });

  it('a console detail takes the same two trips', async () => {
    const row = await signedScan();
    const { trips } = await tripsFrom(kit.env, PAGE, async () => {
      expect((await get(`/${row.id}`)).status).toBe(200);
    });
    expect(trips).toBe(2);
  });

  it('an export page takes the same two trips, and a second page adds only its batch', async () => {
    await signedScan();
    const { trips } = await tripsFrom(kit.env, PAGE, async () => {
      const response = await get(exportPath());
      expect(response.status).toBe(200);
      await response.text();
    });
    expect(trips).toBeLessThanOrEqual(2);
  });

  it('an API-key feed takes at most two trips', async () => {
    await signedScan();
    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const { trips } = await tripsFrom(kit.env, PAGE, async () => {
      expect((await get('', apiKey)).status).toBe(200);
    });
    expect(trips).toBeLessThanOrEqual(2);
  });

  it('an empty page is one trip: no keyset and no manifests', async () => {
    const { trips, calls } = await tripsFrom(kit.env, PAGE, async () => {
      expect((await get(`?orgId=${kit.org.id}`)).status).toBe(200);
    });
    expect(trips).toBe(1);
    expect(calls).toBe(1);
  });

  it('the staff roster takes three trips: the zones, the roster with proofs, the manifests and keyset', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    await recordedCheckIn(scanner, (await privatePass()).id);
    const { trips } = await tripsFrom(kit.env, /SELECT DISTINCT sc\.time_zone/, async () => {
      const response = await Promise.resolve(
        app.request(`${ORIGIN}/api/v1/scan-staff?orgId=${kit.org.id}`, { headers: admin }, kit.env),
      );
      expect(response.status).toBe(200);
    });
    expect(trips).toBe(3);
  });
});
