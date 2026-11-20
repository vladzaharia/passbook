import { beforeAll, describe, expect, it } from 'vitest';
import { limitSuite, makeSession, refusedWhen, setLimit } from '../../../../test/helpers/index.ts';
import { CreateScannerSchema } from '../../../shared/contracts/scanners.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { createPairing } from './pairing.ts';
import { loadScanner } from './scanner-views.ts';
import { createScanner } from './scanners.ts';
import { createSetup } from './setups.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
let kit: ScanKit;
let authority: TenantPassWrite;
let templateId: string;
let n = 0;

beforeAll(async () => {
  kit = await setupScanKit();
  const fixture = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
  if (!auth) throw new Error('Missing admin session.');
  authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
  templateId = await kit.scanTemplate('Door', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

const make = () =>
  createScanner(
    kit.ctx,
    'admin-1',
    'live',
    CreateScannerSchema.parse({
      orgId: kit.org.id,
      name: `Door ${++n}`,
      kind: 'device',
      accepts: { templateIds: [templateId] },
      timeZone: 'UTC',
    }),
    ORIGIN,
    authority,
  );

/** Scanners not revoked: what the limit counts. */
const held = async () =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM scanners WHERE org_id = ? AND revoked_at IS NULL',
      [kit.org.id],
    )
  )?.n ?? 0;

limitSuite('scanner devices', async () => ({
  db: kit.env.DB,
  orgId: kit.org.id,
  key: 'scanning.devices',
  create: () => refusedWhen(make),
  count: held,
}));

describe('scanner device limits', () => {
  it('a setup create is refused at the same cap', async () => {
    const before = await held();
    await setLimit(kit.env.DB, kit.org.id, 'scanning.devices', before);
    const refused = await refusedWhen(() =>
      createSetup(
        kit.ctx,
        'admin-1',
        'live',
        {
          orgId: kit.org.id,
          name: `Setup ${++n}`,
          kind: 'device',
          deviceRole: 'scan',
          timeZone: 'UTC',
        },
        ORIGIN,
        authority,
      ),
    );
    expect(refused).toMatchObject({ code: 'FEATURE_LIMIT_REACHED', limit: before, used: before });
    expect(await held()).toBe(before);
  });

  it('restoring a revoked scanner takes a slot, and revoking one frees it', async () => {
    await setLimit(kit.env.DB, kit.org.id, 'scanning.devices', null);
    const scanner = await make();
    const before = await held();
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      scanner.id,
    ]);
    expect(await held()).toBe(before - 1);
    await setLimit(kit.env.DB, kit.org.id, 'scanning.devices', before - 1);
    const row = await loadScanner(kit.ctx, scanner.id);
    expect(
      await refusedWhen(() => createPairing(kit.ctx, 'admin-1', row, ORIGIN, authority, true)),
    ).toMatchObject({ code: 'FEATURE_LIMIT_REACHED' });
    await setLimit(kit.env.DB, kit.org.id, 'scanning.devices', before);
    expect(
      await refusedWhen(() => createPairing(kit.ctx, 'admin-1', row, ORIGIN, authority, true)),
    ).toBeNull();
    expect(await held()).toBe(before);
  });
});
