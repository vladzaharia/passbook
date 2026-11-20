import { describe, expect, it } from 'vitest';
import { createServiceContext } from '../../platform/service-context.ts';
import { applyKit } from '../channels/apply-test-fixtures.ts';
import { checkChannelApply } from './checks-channels.ts';
import { clearStatusCache, getStatus } from './service.ts';

describe('status: channel apply', () => {
  it('is quiet when runs are healthy and flags failed and stuck ones', async () => {
    const t = await applyKit(1);
    const ctx = createServiceContext(t.kit.env, { clock: t.kit.clock });
    expect(await checkChannelApply(ctx)).toMatchObject({ state: 'verified', detail: null });
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    expect((await checkChannelApply(ctx)).state).toBe('verified');
    t.kit.clock.advance(30 * 60_000);
    expect(await checkChannelApply(ctx)).toMatchObject({
      state: 'degraded',
      detail: '1 not started.',
      data: { stuck_pending: 1 },
    });
    await t.exec(
      "UPDATE channel_apply_runs SET state = 'failed', error_code = 'CHANNEL_APPLY_FAILED', finished_at = ? WHERE id = ?",
      t.kit.clock.now(),
      id,
    );
    expect(await checkChannelApply(ctx)).toMatchObject({ state: 'degraded', data: { failed: 1 } });
    clearStatusCache(t.kit.env.DB);
    const status = await getStatus(ctx, { fresh: true });
    expect(status.components.find((c) => c.id === 'channel_apply')?.state).toBe('degraded');
    t.kit.clock.advance(25 * 3_600_000);
    expect((await checkChannelApply(ctx)).state).toBe('verified');
  });
});
