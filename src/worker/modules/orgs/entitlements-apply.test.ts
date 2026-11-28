import { describe, expect, it } from 'vitest';
import type { OrgEntitlementsDto } from '../../../shared/contracts/entitlement-admin.ts';
import type { JobOf } from '../../jobs/types.ts';
import { applyKit } from '../channels/apply-test-fixtures.ts';
import { handleEntitlementApply } from '../channels/entitlement-apply.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';

const json = { 'content-type': 'application/json' };

describe('a preset change through the platform API converges the org channels', () => {
  it('queues channel.entitlement and the job opens an apply run with the plan as it was', async () => {
    const t = await applyKit(2);
    const path = `/platform/orgs/${t.orgId}/entitlements`;
    const headers = { ...t.kit.auth.admin(), ...json };
    const read = async () =>
      (await (await t.kit.api(path, { headers })).json()) as OrgEntitlementsDto;
    const put = (preset: string, expectedRevision: number) =>
      t.kit.api(path, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ preset, expectedRevision, overrides: {} }),
      });
    const jobs = () =>
      (t.kit.queue.sent as { kind: string }[]).filter(
        (m) => m.kind === 'channel.entitlement',
      ) as JobOf<'channel.entitlement'>[];

    // A write that moves no channel queues nothing.
    const first = await read();
    expect((await put('legacy', first.revision)).status).toBe(200);
    expect(jobs()).toHaveLength(0);

    expect((await put('trial', first.revision)).status).toBe(200);
    expect(jobs()).toEqual([
      expect.objectContaining({
        orgId: t.orgId,
        blockedBefore: [],
        requestedBy: expect.any(String),
      }),
    ]);
    await handleEntitlementApply(jobs()[0] as JobOf<'channel.entitlement'>, jobCtxOf(t.kit));
    const [run] = (await t.runs()).filter((r) => r.from_blocked !== null);
    expect(run).toMatchObject({ state: 'pending', from_blocked: '[]' });
    expect(t.created.map((c) => c.id)).toContain(run?.id);

    // The way back queues a second job whose before is the trial's blocked set.
    const mid = await read();
    expect((await put('legacy', mid.revision)).status).toBe(200);
    expect(jobs()).toHaveLength(2);
    expect(jobs()[1]?.blockedBefore).toEqual(['samsung', 'paper', 'nfc']);
  });
});
