import { describe, expect, it, vi } from 'vitest';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { applyKit } from './apply-test-fixtures.ts';
import { handleCapabilityChange, onChannelsMaybeChanged } from './capability.ts';

vi.mock('../wallet-providers/provider-policy.ts', async (original) => ({
  ...(await original<typeof import('../wallet-providers/provider-policy.ts')>()),
  walletProviderDisabledReason: () => null,
}));

/** A copy of the pass's template version under another name, with a google wallets block or without. */
async function previousVersion(t: Awaited<ReturnType<typeof applyKit>>, google: boolean) {
  const pass = await getPass(t.db, t.ids[0] ?? '');
  const cols = (await all<{ name: string }>(t.db, 'PRAGMA table_info(template_versions)')).map(
    (c) => c.name,
  );
  const name = `prev-${google ? 'g' : 'n'}-${t.kit.fx.ids.token(4)}`;
  const manifest = google
    ? "json_set(manifest, '$.wallets.google', json('{}'))"
    : "json_remove(manifest, '$.wallets.google')";
  const select = cols
    .map((c) => (c === 'version' ? '?' : c === 'manifest' ? manifest : c))
    .join(', ');
  await t.exec(
    `INSERT INTO template_versions (${cols.join(', ')}) SELECT ${select} FROM template_versions WHERE template_id = ? AND version = ?`,
    name,
    pass?.templateId ?? '',
    pass?.templateVersion ?? '',
  );
  return name;
}

describe('capability loss on republish', () => {
  it('queues only when the wallets the versions serve differ', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const pass = (await getPass(t.db, t.ids[0] ?? '')) as NonNullable<
      Awaited<ReturnType<typeof getPass>>
    >;
    const sent = () =>
      (t.kit.queue.sent as { kind: string }[]).filter((m) => m.kind === 'channel.capability')
        .length;
    await onChannelsMaybeChanged(ctx, pass, pass.templateVersion);
    await onChannelsMaybeChanged(ctx, pass, null);
    await onChannelsMaybeChanged(ctx, pass, await previousVersion(t, false));
    expect(sent()).toBe(0);
    await onChannelsMaybeChanged(ctx, pass, await previousVersion(t, true));
    expect(sent()).toBe(1);
  });

  it('retires a wallet the new version cannot serve, audits and journals it, and ignores a repeat', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const prev = await previousVersion(t, true);
    const job = {
      kind: 'channel.capability',
      passId: t.ids[0] ?? '',
      previousVersion: prev,
    } as const;
    await handleCapabilityChange(job, ctx);
    const rows = await all<{ channel: string; retired_cause: string }>(
      t.db,
      'SELECT channel, retired_cause FROM pass_channels WHERE pass_id = ? AND retired_at IS NOT NULL',
      [t.ids[0] ?? ''],
    );
    expect(rows).toEqual([{ channel: 'google', retired_cause: 'template' }]);
    expect(await t.audits('pass.channels_change')).toBe(1);
    expect(await t.feed()).toBe(1);
    await handleCapabilityChange(job, ctx);
    expect(await t.audits('pass.channels_change')).toBe(1);
    expect(await t.feed()).toBe(1);
  });

  it('restores a wallet when the pass moves to a version that serves it again', async () => {
    const t = await applyKit(1);
    const ctx = jobCtxOf(t.kit);
    const id = t.ids[0] ?? '';
    await handleCapabilityChange(
      { kind: 'channel.capability', passId: id, previousVersion: await previousVersion(t, true) },
      ctx,
    );
    await t.exec(
      'UPDATE passes SET template_version = ? WHERE id = ?',
      await previousVersion(t, true),
      id,
    );
    await handleCapabilityChange(
      { kind: 'channel.capability', passId: id, previousVersion: await previousVersion(t, false) },
      ctx,
    );
    expect(
      await t.count(
        'SELECT COUNT(*) AS n FROM pass_channels WHERE pass_id = ? AND retired_at IS NOT NULL',
        id,
      ),
    ).toBe(0);
  });
});
