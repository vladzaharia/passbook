import { beforeAll, describe, expect, it } from 'vitest';
import { type FakeAuth, fakeAuth, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { CreatedScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership, type ScanKit, setupScanKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
let fake: FakeAuth;
let kit: ScanKit;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  kit = await setupScanKit();
  fake = fakeAuth(ORIGIN);
  fake.bindSessions(kit.env.DB, kit.clock);
  app = createApp({
    stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
});

const create = (adminUserId: string) =>
  app.request(
    `${ORIGIN}/api/v1/scan-setups`,
    {
      method: 'POST',
      headers: { ...fake.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: kit.org.id,
        name: `Admin setup ${kit.fx.ids.token(3)}`,
        timeZone: 'UTC',
        adminUserId,
      }),
    },
    kit.env,
  );

describe('POST /scan-setups adminUserId', () => {
  it("refuses another organization's user, so their name and email never show", async () => {
    const other = await makeOrg(kit.fx);
    const outsider = await makeUser(kit.fx);
    await run(kit.env.DB, "UPDATE users SET name='Outside Person' WHERE id=?", [outsider.id]);
    await grantScanMembership(kit.fx, other.id, outsider.id);
    const refused = await create(outsider.id);
    expect(refused.status).toBe(422);
    const text = await refused.text();
    expect(JSON.parse(text)).toMatchObject({ code: 'SCANNER_ADMIN_USER' });
    expect(text).not.toContain('Outside Person');
    expect(text).not.toContain(outsider.primaryEmail);
  });

  it('accepts the caller as the setup admin (control)', async () => {
    const made = await create('admin-1');
    expect(made.status).toBe(201);
    expect(CreatedScannerSetupSchema.parse(await made.json())).toMatchObject({
      adminSession: true,
      adminUser: { id: 'admin-1' },
      pairing: null,
    });
  });
});
