import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import { ScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import { CreateScannerSchema } from '../../../shared/contracts/scanners.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { getScanner } from './repo-device.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { createScanner } from './scanners.ts';
import { updateScanningDevice } from './scanning-devices.ts';
import { setupView } from './setup-views.ts';
import { createSetup } from './setups.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let authority: TenantPassWrite;
beforeAll(async () => {
  kit = await setupScanKit();
  const fixture = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
  if (!auth) throw new Error('Missing admin session.');
  authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
});
describe('legacy device layout compatibility', () => {
  it('keeps an unenrolled legacy setup readable', async () => {
    const scanner = await kit.scanner();
    await setSetupWatchStmt(kit.env.DB, kit.org.id, scanner.id, null).run();
    const view = ScannerSetupSchema.parse(await setupView(kit.ctx, scanner.id));
    expect(view.sessionId).toBeUndefined();
    expect(view.id).toBe(scanner.id);
  });

  it('converts a display browser to a scanner while retaining its pairing state', async () => {
    const source = await kit.scanner();
    const display = await createSetup(
      kit.ctx,
      'admin-1',
      'live',
      {
        orgId: kit.org.id,
        name: 'Legacy display',
        kind: 'display',
        deviceRole: 'customer',
        timeZone: 'UTC',
        watch: { scannerIds: [source.id], allOrg: false },
      },
      'https://wallet.test',
      authority,
    );
    expect(
      (await kit.post({ origin: 'https://wallet.test' }, '/pair', { code: display.pairing?.code }))
        .status,
    ).toBe(200);
    const before = await getScanner(kit.env.DB, display.id);
    const changed = await updateScanningDevice(
      kit.ctx,
      'admin-1',
      display.id,
      display.id,
      { surface: 'phone' },
      authority,
    );
    expect(changed.effectiveSurface).toBe('phone');
    expect(await getScanner(kit.env.DB, display.id)).toMatchObject({
      kind: 'device',
      deviceRole: 'scan',
      tokenHash: before?.tokenHash,
    });
  });
  it('refuses to turn a dedicated API terminal into a read-only display', async () => {
    const templateId = await kit.scanTemplate('Terminal layout', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const terminal = await createScanner(
      kit.ctx,
      'admin-1',
      'live',
      CreateScannerSchema.parse({
        orgId: kit.org.id,
        name: 'API terminal',
        kind: 'terminal',
        accepts: { templateIds: [templateId] },
        timeZone: 'UTC',
      }),
      'https://wallet.test',
      authority,
    );
    await expect(
      updateScanningDevice(
        kit.ctx,
        'admin-1',
        terminal.id,
        terminal.id,
        { surface: 'customer' },
        authority,
      ),
    ).rejects.toMatchObject({ code: 'SCAN_SURFACE_UNSUPPORTED' });
    expect(await getScanner(kit.env.DB, terminal.id)).toMatchObject({
      kind: 'terminal',
      deviceRole: 'scan',
    });
  });
});
