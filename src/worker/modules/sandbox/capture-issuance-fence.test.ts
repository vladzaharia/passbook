import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { makeUser, withoutTrigger } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
import { bundleEmailSnapshot } from '../bundles/email-binding.ts';
import { createBundle } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { getOutbox } from '../delivery/repo.ts';
import { claimOutbox } from '../delivery/repo-outbox-processing.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import type { CaptureSnapshot } from './binding.ts';
import { captureEmail } from './capture.ts';
import { snapshotFence } from './repo-snapshot-fence.ts';
import { grantInboxMembership, inboxAuthority, inboxMember } from './test-tenant-fixtures.ts';

let kit: Kit;

beforeAll(async () => {
  kit = await setupKit();
});

const message = {
  subject: 'Private issuance',
  html: '<p>Private holder content</p>',
  text: 'Private holder content',
};

/** Run the intervention after the snapshot and issuance preflight, immediately before the capture batch. */
function captureRace(intervene?: () => Promise<void>): { ctx: ServiceContext; hit: () => boolean } {
  let invoked = false;
  const db = new Proxy(kit.env.DB, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!invoked) {
            invoked = true;
            await intervene?.();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env: AppEnv = { ...kit.env, DB: db };
  return { ctx: { ...jobCtxOf(kit), env }, hit: () => invoked };
}

async function tenantIssued() {
  const user = await makeUser(kit.fx);
  const member = await inboxMember(kit, user.id, kit.org.id, 'pass_operator');
  const authority = await inboxAuthority(kit, member.session);
  const release = await requireApprovedRelease(
    kit.ctx,
    kit.template.id,
    kit.org.id,
    'test',
    'apple',
  );
  const to = `${kit.fx.ids.token(10).toLowerCase()}@example.com`;
  const pass = await createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: 'Issuance holder' },
    holderEmail: to,
    sendEmail: true,
    source: 'manual',
    mode: 'test',
    execution: { kind: 'tenant', authority },
    actor: { type: 'user', id: user.id },
  });
  const queued = await first<{ outbox_id: string }>(
    kit.env.DB,
    "SELECT outbox_id FROM pass_issuance_deliveries WHERE pass_id = ? AND state = 'queued'",
    [pass.id],
  );
  if (!queued?.outbox_id) throw new Error('Missing queued issuance');
  return { pass, to, outboxId: queued.outbox_id, user, member, release };
}

async function capture(
  outboxId: string,
  passId: string,
  to: string,
  intervene?: () => Promise<void>,
) {
  await kit.settle();
  const lease = kit.ctx.ids.token(8);
  const row = await claimOutbox(kit.env.DB, outboxId, lease, kit.clock.now(), 86_400_000);
  if (!row) throw new Error('Missing issuance lease');
  const race = captureRace(intervene);
  const inserted = await captureEmail(race.ctx, {
    row,
    lease,
    orgId: kit.org.id,
    passId,
    eventPassId: passId,
    to,
    attached: false,
    email: message,
  });
  expect(race.hit()).toBe(true);
  return inserted;
}

async function assertStale(
  outboxId: string,
  passId: string,
  sent: number,
  errorCode = 'DELIVERY_STALE',
) {
  expect(
    await first(kit.env.DB, 'SELECT id FROM captured_emails WHERE outbox_id = ?', [outboxId]),
  ).toBeNull();
  expect(
    await first(
      kit.env.DB,
      "SELECT id FROM pass_events WHERE pass_id = ? AND kind IN ('email.captured', 'email.sent', 'email.failed') AND json_extract(data, '$.outboxId') = ?",
      [passId, outboxId],
    ),
  ).toBeNull();
  expect(await getOutbox(kit.env.DB, outboxId)).toMatchObject({
    state: 'cancelled',
    errorCode,
  });
  expect(kit.mailer.sent).toHaveLength(sent);
}

describe('issuance authority at the Test capture boundary', () => {
  it('captures an unchanged issued message without sending externally', async () => {
    const issued = await tenantIssued();
    const sent = kit.mailer.sent.length;
    expect(await capture(issued.outboxId, issued.pass.id, issued.to)).toBe(true);
    expect(
      await first(
        kit.env.DB,
        "SELECT recipient, html, json_extract(intent, '$.issuanceId') AS issuance_id FROM captured_emails WHERE outbox_id = ?",
        [issued.outboxId],
      ),
    ).toEqual({ recipient: issued.to, html: message.html, issuance_id: issued.pass.id });
    expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({
      state: 'sent',
      errorCode: 'TEST_MODE',
    });
    expect(kit.mailer.sent).toHaveLength(sent);
  }, 60_000);

  it.each(['membership', 'intent'] as const)(
    'does not capture when original %s authority changes after preflight',
    async (change) => {
      const issued = await tenantIssued();
      const sent = kit.mailer.sent.length;
      const inserted = await capture(issued.outboxId, issued.pass.id, issued.to, async () => {
        if (change === 'membership') {
          await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            issued.member.membershipId,
          ]);
          await grantInboxMembership(kit, issued.user.id, kit.org.id, 'pass_operator');
        } else {
          // The state guard only allows this after a transfer supersedes the outbox row.
          await withoutTrigger(kit.env.DB, 'pass_issuance_delivery_state_guard', () =>
            run(
              kit.env.DB,
              "UPDATE pass_issuance_deliveries SET state = 'cancelled', outbox_id = NULL WHERE pass_id = ?",
              [issued.pass.id],
            ),
          );
        }
      });
      expect(inserted).toBe(false);
      await assertStale(
        issued.outboxId,
        issued.pass.id,
        sent,
        change === 'membership' ? 'ACTOR_REVOKED' : 'DELIVERY_STALE',
      );
    },
    90_000,
  );

  it('still captures after the initiator signs out or the session is revoked', async () => {
    const issued = await tenantIssued();
    const sent = kit.mailer.sent.length;
    const inserted = await capture(issued.outboxId, issued.pass.id, issued.to, async () => {
      await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
        kit.clock.now(),
        await hashSessionCookie(issued.member.session.cookieValue),
      ]);
    });
    expect(inserted).toBe(true);
    expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({
      state: 'sent',
      errorCode: 'TEST_MODE',
    });
    expect(kit.mailer.sent).toHaveLength(sent);
  }, 90_000);

  it('continues using the original release after a later release is published', async () => {
    const issued = await tenantIssued();
    const sent = kit.mailer.sent.length;
    const inserted = await capture(issued.outboxId, issued.pass.id, issued.to, async () => {
      const newer = await approveAppleRelease(kit, { mode: 'test' });
      expect(newer.id).not.toBe(issued.release.id);
    });
    expect(inserted).toBe(true);
    expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({
      state: 'sent',
      errorCode: 'TEST_MODE',
    });
    expect(kit.mailer.sent).toHaveLength(sent);
  }, 90_000);

  it('captures when the pass release changes after its snapshot (releases are checked at create)', async () => {
    const issued = await tenantIssued();
    const sent = kit.mailer.sent.length;
    const newer = await approveAppleRelease(kit, { mode: 'test' });
    expect(newer.id).not.toBe(issued.release.id);
    const inserted = await capture(issued.outboxId, issued.pass.id, issued.to, async () => {
      await run(kit.env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
        newer.id,
        issued.pass.id,
      ]);
    });
    expect(inserted).toBe(true);
    expect(kit.mailer.sent).toHaveLength(sent);
  }, 90_000);
});

/** Model a retained historical connection-backed Test intent; current connector issuance is Live-only. */
async function historicalConnectionIssued(mismatchedRelease = false) {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, generation, created_at, updated_at)
    VALUES (?, ?, 'demo', 'historical source', 1, ?, ?)`,
    [id, kit.org.id, kit.clock.now(), kit.clock.now()],
  );
  const to = `${kit.fx.ids.token(10).toLowerCase()}@example.com`;
  const initial = await kit.pass({ mode: 'test', holderEmail: to });
  const externalRef = kit.fx.ids.token(12);
  await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
    id,
    externalRef,
    initial.id,
  ]);
  const pass = await getPass(kit.env.DB, initial.id);
  if (!pass) throw new Error('Missing historical pass');
  const release = await requireApprovedRelease(
    kit.ctx,
    pass.templateId,
    pass.orgId,
    'test',
    'apple',
  );
  const queued = await enqueuePassEmail(jobCtxOf(kit), {
    passId: pass.id,
    to,
    attach: false,
    expected: pass,
  });
  // Dispatch marks the row enqueued in the background; the ledger only queues a pending row.
  await kit.settle();
  await run(kit.env.DB, "UPDATE outbox SET state = 'pending' WHERE id = ?", [queued.outboxId]);
  const connection = { orgId: pass.orgId, connectionId: id, externalRef, generation: 1 };
  const originalRelease = mismatchedRelease
    ? { ...release, generation: release.generation + 1 }
    : release;
  const context = JSON.stringify({
    execution: { kind: 'connection', connectionId: id, generation: 1 },
    release: originalRelease,
    connection,
    connectionMode: null,
  });
  await run(
    kit.env.DB,
    "UPDATE outbox SET payload = json_set(payload, '$.intent.issuanceId', ?) WHERE id = ?",
    [pass.id, queued.outboxId],
  );
  await run(
    kit.env.DB,
    `INSERT INTO pass_issuance_deliveries
    (pass_id, org_id, mode, recipient, identity_id, source_owner_user_id, source_generation,
     source_lifecycle_generation, source_link_generation, source_object_key,
     template_id, connection_id, connection_ref, connection_generation,
     context, state, outbox_id, created_at)
    SELECT id, org_id, mode, holder_email, identity_id, owner_user_id, credential_generation,
      lifecycle_generation, link_generation, object_key,
      template_id, connection_id, external_ref, 1,
      ?, 'pending', NULL, ? FROM passes WHERE id = ?`,
    [context, kit.clock.now(), pass.id],
  );
  // A delivery enters the ledger pending and is queued by the guarded transition.
  await run(
    kit.env.DB,
    "UPDATE pass_issuance_deliveries SET state = 'queued', outbox_id = ? WHERE pass_id = ?",
    [queued.outboxId, pass.id],
  );
  return { pass, to, outboxId: queued.outboxId, connectionId: id };
}

describe('historical connection-backed Test issuance', () => {
  it.each(['unchanged', 'disabled', 'generation'] as const)(
    'uses the original connection authority when %s at capture',
    async (change) => {
      const issued = await historicalConnectionIssued();
      const sent = kit.mailer.sent.length;
      const inserted = await capture(issued.outboxId, issued.pass.id, issued.to, async () => {
        if (change === 'disabled')
          await run(kit.env.DB, 'UPDATE connections SET enabled = 0 WHERE id = ?', [
            issued.connectionId,
          ]);
        else if (change === 'generation')
          await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
            issued.connectionId,
          ]);
      });
      if (change === 'unchanged') {
        expect(inserted).toBe(true);
        expect(
          await first(kit.env.DB, 'SELECT id FROM captured_emails WHERE outbox_id = ?', [
            issued.outboxId,
          ]),
        ).not.toBeNull();
        expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({
          state: 'sent',
          errorCode: 'TEST_MODE',
        });
        expect(kit.mailer.sent).toHaveLength(sent);
      } else {
        expect(inserted).toBe(false);
        await assertStale(issued.outboxId, issued.pass.id, sent);
      }
    },
    90_000,
  );

  it('does not compare the retained release at capture', async () => {
    const issued = await historicalConnectionIssued(true);
    const sent = kit.mailer.sent.length;
    expect(await capture(issued.outboxId, issued.pass.id, issued.to)).toBe(true);
    expect(kit.mailer.sent).toHaveLength(sent);
  }, 90_000);
});

it('binds exact pass and bundle member epochs and rejects a fresh pending snapshot', async () => {
  const to = `${kit.fx.ids.token(10).toLowerCase()}@example.com`;
  const passes = [
    await kit.pass({ mode: 'test', holderEmail: to }),
    await kit.pass({ mode: 'test', holderEmail: to }),
  ];
  const bundle = await createBundle(
    jobCtxOf(kit),
    { type: 'system', id: null },
    'test',
    {
      orgId: kit.org.id,
      passIds: passes.map((pass) => pass.id),
      name: 'Snapshot fence',
      holderEmail: to,
    },
    { kind: 'system' },
  );
  const snapshot = await bundleEmailSnapshot(kit.env.DB, bundle.id);
  if (!snapshot) throw new Error('Missing bundle snapshot');
  const member = snapshot.passes[1]!;
  const allowed = async (value: CaptureSnapshot) => {
    const fence = snapshotFence(value);
    return first(kit.env.DB, `SELECT 1 AS ok WHERE ${fence.sql}`, fence.params);
  };
  const asPass: CaptureSnapshot = { kind: 'pass', pass: member };
  const asBundle: CaptureSnapshot = { kind: 'bundle', snapshot };
  expect(await allowed(asPass)).not.toBeNull();
  expect(await allowed(asBundle)).not.toBeNull();
  const changes: Partial<Pass>[] = [
    { identityId: kit.fx.ids.id() },
    { credentialGeneration: member.credentialGeneration + 1 },
    { lifecycleGeneration: member.lifecycleGeneration + 1 },
    { templateId: kit.fx.ids.id() },
    { linkGeneration: member.linkGeneration + 1 },
  ];
  for (const change of changes) {
    const changed = { ...member, ...change };
    expect(await allowed({ kind: 'pass', pass: changed })).toBeNull();
    expect(
      await allowed({
        kind: 'bundle',
        snapshot: {
          ...snapshot,
          passes: snapshot.passes.map((pass) => (pass.id === member.id ? changed : pass)),
        },
      }),
    ).toBeNull();
  }
  await stagePendingCredentialTransfer(kit.env.DB, member.id, {
    id: kit.fx.ids.id(),
    token: kit.ctx.ids.token(),
    now: kit.clock.now(),
    targetHolderEmail: to,
  });
  const pendingPass = await getPass(kit.env.DB, member.id);
  const pendingBundle = await bundleEmailSnapshot(kit.env.DB, bundle.id);
  if (!pendingPass || !pendingBundle) throw new Error('Missing pending snapshot');
  expect(pendingPass.credentialGeneration).toBe(member.credentialGeneration + 1);
  expect(await allowed(asPass)).toBeNull();
  expect(await allowed(asBundle)).toBeNull();
  expect(await allowed({ kind: 'pass', pass: pendingPass })).toBeNull();
  expect(await allowed({ kind: 'bundle', snapshot: pendingBundle })).toBeNull();
}, 60_000);
