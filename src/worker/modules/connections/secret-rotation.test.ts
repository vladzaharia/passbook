import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import connector from '../../connectors/webhook-push/index.ts';
import { all, first } from '../../platform/db.ts';
import * as actions from './actions.ts';
import { dailyConnections, REF_VERSION_IDLE_MS } from './jobs.ts';
import { getConnection, patchConnection } from './repo.ts';
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

describe('review hardening', () => {
  const stripeConn = (secret: string, name = 'Stripe') =>
    createDemo(kit, {
      connectorType: 'webhook-push',
      config: { recipe: 'stripe-subscriptions' },
      mode: 'webhook',
      webhookSecret: secret,
      name,
    } as never);
  const fresh = () => `whsec_${crypto.randomUUID()}`;

  it('a sweep patch is refused when the previous credential changed since it was listed', async () => {
    const dto = await conn();
    await actions.rotateWebhookSecret(kit.sctx, kit.actor, dto.id);
    const c = await getConnection(kit.env.DB, dto.id);
    const clear = {
      webhookPrevCredentialId: null,
      webhookPrevUntil: null,
      webhookPrevSecretFp: null,
    };
    expect(
      await patchConnection(kit.sctx, dto.id, clear, {
        actor: { orgId: c?.orgId ?? '' },
        prevCredentialId: 'not-the-one',
      }),
    ).toBe(0);
    expect((await getConnection(kit.env.DB, dto.id))?.webhookPrevCredentialId).toBe(
      c?.webhookPrevCredentialId,
    );
    expect(
      await patchConnection(kit.sctx, dto.id, clear, {
        actor: { orgId: c?.orgId ?? '' },
        prevCredentialId: c?.webhookPrevCredentialId ?? '',
      }),
    ).toBe(1);
  });

  it('the previous-secret sweep clears more than one batch', async () => {
    const dto = await conn();
    const c = await getConnection(kit.env.DB, dto.id);
    const ids: string[] = [];
    const stmts = [];
    for (let i = 0; i < 130; i++) {
      const cred = `cred-sweep-${i}`;
      const id = `conn-sweep-${i}`;
      ids.push(id);
      stmts.push(
        kit.env.DB.prepare(
          "INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES (?, ?, 'webhook', 1, x'00', x'00', x'00', 1)",
        ).bind(cred, kit.org.id),
        kit.env.DB.prepare(
          "INSERT INTO connections (id, org_id, connector_type, name, webhook_prev_credential_id, webhook_prev_until, created_at, updated_at) VALUES (?, ?, 'x', 'C', ?, 5, 1, 1)",
        ).bind(id, kit.org.id, cred),
      );
    }
    await kit.env.DB.batch(stmts);
    expect(c).toBeTruthy();
    await dailyConnections(kit.sctx);
    const left = await all(
      kit.env.DB,
      "SELECT id FROM connections WHERE webhook_prev_credential_id IS NOT NULL AND id LIKE 'conn-sweep-%'",
    );
    expect(left).toEqual([]);
    expect(
      await all(kit.env.DB, "SELECT id FROM credentials WHERE id LIKE 'cred-sweep-%'"),
    ).toEqual([]);
  });

  it('idle ref versions go in bounded batches, recent ones stay', async () => {
    const dto = await conn();
    const now = kit.clock.now();
    const stmts = [];
    for (let i = 0; i < 450; i++) {
      stmts.push(
        kit.env.DB.prepare(
          'INSERT INTO connection_ref_versions (org_id, connection_id, ref, source_version, updated_at) VALUES (?, ?, ?, 1, ?)',
        ).bind(kit.org.id, dto.id, `r${i}`, i < 440 ? now - REF_VERSION_IDLE_MS - 1 : now),
      );
    }
    await kit.env.DB.batch(stmts);
    await dailyConnections(kit.sctx);
    const left = await all<{ ref: string }>(
      kit.env.DB,
      'SELECT ref FROM connection_ref_versions WHERE connection_id = ? ORDER BY ref',
      [dto.id],
    );
    expect(left).toHaveLength(10);
  });

  it('refusing a reused secret says nothing about where it is used', async () => {
    const secret = fresh();
    await stripeConn(secret);
    const err = await stripeConn(secret, 'Other').catch((e: Error) => e);
    expect(err).toMatchObject({ status: 422, message: 'This signing secret cannot be used.' });
    expect(JSON.stringify(err)).not.toContain('another connection');
  });

  it('a demoted secret stays unique until its overlap ends', async () => {
    const s1 = fresh();
    const dto = await stripeConn(s1);
    const { update } = await import('./service.ts');
    await update(kit.sctx, kit.actor, dto.id, { webhookSecret: fresh(), overlapSeconds: 3600 });
    await expect(stripeConn(s1, 'Replay')).rejects.toMatchObject({ status: 422 });
    // The same connection may take it back.
    await expect(
      update(kit.sctx, kit.actor, dto.id, { webhookSecret: s1, overlapSeconds: 0 }),
    ).resolves.toBeDefined();
    const s2 = fresh();
    const dto2 = await stripeConn(s2, 'Two');
    await update(kit.sctx, kit.actor, dto2.id, { webhookSecret: fresh(), overlapSeconds: 3600 });
    await actions.revokePreviousWebhookSecret(kit.sctx, kit.actor, dto2.id);
    await expect(stripeConn(s2, 'After revoke')).resolves.toBeDefined();
    const s3 = fresh();
    const dto3 = await stripeConn(s3, 'Three');
    await update(kit.sctx, kit.actor, dto3.id, { webhookSecret: fresh(), overlapSeconds: 3600 });
    kit.clock.advance(3_600_001);
    await dailyConnections(kit.sctx);
    await expect(stripeConn(s3, 'After sweep')).resolves.toBeDefined();
  });

  it('logs the previous secret at most once an hour per connection', async () => {
    const dto = await conn();
    const old = dto.webhookSecret as string;
    const { webhookSecret: fresh1 } = await actions.rotateWebhookSecret(
      kit.sctx,
      kit.actor,
      dto.id,
    );
    const info = vi.spyOn(kit.sctx.log, 'info');
    const logged = () =>
      info.mock.calls.filter((c) => c[0] === 'connection.webhook_prev_secret').length;
    await status(dto.id, fresh1, 'n1');
    expect(logged()).toBe(0);
    await status(dto.id, old, 'p1');
    await status(dto.id, old, 'p2');
    expect(logged()).toBe(1);
    kit.clock.advance(3_600_000);
    await status(dto.id, old, 'p3');
    expect(logged()).toBe(2);
    expect(JSON.stringify(info.mock.calls)).not.toContain(old);
  });

  it('a non-finite source version is refused at ingress', async () => {
    const dto = await conn();
    const verify = vi.spyOn(connector, 'verifyWebhook');
    verify.mockResolvedValueOnce({
      eventId: 'e',
      refs: [],
      signedAt: kit.clock.now(),
      versions: { r: Number.NaN },
    });
    await expect(
      receiveWebhook(
        kit.sctx,
        dto.id,
        new Request('https://wallet.test/h', { method: 'POST', body: '{}' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    verify.mockRestore();
  });
});
