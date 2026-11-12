import { beforeAll, describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { liveRecipient } from './live-auth.ts';
import { liveTenantFixture } from './live-tenant-test-fixtures.ts';
import {
  insertSession,
  raceFinalFence,
  storedSession,
} from './repo-live-tenant-db-test-fixtures.ts';
import { approveScanReleases, type ScanKit } from './test-kit.ts';

const fixture = liveTenantFixture();
const { managedScreen, assertClosed } = fixture;
let kit: ScanKit;
beforeAll(async () => {
  ({ kit } = await fixture.setup());
});

describe('live tenant final authority races', () => {
  it('rejects a membership revoked between scope capture and the final authority SELECT', async () => {
    const screen = await managedScreen({ scoped: true });
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    const race = raceFinalFence(kit, () =>
      run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
        kit.clock.now(),
        screen.membershipId,
      ]),
    );
    expect(await liveRecipient(race.ctx, screen.attachment)).toBeNull();
    expect(race.reached()).toBe(true);
    await assertClosed(screen.attachment);
  });

  it('rejects a platform session revoked between scope capture and the final SELECT', async () => {
    const screen = await managedScreen();
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    const race = raceFinalFence(kit, () =>
      revokeSession(kit.env.DB, screen.resolved.sessionId, kit.clock.now()),
    );
    expect(await liveRecipient(race.ctx, screen.attachment)).toBeNull();
    expect(race.reached()).toBe(true);
    await assertClosed(screen.attachment);
  });

  it('rejects a session replacement attempted between preflight and the final SELECT', async () => {
    const screen = await managedScreen();
    const original = await storedSession(kit, screen.resolved.sessionId);
    const replacementSecret = kit.fx.ids.token();
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    const race = raceFinalFence(kit, async () => {
      await runOne(kit.env.DB, 'DELETE FROM sessions WHERE id_hash=?', [original.id_hash]);
      await expect(insertSession(kit, original, replacementSecret)).rejects.toThrow();
    });
    expect((await liveRecipient(race.ctx, screen.attachment)) === null).toBe(true);
    expect(race.reached()).toBe(true);
    // The session CSRF secret is immutable (0047): the final fence binds the session row by its
    // id hash and captured lifetime, and never reads or binds the secret.
    expect(race.statement()).toMatch(/id_hash\s*=\s*\?\d*\s*\/\*\s*scan-ephemeral-session-id-hash/);
    expect(race.bound()).toContain(screen.resolved.sessionId);
    expect(race.statement().includes(screen.session.csrf)).toBe(false);
    expect(
      race
        .bound()
        .some((value) => typeof value === 'string' && value.includes(screen.session.csrf)),
    ).toBe(false);
    await assertClosed(screen.attachment);
  });

  it('does not use a watched-scanner list changed before the final SELECT', async () => {
    const screen = await managedScreen({ withSource: true });
    if (!screen.source) throw new Error('Missing watched scanner.');
    const sourceId = screen.source.device.id;
    expect((await liveRecipient(kit.ctx, screen.attachment))?.watch.scannerIds).toContain(sourceId);
    const race = raceFinalFence(kit, () =>
      run(
        kit.env.DB,
        "UPDATE scanners SET device_role='monitor', updated_at=updated_at+1 WHERE id=?",
        [sourceId],
      ),
    );
    expect(await liveRecipient(race.ctx, screen.attachment)).toBeNull();
    expect(race.reached()).toBe(true);
    const fresh = await liveRecipient(kit.ctx, screen.attachment);
    expect(fresh).not.toBeNull();
    expect(fresh?.watch.scannerIds).not.toContain(sourceId);
  });

  it('keeps a recipient across a release approval but rejects its template deleted before the final SELECT', async () => {
    const screen = await managedScreen({ scoped: true });
    if (!screen.templateId) throw new Error('Missing scoped template.');
    const templateId = screen.templateId;
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    // A scope binds the captured release row, not the head: an approval meanwhile is not a refusal.
    const approval = raceFinalFence(kit, () =>
      approveScanReleases(kit, templateId, { modes: ['live'] }),
    );
    expect(await liveRecipient(approval.ctx, screen.attachment)).not.toBeNull();
    expect(approval.reached()).toBe(true);
    const deletion = raceFinalFence(kit, () =>
      run(kit.env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [templateId]),
    );
    expect(await liveRecipient(deletion.ctx, screen.attachment)).toBeNull();
    expect(deletion.reached()).toBe(true);
    await assertClosed(screen.attachment);
  });
});
