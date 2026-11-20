import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { PublicStatusSchema } from '../../../shared/contracts/status.ts';
import { STATUS_SLOT } from '../../../web/developers/pages/status.tsx';
import { run } from '../../platform/db.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { clearPublicStatusMemo, publicStatus } from './public.ts';
import { statusHtml } from './public-page.tsx';
import { clearStatusCache } from './service.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
}, 30_000);

const fresh = () => {
  clearStatusCache(rk.kit.env.DB);
  clearPublicStatusMemo(rk.kit.env.DB);
  return publicStatus(rk.kit.ctx);
};

describe('the public status', () => {
  it('is four components (six with wallet credentials) in three states and incident notes, and nothing else', async () => {
    const status = PublicStatusSchema.parse(await fresh());
    expect(status.components.map((c) => c.id)).toEqual(['api', 'apple_push', 'email', 'webhooks']);
    // Google and Samsung are listed only once a platform credential exists.
    for (const c of status.components)
      expect(Object.keys(c).sort()).toEqual(['id', 'label', 'state']);
    expect(Object.keys(status).sort()).toEqual(['checkedAt', 'components', 'incidents', 'overall']);
  });

  it('leaks nothing of an organization, a user, a connection or a credential', async () => {
    const org = await makeOrg(rk.kit.fx, { slug: 'acme-secret-org' });
    const user = await makeUser(rk.kit.fx);
    // A failing org credential and a bad connection are the cases the admin status lists by org.
    await run(
      rk.kit.env.DB,
      `INSERT INTO status_incidents (id, title, note, component, impact, started_at) VALUES ('i1', 'Delays', 'Push is slow.', 'apple_push', 'degraded', ?)`,
      [rk.kit.clock.now()],
    );
    const json = JSON.stringify(await fresh());
    const html = await statusHtml(rk.kit.ctx, `<main>${STATUS_SLOT}</main>`);
    for (const text of [json, html]) {
      for (const secret of [
        org.id,
        'acme-secret-org',
        user.id,
        'wallet-credential',
        'connection:',
        'orgId',
        'database',
        'D1',
        'R2',
        'Polaris',
        'queue',
        'backlog',
      ])
        expect(text, secret).not.toContain(secret);
    }
    expect(json).toContain('Push is slow.');
    expect(html).toContain('Delays');
    expect(html).toContain('Apple push');
    expect(html).not.toContain(STATUS_SLOT);
  });

  it('shows open and recently resolved incidents, and lets an open outage set the overall state', async () => {
    const now = rk.kit.clock.now();
    await run(rk.kit.env.DB, 'DELETE FROM status_incidents');
    const add = (id: string, impact: string, startedAt: number, resolvedAt: number | null) =>
      run(
        rk.kit.env.DB,
        `INSERT INTO status_incidents (id, title, note, component, impact, started_at, resolved_at) VALUES (?, ?, 'n', NULL, ?, ?, ?)`,
        [id, id, impact, startedAt, resolvedAt],
      );
    await add('open-outage', 'outage', now - 1000, null);
    await add('resolved-recent', 'degraded', now - 3 * 86_400_000, now - 2 * 86_400_000);
    await add('resolved-old', 'degraded', now - 30 * 86_400_000, now - 29 * 86_400_000);
    const status = await fresh();
    expect(status.incidents.map((i) => i.id)).toEqual(['open-outage', 'resolved-recent']);
    expect(status.overall).toBe('outage');
  });

  it('answers a failed read with a one-line page, not an error', async () => {
    const broken = {
      ...rk.kit.ctx,
      env: { ...rk.kit.env, DB: undefined },
    } as unknown as typeof rk.kit.ctx;
    const html = await statusHtml(broken, `<main>${STATUS_SLOT}</main>`);
    expect(html).toContain('unavailable');
  });
});
