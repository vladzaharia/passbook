import { beforeAll, describe, expect, it } from 'vitest';
import {
  makeApiKey,
  makeSession,
  makeUser,
  withoutTrigger,
} from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { resolveSession } from '../auth/sessions.ts';
import { reassignHolder } from '../holders/service.ts';
import { approveAppleRelease, grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { jobCtxOf } from './delivery-test-fixtures.ts';
import { enqueuePassEmail, scheduleIssuanceDelivery } from './issuance-intent.ts';
import { handleEmailSend, sweepDelivery } from './jobs.ts';
import { getOutbox } from './repo.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
const job = () => jobCtxOf(kit);
const system = { type: 'system', id: null } as const;
const email = () => `${kit.fx.ids.token(10).toLowerCase()}@example.com`;

async function member() {
  const user = await makeUser(kit.fx);
  const membershipId = await grantKitMembership(kit, kit.org.id, user.id, ['pass_operator']);
  const session = await makeSession(kit.fx, { userId: user.id });
  const auth = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!auth) throw new Error('Session fixture missing');
  const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'passes:operate');
  return { user, membershipId, session, sessionId: auth.sessionId, authority };
}

/** A pass issued by this member with its issuance email queued under the member's captured authority. */
async function issuedBy(authority: TenantPassWrite, userId: string) {
  const release = kit.liveRelease ?? (await approveAppleRelease(kit));
  const to = email();
  const pass = await createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { memberName: 'Issued holder' },
    holderEmail: to,
    sendEmail: true,
    source: 'manual',
    mode: 'live',
    execution: { kind: 'tenant', authority },
    actor: { type: 'user', id: userId },
  });
  const row = await first<{ outbox_id: string }>(
    kit.env.DB,
    "SELECT outbox_id FROM pass_issuance_deliveries WHERE pass_id = ? AND state = 'queued'",
    [pass.id],
  );
  if (!row?.outbox_id) throw new Error('Issuance email was not queued');
  return { pass, to, outboxId: row.outbox_id };
}

async function send(outboxId: string) {
  const before = kit.mailer.sent.length;
  await handleEmailSend({ kind: 'email.send', outboxId }, job());
  return kit.mailer.sent.length - before;
}

describe('issuance email survives its initiator, stops on revocation', () => {
  it('is sent after the initiator signs out', async () => {
    const m = await member();
    const issued = await issuedBy(m.authority, m.user.id);
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      m.sessionId,
    ]);
    expect(await send(issued.outboxId)).toBe(1);
    expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({ state: 'sent' });
  });

  it('is sent after the initiator session idles out', async () => {
    const m = await member();
    const issued = await issuedBy(m.authority, m.user.id);
    kit.clock.advance(30 * 24 * 3_600_000);
    expect(await send(issued.outboxId)).toBe(1);
  });

  it('is sent after a branding edit and a content refresh', async () => {
    const m = await member();
    const issued = await issuedBy(m.authority, m.user.id);
    await run(kit.env.DB, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({ accent: '#112233' }),
      kit.org.id,
    ]);
    await run(
      kit.env.DB,
      'UPDATE passes SET version = version + 1, display_title = ? WHERE id = ?',
      ['Refreshed title', issued.pass.id],
    );
    expect(await send(issued.outboxId)).toBe(1);
  });

  it('queues an idempotent replay of the schedule after sign-out', async () => {
    const m = await member();
    const issued = await issuedBy(m.authority, m.user.id);
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      m.sessionId,
    ]);
    expect(await scheduleIssuanceDelivery(job(), issued.pass.id)).toBe('queued');
    expect(await send(issued.outboxId)).toBe(1);
  });

  it('is refused after the initiator membership is revoked', async () => {
    const m = await member();
    const issued = await issuedBy(m.authority, m.user.id);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      m.membershipId,
    ]);
    expect(await send(issued.outboxId)).toBe(0);
    expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'ACTOR_REVOKED',
    });
  });

  it('is refused after the initiator user is disabled, without a separate cancel', async () => {
    const m = await member();
    const issued = await issuedBy(m.authority, m.user.id);
    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [m.user.id]);
    // The grant's run-time actor check refuses the provider marker: nothing is sent.
    expect(await send(issued.outboxId)).toBe(0);
    expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'ACTOR_REVOKED',
    });
    // Re-enabling the user does not bring the cancelled mail back.
    await run(kit.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [m.user.id]);
    expect(await send(issued.outboxId)).toBe(0);
  });

  it('does not revive after the initiator is disabled and re-enabled before the job runs', async () => {
    const m = await member();
    const issued = await issuedBy(m.authority, m.user.id);
    await run(kit.env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [m.user.id]);
    await run(kit.env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [m.user.id]);
    expect(await send(issued.outboxId)).toBe(0);
    expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'ACTOR_REVOKED',
    });
  });

  it('is refused after the org is suspended, and stays refused after reactivation', async () => {
    const m = await member();
    const issued = await issuedBy(m.authority, m.user.id);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    expect(await send(issued.outboxId)).toBe(0);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    expect(await send(issued.outboxId)).toBe(0);
    expect(await getOutbox(kit.env.DB, issued.outboxId)).toMatchObject({ state: 'cancelled' });
  });

  it('is refused after a holder transfer and after quarantine', async () => {
    const a = await member();
    const transferred = await issuedBy(a.authority, a.user.id);
    await reassignHolder(
      jobCtxOf(kit),
      system,
      { passId: transferred.pass.id, email: email() },
      null,
    );
    expect(await send(transferred.outboxId)).toBe(0);
    expect((await getOutbox(kit.env.DB, transferred.outboxId))?.state).toBe('cancelled');

    const b = await member();
    const quarantined = await issuedBy(b.authority, b.user.id);
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [
      quarantined.pass.id,
    ]);
    expect(await send(quarantined.outboxId)).toBe(0);
    expect(await getOutbox(kit.env.DB, quarantined.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
  });
});

describe('manual email carries its actor to the send', () => {
  it('survives sign-out but not a revoked API key', async () => {
    const m = await member();
    const pass = await kit.pass({ holderEmail: email() });
    const queued = await enqueuePassEmail(kit.ctx, {
      passId: pass.id,
      to: email(),
      attach: false,
      expected: pass,
      authority: m.authority,
    });
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      kit.clock.now(),
      m.sessionId,
    ]);
    expect(await send(queued.outboxId)).toBe(1);

    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const keyAuthority: TenantPassWrite = {
      kind: 'api_key',
      orgId: kit.org.id,
      orgUpdatedAt: m.authority.orgUpdatedAt,
      keyId: key.id,
      keyOrgId: kit.org.id,
      scopes: ['passes:write'],
      scope: 'passes:write',
      mode: 'live',
    };
    const other = await kit.pass({ holderEmail: email() });
    const byKey = await enqueuePassEmail(kit.ctx, {
      passId: other.id,
      to: email(),
      attach: false,
      expected: other,
      authority: keyAuthority,
    });
    await run(kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      key.id,
    ]);
    expect(await send(byKey.outboxId)).toBe(0);
    expect(await getOutbox(kit.env.DB, byKey.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'ACTOR_REVOKED',
    });
    await sweepDelivery(job());
  });
});

describe('issuance queued by the pre-cutover Worker', () => {
  /** A pending issuance whose captured authority carries `orgs.updated_at` in ms, as 0024-era rows do. */
  async function legacyPending() {
    const m = await member();
    const release = kit.liveRelease ?? (await approveAppleRelease(kit));
    const create = (sendEmail: boolean) =>
      createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId: kit.template.id,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        input: { memberName: 'Legacy holder' },
        holderEmail: email(),
        ...(sendEmail ? { sendEmail } : {}),
        source: 'manual',
        mode: 'live',
        execution: { kind: 'system' },
        actor: system,
      });
    // Create now commits the intent with the pass, so the pre-cutover shape is inserted directly: a
    // pending row for a pass created without mail, with the captured authority of a 0024-era row.
    const reference = await first<{ context: string }>(
      kit.env.DB,
      'SELECT context FROM pass_issuance_deliveries WHERE pass_id = ?',
      [(await create(true)).id],
    );
    const pass = await create(false);
    const context = JSON.parse(reference?.context ?? '{}');
    context.execution = {
      kind: 'tenant',
      authority: { ...m.authority, orgUpdatedAt: 1_760_000_000_000 },
    };
    await run(
      kit.env.DB,
      `INSERT INTO pass_issuance_deliveries
         (pass_id, org_id, mode, recipient, identity_id, source_owner_user_id, source_generation,
          source_lifecycle_generation, source_link_generation, source_object_key, template_id, context,
          state, created_at)
       SELECT p.id, p.org_id, p.mode, p.holder_email, p.identity_id, p.owner_user_id,
         p.credential_generation, p.lifecycle_generation, p.link_generation, p.object_key,
         p.template_id, ?, 'pending', ?
       FROM passes p WHERE p.id = ?`,
      [JSON.stringify(context), kit.clock.now(), pass.id],
    );
    return pass;
  }

  it('sends after cutover while the org is active', async () => {
    const pass = await legacyPending();
    expect(await scheduleIssuanceDelivery(job(), pass.id)).toBe('queued');
    const queued = await first<{ outbox_id: string }>(
      kit.env.DB,
      'SELECT outbox_id FROM pass_issuance_deliveries WHERE pass_id = ?',
      [pass.id],
    );
    expect(await send(queued?.outbox_id ?? '')).toBe(1);
  });

  it('is refused when the org is suspended', async () => {
    const pass = await legacyPending();
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
    try {
      expect(await scheduleIssuanceDelivery(job(), pass.id)).toBe('cancelled');
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
    }
  });
});

describe('content refresh does not cancel mail (authority-epochs F12)', () => {
  it('sends the current artifact after a publish, and accepts an older producer snapshot', async () => {
    const pass = await kit.pass({ holderEmail: email() });
    const queued = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: pass.holderEmail ?? email(),
      attach: true,
      expected: pass,
    });
    const published = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: system,
      mutate: () => ({ personalization: { memberName: 'Refreshed Holder' } }),
    });
    expect(published.pass.version).toBeGreaterThan(pass.version);
    expect(await send(queued.outboxId)).toBe(1);
    const object = await kit.env.BUCKET.get(published.pass.objectKey);
    expect(kit.mailer.sent.at(-1)?.attachments?.[0]?.content).toEqual(
      new Uint8Array(await (object as R2ObjectBody).arrayBuffer()),
    );
    // The producer read the pass before the publish: its version is behind, its authority is not.
    await expect(
      enqueuePassEmail(job(), {
        passId: pass.id,
        to: pass.holderEmail ?? email(),
        attach: false,
        expected: pass,
      }),
    ).resolves.toHaveProperty('outboxId');
  });
});
