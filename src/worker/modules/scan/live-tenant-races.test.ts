import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { liveRecipient } from './live-auth.ts';
import { liveTenantFixture } from './live-tenant-test-fixtures.ts';
import { approveScanReleases, type ScanKit } from './test-kit.ts';

const fixture = liveTenantFixture();
const { managedScreen, assertClosed } = fixture;
let kit: ScanKit;
beforeAll(async () => {
  ({ kit } = await fixture.setup());
});

describe('live tenant authority is current at every read', () => {
  it('rejects a revoked membership', async () => {
    const screen = await managedScreen({ scoped: true });
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      screen.membershipId,
    ]);
    expect(await liveRecipient(kit.ctx, screen.attachment)).toBeNull();
    await assertClosed(screen.attachment);
  });

  it('rejects a revoked platform session', async () => {
    const screen = await managedScreen();
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    await revokeSession(kit.env.DB, screen.resolved.sessionId, kit.clock.now());
    expect(await liveRecipient(kit.ctx, screen.attachment)).toBeNull();
    await assertClosed(screen.attachment);
  });

  it('follows the watched-scanner list as it is now', async () => {
    const screen = await managedScreen({ withSource: true });
    if (!screen.source) throw new Error('Missing watched scanner.');
    const sourceId = screen.source.device.id;
    expect((await liveRecipient(kit.ctx, screen.attachment))?.watch.scannerIds).toContain(sourceId);
    await run(
      kit.env.DB,
      "UPDATE scanners SET device_role='monitor', updated_at=updated_at+1 WHERE id=?",
      [sourceId],
    );
    const fresh = await liveRecipient(kit.ctx, screen.attachment);
    expect(fresh).not.toBeNull();
    expect(fresh?.watch.scannerIds).not.toContain(sourceId);
  });

  it('keeps a recipient across a release approval', async () => {
    const screen = await managedScreen({ scoped: true });
    if (!screen.templateId) throw new Error('Missing scoped template.');
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    await approveScanReleases(kit, screen.templateId, { modes: ['live'] });
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
  });
});
