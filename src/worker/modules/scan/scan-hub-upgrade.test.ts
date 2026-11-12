import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import type { LiveAttachment } from './live-auth.ts';
import { hub, kit, screen, template } from './scan-hub-test-fixtures.ts';

const upgrade = async (attachment: LiveAttachment) =>
  hub().fetch(
    new Request('https://hub.test', {
      headers: { upgrade: 'websocket', 'x-pb-live': await sealLiveAttachment(kit.env, attachment) },
    }),
  );

/** A screen's upgrade is refused like a device read: only a lost credential is a 401. */
describe('live screen upgrade refusals', () => {
  async function monitor() {
    const source = await kit.scanner({ templateIds: [template] });
    return screen('monitor', [source.id]);
  }

  it('opens an unchanged screen (control)', async () => {
    const { attachment } = await monitor();
    const response = await upgrade(attachment);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error('Missing socket.');
    socket.accept();
    socket.close(1000);
  });

  it('answers a configuration change with 409 SCAN_CONFIG_CHANGED, not a bare 401', async () => {
    const { id, attachment } = await monitor();
    await run(kit.env.DB, "UPDATE scanners SET time_zone='Europe/Paris' WHERE id=?", [id]);
    const response = await upgrade(attachment);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'SCAN_CONFIG_CHANGED' });
  });

  it('keeps the bare 401 for a revoked screen', async () => {
    const { id, attachment } = await monitor();
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), id]);
    const response = await upgrade(attachment);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
  });
});
