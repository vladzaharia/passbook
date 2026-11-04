import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { createApp } from '../../app.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { enqueuePassEmail } from '../delivery/service.ts';
import { eventsQuery } from '../metrics/analytics-sql.ts';
import { setupCounts } from '../metrics/repo.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;
let org: { id: string };

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
  org = await makeOrg(kit.fx, { name: 'Counted' });
});

const get = async (path: string, mode: Mode) =>
  (await (
    await app.request(`${ORIGIN}/api/v1${path}`, { headers: fake.admin({ mode }) }, kit.env)
  ).json()) as {
    items: Record<string, unknown>[];
  } & Record<string, unknown>;

const make = (mode: Mode, holderEmail?: string) =>
  createPassRow(kit.ctx, {
    orgId: org.id,
    templateId: kit.template.id,
    input: { memberName: `Agg ${mode}` },
    ...(holderEmail ? { holderEmail } : {}),
    source: 'manual',
    mode,
    actor: { type: 'system', id: null },
  });

beforeAll(async () => {
  await make('live', 'agg-live@example.com');
  await make('test', 'agg-test-1@example.com');
  await make('test', 'agg-test-2@example.com');
});

describe('aggregates split by mode', () => {
  it('template list and detail pass counts', async () => {
    for (const [mode, n] of [
      ['live', 1],
      ['test', 2],
    ] as const) {
      const list = await get(`/templates?orgId=${org.id}&limit=200`, mode);
      expect(list.items.find((t) => t.id === kit.template.id)?.passCount).toBe(n);
      const detail = await get(`/templates/${kit.template.id}`, mode);
      expect(detail.passCount).toBe(n);
      expect(
        (detail.versions as { passCount: number }[]).reduce((a, v) => a + v.passCount, 0),
      ).toBe(n);
    }
  });

  it('org counts', async () => {
    for (const [mode, n] of [
      ['live', 1],
      ['test', 2],
    ] as const) {
      const one = await get(`/orgs/${org.id}`, mode);
      expect((one.counts as { passes: number }).passes).toBe(n);
      const list = await get('/orgs?limit=200', mode);
      const row = list.items.find((o) => o.id === org.id);
      expect((row?.counts as { passes: number } | undefined)?.passes).toBe(n);
    }
  });

  it('holder list', async () => {
    const live = await get(`/holders?orgId=${org.id}&limit=200`, 'live');
    const test = await get(`/holders?orgId=${org.id}&limit=200`, 'test');
    expect(live.items.map((h) => h.email)).toEqual(['agg-live@example.com']);
    expect(test.items.map((h) => h.email).sort()).toEqual([
      'agg-test-1@example.com',
      'agg-test-2@example.com',
    ]);
  });

  it('setup counts: captured test mail is not a sent email', async () => {
    const before = (await setupCounts(kit.env.DB)).passEmailsSent;
    const test = await make('test');
    const live = await make('live');
    for (const pass of [test, live]) {
      const { outboxId } = await enqueuePassEmail(kit.ctx, {
        passId: pass.id,
        to: 'setup@example.com',
        attach: false,
      });
      await handleEmailSend({ kind: 'email.send', outboxId }, kit.ctx);
    }
    expect((await setupCounts(kit.env.DB)).passEmailsSent).toBe(before + 1);
  });

  it('analytics queries filter on the mode blob; rows without one count as live', () => {
    const w = { since: 0, bucketMs: 60_000 };
    expect(eventsQuery(w, { mode: 'live' }, 1000).query).toContain("blob6 != 'test'");
    expect(eventsQuery(w, { mode: 'test' }, 1000).query).toContain("blob6 = 'test'");
  });
});
