/// <reference types="vite/client" />

import { beforeAll, describe, expect, it } from 'vitest';
import { CRON_HOOKS, DAILY_CRON } from '../../jobs/cron.ts';
import { first } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { sweepForkOrphans } from './fork-updates-gc.ts';
import { type ForkKit, forkKit } from './fork-updates-test-fixtures.ts';

let k: ForkKit;
beforeAll(async () => {
  k = await forkKit();
});

describe('the orphan sweep', () => {
  it('deletes old objects of no version under a fork’s prefix, and nothing else', async () => {
    await k.publish('fork-gc');
    const id = await k.fork('fork-gc', 'GC copy');
    const mine = `templates/${k.kit.org.id}/${id}`;
    const bucket = k.kit.env.BUCKET;
    const orphan = `${mine}/deadbeefdeadbeef/logo.png`;
    const elsewhere = `templates/${k.kit.org.id}/another-template/deadbeefdeadbeef/logo.png`;
    await bucket.put(orphan, new Uint8Array([1]));
    await bucket.put(elsewhere, new Uint8Array([1]));
    // The sweep looks at forks that had an offer.
    await k.publish('fork-gc', { tier: 'Level' });
    await k.tick();
    const kept = await first<{ assets: string }>(
      k.kit.env.DB,
      'SELECT assets FROM template_versions WHERE template_id = ? ORDER BY created_at LIMIT 1',
      [id],
    );
    const referenced = (JSON.parse(kept?.assets ?? '[]') as { source: { key?: string } }[]).find(
      (a) => a.source.key?.startsWith(mine),
    )?.source.key as string;
    expect(await bucket.head(referenced)).not.toBeNull();

    const ctx = createJobContext(k.kit.env, 'gc', { clock: k.kit.clock });
    // Too young: it may belong to a job still running.
    k.kit.clock.set(Date.now());
    await sweepForkOrphans(ctx);
    expect(await bucket.head(orphan)).not.toBeNull();

    k.kit.clock.set(Date.now() + 2 * 24 * 60 * 60_000);
    await sweepForkOrphans(ctx);
    expect(await bucket.head(orphan)).toBeNull();
    expect(await bucket.head(referenced)).not.toBeNull();
    expect(await bucket.head(elsewhere)).not.toBeNull();
  });

  it('runs daily', () => {
    expect((CRON_HOOKS[DAILY_CRON] ?? []).map((h) => h.name)).toContain('templates.fork_orphans');
  });
});
