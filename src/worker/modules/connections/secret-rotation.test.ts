import { beforeEach, describe, expect, it } from 'vitest';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { all, first } from '../../platform/db.ts';
import * as actions from './actions.ts';
import { dailyConnections, REF_VERSION_IDLE_MS } from './jobs.ts';
import { getConnection } from './repo.ts';
import { deleteCredentials } from './repo-credentials.ts';
import * as service from './service.ts';
import { createDemo, type Kit, makeKit } from './test-kit.ts';
import { receiveWebhook } from './webhooks.ts';

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit();
});

const conn = () =>
  createDemo(kit, { connectorType: 'webhook-push', config: {}, mode: 'webhook' } as never);

async function status(connectionId: string, secret: string, eventId: string): Promise<number> {
  const body = JSON.stringify({ id: eventId, records: [] });
  const ts = Math.floor(kit.clock.now() / 1000);
  const req = new Request('https://wallet.test/h', {
    method: 'POST',
    body,
    headers: {
      'x-wallet-timestamp': String(ts),
      'x-wallet-signature': await signWebhook(secret, ts, body),
    },
  });
  return receiveWebhook(kit.sctx, connectionId, req).then(
    () => 200,
    (e: { status?: number }) => e.status ?? 500,
  );
}

const credentialExists = async (id: string | null) =>
  id !== null && (await first(kit.env.DB, 'SELECT 1 FROM credentials WHERE id = ?', [id])) !== null;

describe('webhook secret overlap', () => {
  it('keeps the replaced secret valid until the overlap ends, then refuses it', async () => {
    const dto = await conn();
    const old = dto.webhookSecret as string;
    const before = await getConnection(kit.env.DB, dto.id);
    const { webhookSecret: fresh, connection } = await actions.rotateWebhookSecret(
      kit.sctx,
      kit.actor,
      dto.id,
      undefined,
      3600,
    );
    expect(connection.webhookPrevUntil).toBe(kit.clock.now() + 3_600_000);
    expect(await status(dto.id, fresh, 'e1')).toBe(200);
    expect(await status(dto.id, old, 'e2')).toBe(200);
    expect(await credentialExists(before?.webhookCredentialId ?? null)).toBe(true);
    kit.clock.advance(3_600_000 + 1);
    expect(await status(dto.id, old, 'e3')).toBe(401);
    expect(await status(dto.id, fresh, 'e4')).toBe(200);
  });

  it('overlap 0 drops the old secret at once and deletes its credential', async () => {
    const dto = await conn();
    const old = dto.webhookSecret as string;
    const before = await getConnection(kit.env.DB, dto.id);
    const { connection } = await actions.rotateWebhookSecret(
      kit.sctx,
      kit.actor,
      dto.id,
      undefined,
      0,
    );
    expect(connection.webhookPrevUntil).toBeNull();
    expect(await status(dto.id, old, 'e1')).toBe(401);
    expect(await credentialExists(before?.webhookCredentialId ?? null)).toBe(false);
  });

  it('a second rotation drops the oldest secret and its credential', async () => {
    const dto = await conn();
    const first1 = dto.webhookSecret as string;
    const c0 = await getConnection(kit.env.DB, dto.id);
    const second = await actions.rotateWebhookSecret(kit.sctx, kit.actor, dto.id);
    await actions.rotateWebhookSecret(kit.sctx, kit.actor, dto.id);
    expect(await status(dto.id, first1, 'e1')).toBe(401);
    expect(await status(dto.id, second.webhookSecret, 'e2')).toBe(200);
    expect(await credentialExists(c0?.webhookCredentialId ?? null)).toBe(false);
  });

  it('a pasted replacement through update honours overlapSeconds', async () => {
    const dto = await conn();
    const old = dto.webhookSecret as string;
    const pasted = `pasted_${crypto.randomUUID()}`;
    await service.update(kit.sctx, kit.actor, dto.id, {
      webhookSecret: pasted,
      overlapSeconds: 3600,
    });
    expect(await status(dto.id, old, 'e1')).toBe(200);
    expect(await status(dto.id, pasted, 'e2')).toBe(200);
    const again = `pasted_${crypto.randomUUID()}`;
    await service.update(kit.sctx, kit.actor, dto.id, { webhookSecret: again, overlapSeconds: 0 });
    expect(await status(dto.id, old, 'e3')).toBe(401);
    expect(await status(dto.id, pasted, 'e4')).toBe(401);
  });

  it('revoke now stops the previous secret and deletes it', async () => {
    const dto = await conn();
    const old = dto.webhookSecret as string;
    const before = await getConnection(kit.env.DB, dto.id);
    await actions.rotateWebhookSecret(kit.sctx, kit.actor, dto.id);
    expect(await status(dto.id, old, 'e1')).toBe(200);
    const revoked = await actions.revokePreviousWebhookSecret(kit.sctx, kit.actor, dto.id);
    expect(revoked.webhookPrevUntil).toBeNull();
    expect(await status(dto.id, old, 'e2')).toBe(401);
    expect(await credentialExists(before?.webhookCredentialId ?? null)).toBe(false);
    // Nothing to revoke is not an error.
    await expect(
      actions.revokePreviousWebhookSecret(kit.sctx, kit.actor, dto.id),
    ).resolves.toBeDefined();
  });

  it('deleting credentials never removes a referenced previous credential', async () => {
    const dto = await conn();
    await actions.rotateWebhookSecret(kit.sctx, kit.actor, dto.id);
    const c = await getConnection(kit.env.DB, dto.id);
    await deleteCredentials(kit.env.DB, [c?.webhookPrevCredentialId ?? null]);
    expect(await credentialExists(c?.webhookPrevCredentialId ?? null)).toBe(true);
  });

  it('the daily sweep drops an expired previous secret and its credential', async () => {
    const dto = await conn();
    await actions.rotateWebhookSecret(kit.sctx, kit.actor, dto.id, undefined, 3600);
    const c = await getConnection(kit.env.DB, dto.id);
    await dailyConnections(kit.sctx);
    expect(await credentialExists(c?.webhookPrevCredentialId ?? null)).toBe(true);
    kit.clock.advance(3_600_001);
    await dailyConnections(kit.sctx);
    const after = await getConnection(kit.env.DB, dto.id);
    expect(after).toMatchObject({ webhookPrevCredentialId: null, webhookPrevUntil: null });
    expect(await credentialExists(c?.webhookPrevCredentialId ?? null)).toBe(false);
    expect(after?.webhookCredentialId).toBe(c?.webhookCredentialId);
  });
});

describe('ref version retention', () => {
  it('drops versions idle for 30 days and keeps recent ones', async () => {
    const dto = await conn();
    const now = kit.clock.now();
    for (const [ref, at] of [
      ['old', now - REF_VERSION_IDLE_MS - 1],
      ['recent', now - 1000],
    ] as const) {
      await kit.env.DB.prepare(
        'INSERT INTO connection_ref_versions (org_id, connection_id, ref, source_version, updated_at) VALUES (?, ?, ?, 1, ?)',
      )
        .bind(kit.org.id, dto.id, ref, at)
        .run();
    }
    await dailyConnections(kit.sctx);
    const refs = await all<{ ref: string }>(
      kit.env.DB,
      'SELECT ref FROM connection_ref_versions WHERE connection_id = ?',
      [dto.id],
    );
    expect(refs.map((r) => r.ref)).toEqual(['recent']);
  });
});
