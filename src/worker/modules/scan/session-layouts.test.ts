import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { CreateScannerSchema } from '../../../shared/contracts/scanners.ts';
import { getScanner } from './repo-device.ts';
import { createScanner } from './scanners.ts';
import { updateScanningDevice } from './scanning-devices.ts';
import { createSetup } from './setups.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
  await makeUser(kit.fx, { id: 'admin-1' });
});
describe('legacy device layout compatibility', () => {
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
    );
    expect(
      (await kit.post({ origin: 'https://wallet.test' }, '/pair', { code: display.pairing?.code }))
        .status,
    ).toBe(200);
    const before = await getScanner(kit.env.DB, display.id);
    const changed = await updateScanningDevice(kit.ctx, 'admin-1', display.id, display.id, {
      surface: 'phone',
    });
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
    );
    await expect(
      updateScanningDevice(kit.ctx, 'admin-1', terminal.id, terminal.id, { surface: 'customer' }),
    ).rejects.toMatchObject({ code: 'SCAN_SURFACE_UNSUPPORTED' });
    expect(await getScanner(kit.env.DB, terminal.id)).toMatchObject({
      kind: 'terminal',
      deviceRole: 'scan',
    });
  });
});
