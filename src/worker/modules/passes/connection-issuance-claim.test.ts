import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { normalizeEmail } from '../../../shared/email.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import {
  claimSnapshot,
  startExistingItem,
  startNewItem,
} from '../connections/repo-webhook-items.ts';
import { insertStagedWebhook, type RetainedRow } from '../connections/repo-webhook-retention.ts';
import { retainedWebhookRefHash } from '../connections/webhook-claim-ref.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { applyConnectionRecord } from './connection-passes.ts';
import { createPassFromConnection } from './connection-passes-create.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

let kit: Kit;

/** Connection setup is a system path: it needs a job context, bound to the database the test races. */
const jobAt = (db: D1Database) => ({ ...jobCtxOf(kit), env: { ...kit.env, DB: db } });
beforeAll(async () => {
  kit = await setupKit();
});

async function claimed() {
  const db = kit.env.DB;
  const connectionId = kit.fx.ids.id();
  const externalRef = `claim-${kit.fx.ids.token(8)}`;
  const reservedPassId = kit.fx.ids.id();
  const token = kit.fx.ids.id();
  const release = await requireApprovedRelease(
    kit.ctx,
    kit.template.id,
    kit.org.id,
    'live',
    'apple',
  );
  const expectedRelease = {
    kind: 'approved' as const,
    id: release.id,
    generation: release.generation,
    version: release.version,
  };
  const releaseSnapshot = JSON.stringify(expectedRelease);
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(db, kit.env);
  const { refHash } = await retainedWebhookRefHash(kit.ctx, kit.org.id, connectionId, externalRef);
  await run(
    db,
    `INSERT INTO connections
    (id, org_id, connector_type, name, mode, generation, auto_create, default_template_id, created_at, updated_at)
    VALUES (?, ?, 'demo', 'claim issuance', 'webhook', 1, 1, ?, 1, 1)`,
    [connectionId, kit.org.id, kit.template.id],
  );
  const retentionId = kit.fx.ids.id();
  const row: RetainedRow = {
    id: retentionId,
    connectionId,
    orgId: kit.org.id,
    eventId: kit.fx.ids.id(),
    generation: 1,
    source: 'ingress',
    connectionMode: 'webhook',
    referenceMode: 'embedded-required',
    refHash: await sha256Hex(JSON.stringify([externalRef])),
    state: 'pending',
    errorCode: null,
    releaseSnapshot,
    credentialKeysetCommitment,
    snapshotKnown: true,
    revision: 0,
    itemCount: 1,
    chunkCount: 1,
    replayGeneration: 0,
    envelope: await encryptSecret(
      await loadKekRing(kit.env),
      JSON.stringify({
        refs: [externalRef],
        items: [{ ref: externalRef, record: null, deleted: false }],
        rawBody: null,
        credentialKeysetCommitment,
      }),
      credentialAad(retentionId, kit.org.id, 'connection.webhook'),
    ),
    receivedAt: kit.clock.now(),
    updatedAt: kit.clock.now(),
  };
  expect(await insertStagedWebhook(jobAt(db), [row])).toBe(true);
  const candidate = {
    kind: 'new' as const,
    reservedPassId,
    orgId: kit.org.id,
    connectionId,
    externalRef,
    generation: 1,
    templateId: kit.template.id,
    expectedRelease,
    credentialKeysetCommitment,
  };
  expect(
    await startNewItem(
      jobAt(db),
      row,
      0,
      token,
      candidate,
      claimSnapshot(row, candidate, refHash, credentialKeysetCommitment),
      refHash,
      credentialKeysetCommitment,
    ),
  ).toBe(true);
  const input = {
    orgId: kit.org.id,
    mode: 'live' as const,
    templateId: kit.template.id,
    expectedRelease: { id: release.id, generation: release.generation, version: release.version },
    generation: 1,
    expectedConnectionMode: 'webhook' as const,
    connectionId,
    externalRef,
    credentialKeysetCommitment,
    reservedPassId,
    retainedClaim: {
      retentionId: row.id,
      ordinal: 0,
      token,
      revision: 0,
      refHash,
      credentialKeysetCommitment,
    },
    fields: { memberName: 'Claimed member' },
    holderEmail: null,
    sendEmail: false,
  };
  return { input, row };
}

/** Interleave a real D1 mutation immediately before the batch containing pass INSERT. */
async function beforePassInsert<T>(
  change: (db: D1Database) => Promise<void>,
  call: () => Promise<T>,
): Promise<T> {
  const db = kit.env.DB;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; native: D1PreparedStatement }
  >();
  let intercepted = false;
  const wrap = (native: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(native, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { sql, native });
    return wrapped;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (items: D1PreparedStatement[]) => {
          if (
            !intercepted &&
            items.some((item) => /^\s*INSERT INTO passes\b/i.test(statements.get(item)?.sql ?? ''))
          ) {
            intercepted = true;
            await change(db);
          }
          return target.batch(items.map((item) => statements.get(item)?.native ?? item));
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    return await call();
  } finally {
    Object.assign(kit.env, { DB: db });
    expect(intercepted).toBe(true);
  }
}

describe('retained webhook issuance claim', () => {
  it('issues and replays only the exact claimed pass while the original item stays started', async () => {
    const { input, row } = await claimed();
    expect(await createPassFromConnection(jobCtxOf(kit), input)).toEqual({
      passId: input.reservedPassId,
    });
    const pass = await getPass(kit.env.DB, input.reservedPassId);
    expect(pass).toMatchObject({
      version: 1,
      linkGeneration: 1,
      credentialGeneration: 1,
      lifecycleGeneration: 0,
      templateId: input.templateId,
      releaseId: input.expectedRelease.id,
    });
    expect(await createPassFromConnection(jobCtxOf(kit), input)).toEqual({
      passId: input.reservedPassId,
    });
    await run(
      kit.env.DB,
      "UPDATE connection_webhook_items SET state = 'uncertain' WHERE retention_id = ? AND ordinal = 0",
      [row.id],
    );
    await expect(createPassFromConnection(jobCtxOf(kit), input)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await all(kit.env.DB, 'SELECT id FROM passes WHERE connection_id = ?', [input.connectionId]),
    ).toHaveLength(1);
  }, 60_000);

  it('assigns the uniquely verified owner at insertion, not an unverified primary-email claimant', async () => {
    const { input } = await claimed();
    const email = normalizeEmail(`claim-owner-${kit.fx.ids.token(6)}@example.test`);
    await makeUser(kit.fx, { primaryEmail: email, verified: false });
    const verified = await makeUser(kit.fx);
    await run(
      kit.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
      [email, verified.id, kit.clock.now()],
    );
    await createPassFromConnection(jobCtxOf(kit), { ...input, holderEmail: email });
    expect(await getPass(kit.env.DB, input.reservedPassId)).toMatchObject({
      holderEmail: email,
      ownerUserId: verified.id,
      version: 1,
      credentialGeneration: 1,
      linkGeneration: 1,
    });
    const audit = await all<{ actor_type: string; actor_id: string; detail: string }>(
      kit.env.DB,
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'holder.attach' AND target_id = ?",
      [input.reservedPassId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'connection', actor_id: input.connectionId });
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ via: 'email', userId: verified.id });
    expect(
      await first(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
        input.reservedPassId,
      ]),
    ).toBeNull();
  }, 60_000);

  it('rejects a changed reference and a different concurrent winner instead of adopting it', async () => {
    const { input } = await claimed();
    await expect(
      createPassFromConnection(jobCtxOf(kit), { ...input, externalRef: 'different-ref' }),
    ).rejects.toMatchObject({ status: 409 });
    const { reservedPassId: _reserved, retainedClaim: _claim, ...ordinary } = input;
    const other = await createPassFromConnection(jobCtxOf(kit), ordinary);
    expect(other.passId).not.toBe(input.reservedPassId);
    await expect(createPassFromConnection(jobCtxOf(kit), input)).rejects.toMatchObject({
      status: 409,
    });
    expect(await getPass(kit.env.DB, input.reservedPassId)).toBeNull();
  }, 60_000);

  it.each(['started', 'uncertain'] as const)(
    'holds a holder change when a %s retained item already binds the existing pass',
    async (state) => {
      const { input, row } = await claimed();
      await run(
        kit.env.DB,
        `UPDATE connection_webhook_items SET state = 'pending', token = NULL,
        claim_kind = NULL, claim_pass_id = NULL, claim_revision = NULL, claim_snapshot = NULL
        WHERE retention_id = ? AND ordinal = 0`,
        [row.id],
      );
      const { reservedPassId: _reserved, retainedClaim: _claim, ...ordinary } = input;
      const { passId } = await createPassFromConnection(jobCtxOf(kit), ordinary);
      const pass = await getPass(kit.env.DB, passId);
      if (!pass) throw new Error('Missing claimed pass');
      const context = {
        passId,
        orgId: pass.orgId,
        mode: 'live' as const,
        status: 'active' as const,
        expectedVersion: pass.version,
        expectedRowVersion: pass.rowVersion,
        ownerUserId: pass.ownerUserId,
        linkGeneration: pass.linkGeneration,
        identityId: pass.identityId,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        transferPending: false,
        credentialKeysetCommitment: input.credentialKeysetCommitment,
        connectionId: input.connectionId,
        externalRef: input.externalRef,
        generation: 1,
        expectedConnectionMode: 'webhook' as const,
      };
      const candidate = {
        kind: 'existing' as const,
        snapshot: context,
        templateId: pass.templateId,
        releaseId: pass.releaseId,
        templateVersion: pass.templateVersion,
        credentialKeysetCommitment: input.credentialKeysetCommitment,
      };
      const token = kit.fx.ids.id();
      expect(
        await startExistingItem(
          jobAt(kit.env.DB),
          row,
          0,
          token,
          candidate,
          claimSnapshot(
            row,
            candidate,
            input.retainedClaim.refHash,
            input.retainedClaim.credentialKeysetCommitment,
          ),
          input.retainedClaim.credentialKeysetCommitment,
        ),
      ).toBe(true);
      if (state === 'uncertain')
        await run(
          kit.env.DB,
          "UPDATE connection_webhook_items SET state = 'uncertain' WHERE retention_id = ?",
          [row.id],
        );
      const objects = await kit.env.BUCKET.list({ prefix: `passes/${passId}/` });
      await expect(
        applyConnectionRecord(jobCtxOf(kit), {
          ...context,
          holderEmail: 'next@example.test',
          fields: { memberName: 'Private replacement' },
          cause: 'connection',
        }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(await getPass(kit.env.DB, passId)).toMatchObject({
        holderEmail: pass.holderEmail,
        ownerUserId: pass.ownerUserId,
        serial: pass.serial,
        authToken: pass.authToken,
        scanCode: pass.scanCode,
        version: pass.version,
        linkGeneration: pass.linkGeneration,
        credentialGeneration: pass.credentialGeneration,
        personalization: pass.personalization,
      });
      expect(
        await first(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
          passId,
        ]),
      ).toBeNull();
      expect(
        (await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects
          .map((o) => o.key)
          .sort(),
      ).toEqual(objects.objects.map((o) => o.key).sort());
    },
    120_000,
  );

  it.each([
    'uncertain',
    'token',
    'claim-pass',
    'claim-keyset',
    'release',
    'connection-mode',
    'connection-generation',
  ] as const)(
    'rolls back issuance when %s changes at the final INSERT',
    async (change) => {
      const { input, row } = await claimed();
      await beforePassInsert(
        async (db) => {
          if (change === 'uncertain')
            await run(
              db,
              "UPDATE connection_webhook_items SET state = 'uncertain' WHERE retention_id = ?",
              [row.id],
            );
          else if (change === 'token')
            await run(db, 'UPDATE connection_webhook_items SET token = ? WHERE retention_id = ?', [
              kit.fx.ids.id(),
              row.id,
            ]);
          else if (change === 'claim-pass')
            await run(
              db,
              'UPDATE connection_webhook_items SET claim_pass_id = ? WHERE retention_id = ?',
              [kit.fx.ids.id(), row.id],
            );
          else if (change === 'claim-keyset')
            await run(
              db,
              `UPDATE connection_webhook_items SET claim_snapshot =
            json_set(claim_snapshot, '$.credentialKeysetCommitment', ?) WHERE retention_id = ?`,
              ['f'.repeat(64), row.id],
            );
          else if (change === 'release') await approveAppleRelease(kit, { db });
          else if (change === 'connection-mode')
            await run(db, "UPDATE connections SET mode = 'hybrid' WHERE id = ?", [
              input.connectionId,
            ]);
          else
            await run(db, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
              input.connectionId,
            ]);
        },
        async () => {
          await expect(createPassFromConnection(jobCtxOf(kit), input)).rejects.toMatchObject({
            status: 409,
          });
        },
      );
      expect(await getPass(kit.env.DB, input.reservedPassId)).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT pass_id FROM pass_issuance_deliveries WHERE pass_id = ?', [
          input.reservedPassId,
        ]),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          "SELECT id FROM audit_log WHERE target_type = 'pass' AND target_id = ?",
          [input.reservedPassId],
        ),
      ).toBeNull();
      expect(
        (await kit.env.BUCKET.list({ prefix: `passes/${input.reservedPassId}/` })).objects,
      ).toHaveLength(0);
    },
    120_000,
  );
});
