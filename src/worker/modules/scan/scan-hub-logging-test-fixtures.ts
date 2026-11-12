import { expect, it } from 'vitest';
import type { ServiceContext } from '../../platform/service-context.ts';
import { act } from './act.ts';
import { scannerActor, withRole } from './actor.ts';
import { kickScreen, publishScan } from './live.ts';
import { getScanner } from './repo-device.ts';
import { kit, screen, template } from './scan-hub-test-fixtures.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

export function registerHubLoggingTests() {
  it('does not log private error text from publication or screen kicks', async () => {
    const source = await kit.scanner({ templateIds: [template] });
    await screen('monitor', [source.id]);
    const device = await getScanner(kit.env.DB, source.id);
    if (!device) throw new Error('Missing source scanner.');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(kit.ctx, device, 'live', 'cookie', { event: null, templateIds: [template] }),
        null,
      ),
    );
    const pass = await kit.scanPass(template);
    const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, actor, {
      input: codeOf(pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    const secret = 'PRIVATE-HOLDER v1.PRIVATE-SOURCE-PROOF';
    const logged: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    let publications = 0;
    let kicks = 0;
    const fakeHub = {
      publish: async () => {
        publications += 1;
        throw new Error(secret);
      },
      kick: async () => {
        if (kicks++ === 0) throw new Error(secret);
        return 0;
      },
    };
    const ctx = {
      ...kit.ctx,
      env: { ...kit.env, SCAN_HUB: { getByName: () => fakeHub } },
      log: {
        ...kit.ctx.log,
        error: (event: string, data: unknown) => logged.push({ event, data }),
        warn: (event: string, data: unknown) => logged.push({ event, data }),
      },
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as ServiceContext;
    publishScan(ctx, actor, outcome, evaluatedSnapshot, credentialContext, 'camera');
    await Promise.all(pending);
    await kickScreen(ctx, kit.org.id, 'live', source.id);
    expect(publications).toBe(1);
    expect(kicks).toBe(2);
    expect(logged).toEqual([
      expect.objectContaining({ event: 'scan.live_publish_failed' }),
      expect.objectContaining({ event: 'scan.live_kick_retry' }),
    ]);
    expect(JSON.stringify(logged)).not.toContain(secret);
  });
}
