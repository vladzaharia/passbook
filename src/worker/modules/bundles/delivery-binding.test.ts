import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { beginAttemptFor, checksHold, jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { failEmail } from '../delivery/email-outcome.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend, sweepDelivery } from '../delivery/jobs.ts';
import { getOutbox } from '../delivery/repo.ts';
import { claimOutbox } from '../delivery/repo-outbox-processing.ts';
import { reassignHolder } from '../holders/service.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { beginBundleAttemptFor } from './bundle-test-fixtures.ts';
import { bundleEmailSnapshot } from './email-binding.ts';
import { enqueueBundleEmail } from './email-queue.ts';
import {
  addablePass,
  assertBundleMember,
  bundleArchive,
  bundleForToken,
  bundleMembers,
  bundlePass,
} from './public-service.ts';
import { getBundle, getBundleByToken, membersOf } from './repo.ts';
import { bundleChecks } from './repo-delivery-fence.ts';
import { bundleMutationGrant, createBundleGrant } from './repo-writes.ts';
import { createBundle, rotateBundleLink } from './service.ts';

const job = () => jobCtxOf(kit);

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
const actor = { type: 'system', id: null } as const;
const tokenOf = (url: string) => url.split('/b/')[1] ?? '';

async function bundle(passIds: string[], email: string) {
  return createBundle(
    job(),
    actor,
    'live',
    {
      orgId: kit.org.id,
      passIds,
      name: 'Original bundle',
      holderEmail: email,
    },
    { kind: 'system' },
  );
}

async function enqueue(id: string, token: string, to: string) {
  return enqueueBundleEmail(job(), id, to, { token, holderEmail: to });
}

describe('durable bundle email intent', () => {
  it('binds the complete ordered bundle snapshot and rejects malformed snapshots', async () => {
    const pass = await kit.pass({ holderEmail: 'snapshot-holder@example.test' });
    const second = await kit.pass();
    const original = await bundle([pass.id, second.id], 'snapshot-holder@example.test');
    const snapshot = await bundleEmailSnapshot(kit.env.DB, original.id);
    if (!snapshot) throw new Error('bundle missing');
    const holds = (s: typeof snapshot) =>
      checksHold(job(), { orgId: pass.orgId, mode: pass.mode, checks: bundleChecks(s) });
    expect(await holds(snapshot)).toBe(true);
    for (const malformed of [
      undefined as never,
      { ...snapshot, passes: [], positions: [] },
      { ...snapshot, positions: [0, 0] },
      { ...snapshot, bundle: { ...snapshot.bundle, token: '' } },
      {
        ...snapshot,
        passes: snapshot.passes.map((item, index) =>
          index === 0 ? { ...item, testDataQuarantined: true } : item,
        ),
      },
      {
        ...snapshot,
        passes: snapshot.passes.map((item, index) =>
          index === 0 ? { ...item, deletedAt: kit.clock.now() } : item,
        ),
      },
    ]) {
      expect(await holds(malformed)).toBe(false);
    }
    await reassignHolder(
      jobCtxOf(kit),
      actor,
      { passId: pass.id, email: 'next-holder@example.test' },
      null,
    );
    expect(await holds(snapshot)).toBe(false);
  });

  it('rejects a captured bundle snapshot when its organization is suspended', async () => {
    const org = await makeOrg(kit.fx);
    const pass = await kit.pass({ orgId: org.id });
    const original = await createBundle(
      job(),
      actor,
      'live',
      {
        orgId: org.id,
        passIds: [pass.id],
        name: 'Suspended bundle',
      },
      { kind: 'system' },
    );
    const snapshot = await bundleEmailSnapshot(kit.env.DB, original.id);
    if (!snapshot) throw new Error('bundle missing');
    const holds = () =>
      checksHold(job(), { orgId: org.id, mode: 'live', checks: bundleChecks(snapshot) });
    expect(await holds()).toBe(true);
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    expect(await holds()).toBe(false);
  });

  it('removes a transferred pass from old bundle links and cancels their queued email', async () => {
    const pass = await kit.pass({ holderEmail: 'bundle-old@example.com' });
    const other = await kit.pass({ holderEmail: 'bundle-old@example.com' });
    const original = await bundle([pass.id, other.id], 'bundle-old@example.com');
    const originalToken = tokenOf(original.url);
    const old = await enqueue(original.id, originalToken, 'bundle-old@example.com');
    await reassignHolder(
      jobCtxOf(kit),
      actor,
      { passId: pass.id, email: 'bundle-new@example.com' },
      null,
    );
    const replacement = (
      await publishPass(jobCtxOf(kit), {
        passId: pass.id,
        cause: 'admin',
        actor,
        mutate: () => ({ personalization: { memberName: 'Bundle replacement' } }),
      })
    ).pass;
    const oldBundle = await bundleForToken(jobCtxOf(kit), originalToken);
    expect((await membersOf(kit.env.DB, [original.id])).map((item) => item.pass_id)).toEqual([
      other.id,
    ]);
    await expect(addablePass(jobCtxOf(kit), oldBundle, pass.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await bundleMembers(jobCtxOf(kit), oldBundle)).map((item) => item.pass.id)).toEqual([
      other.id,
    ]);
    const before = kit.mailer.sent.length;
    await handleEmailSend({ kind: 'email.send', outboxId: old.outboxId }, job());
    expect(kit.mailer.sent).toHaveLength(before);
    expect(await getOutbox(kit.env.DB, old.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
    const nextBundle = await bundle([replacement.id], 'bundle-new@example.com');
    const nextToken = tokenOf(nextBundle.url);
    const next = await enqueue(nextBundle.id, nextToken, 'bundle-new@example.com');
    await handleEmailSend({ kind: 'email.send', outboxId: next.outboxId }, job());
    const sent = kit.mailer.sent.at(-1);
    expect(kit.mailer.sent).toHaveLength(before + 1);
    expect(sent?.to).toBe('bundle-new@example.com');
    expect(sent?.html).toContain(`/b/${nextToken}/${replacement.id}/pass.pkpass`);
    expect(sent?.html).not.toContain(originalToken);
  });

  it('does not adopt a replacement bundle token on first send or retry', async () => {
    const pass = await kit.pass();
    const original = await bundle([pass.id], 'bundle-rotate@example.com');
    const token = tokenOf(original.url);
    const first = await enqueue(original.id, token, 'bundle-rotate@example.com');
    const retry = await enqueue(original.id, token, 'bundle-rotate@example.com');
    const lease = kit.ctx.ids.token(8);
    const claimed = await claimOutbox(kit.env.DB, retry.outboxId, lease, kit.clock.now(), 60_000);
    if (!claimed) throw new Error('outbox claim failed');
    await expect(
      failEmail(
        jobCtxOf(kit),
        { row: claimed, lease },
        {
          orgId: pass.orgId,
          passId: pass.id,
          mode: pass.mode,
          templateId: null,
          identityId: null,
          bundleId: original.id,
        },
        new Error('pre-provider storage unavailable'),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_FAILED' });
    const authorizedBeforeRotation = await getBundleByToken(kit.env.DB, token);
    expect(authorizedBeforeRotation).not.toBeNull();
    await rotateBundleLink(job(), actor, original.id, null, { kind: 'system' });
    const before = kit.mailer.sent.length;
    for (const row of [first, retry]) {
      await handleEmailSend({ kind: 'email.send', outboxId: row.outboxId }, job());
      expect(await getOutbox(kit.env.DB, row.outboxId)).toMatchObject({
        state: 'cancelled',
        errorCode: 'DELIVERY_STALE',
      });
    }
    expect(kit.mailer.sent).toHaveLength(before);
    await expect(bundleArchive(jobCtxOf(kit), authorizedBeforeRotation!)).rejects.toMatchObject({
      code: 'BUNDLE_EMPTY',
    });
    await expect(enqueue(original.id, token, 'bundle-rotate@example.com')).rejects.toMatchObject({
      code: 'DELIVERY_STALE',
    });
  });

  it('cancels if a member changes while the email is being rendered', async () => {
    const pass = await kit.pass({ holderEmail: 'bundle-during-old@example.com' });
    const original = await bundle([pass.id], 'bundle-during-old@example.com');
    const queued = await enqueue(
      original.id,
      tokenOf(original.url),
      'bundle-during-old@example.com',
    );
    const resolve = kit.registry.resolve.bind(kit.registry);
    const spy = vi.spyOn(kit.registry, 'resolve').mockImplementationOnce(async (...args) => {
      await reassignHolder(
        jobCtxOf(kit),
        actor,
        { passId: pass.id, email: 'bundle-during-new@example.com' },
        null,
      );
      return resolve(...args);
    });
    const before = kit.mailer.sent.length;
    try {
      await handleEmailSend({ kind: 'email.send', outboxId: queued.outboxId }, job());
    } finally {
      spy.mockRestore();
    }
    expect(kit.mailer.sent).toHaveLength(before);
    expect(await getOutbox(kit.env.DB, queued.outboxId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'DELIVERY_STALE',
    });
  });

  it('fences an in-flight bundle page and asset read against a member transfer', async () => {
    const pass = await kit.pass({ holderEmail: 'bundle-page-old@example.com' });
    const other = await kit.pass();
    const original = await bundle([pass.id, other.id], 'bundle-page-old@example.com');
    const authorized = await bundleForToken(jobCtxOf(kit), tokenOf(original.url));
    const assetPass = await bundlePass(jobCtxOf(kit), authorized, pass.id);
    const resolve = kit.registry.resolve.bind(kit.registry);
    const spy = vi.spyOn(kit.registry, 'resolve').mockImplementationOnce(async (...args) => {
      await reassignHolder(
        jobCtxOf(kit),
        actor,
        { passId: pass.id, email: 'bundle-page-new@example.com' },
        null,
      );
      return resolve(...args);
    });
    try {
      await expect(bundleMembers(jobCtxOf(kit), authorized)).rejects.toMatchObject({ status: 404 });
    } finally {
      spy.mockRestore();
    }
    await expect(assertBundleMember(jobCtxOf(kit), authorized, assetPass)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('will not cross the provider boundary using a stale bundle snapshot', async () => {
    const pass = await kit.pass({ holderEmail: 'bundle-fence-old@example.com' });
    const original = await bundle([pass.id], 'bundle-fence-old@example.com');
    const queued = await enqueue(
      original.id,
      tokenOf(original.url),
      'bundle-fence-old@example.com',
    );
    const snapshot = await bundleEmailSnapshot(kit.env.DB, original.id);
    if (!snapshot) throw new Error('bundle missing');
    const lease = kit.ctx.ids.token(8);
    expect(
      await claimOutbox(kit.env.DB, queued.outboxId, lease, kit.clock.now(), 60_000),
    ).not.toBeNull();
    await reassignHolder(
      jobCtxOf(kit),
      actor,
      { passId: pass.id, email: 'bundle-fence-new@example.com' },
      null,
    );
    expect(
      await beginBundleAttemptFor(job(), queued.outboxId, lease, snapshot, kit.clock.now()),
    ).toBe(false);
  });

  it('quarantines both pass and bundle delivery and refuses stale provider commits', async () => {
    const email = 'quarantined-bundle@example.com';
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: kit.template.version,
      mode: 'test',
      source: 'manual',
      actor,
      execution: { kind: 'system' },
      input: { memberName: 'Quarantined' },
      holderEmail: email,
    });
    const original = await createBundle(
      job(),
      actor,
      'test',
      {
        orgId: pass.orgId,
        passIds: [pass.id],
        name: 'Test bundle',
        holderEmail: email,
      },
      { kind: 'system' },
    );
    const token = tokenOf(original.url);
    const passRow = await enqueuePassEmail(job(), {
      passId: pass.id,
      to: email,
      attach: false,
      expected: pass,
    });
    const bundleRow = await enqueue(original.id, token, email);
    const snapshot = await bundleEmailSnapshot(kit.env.DB, original.id);
    if (!snapshot) throw new Error('bundle missing');
    const passLease = kit.ctx.ids.token(8);
    const bundleLease = kit.ctx.ids.token(8);
    expect(
      await claimOutbox(kit.env.DB, passRow.outboxId, passLease, kit.clock.now(), 1000),
    ).not.toBeNull();
    expect(
      await claimOutbox(kit.env.DB, bundleRow.outboxId, bundleLease, kit.clock.now(), 1000),
    ).not.toBeNull();
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    expect(await beginAttemptFor(job(), passRow.outboxId, passLease, kit.clock.now())).toBe(false);
    expect(
      await beginBundleAttemptFor(
        job(),
        bundleRow.outboxId,
        bundleLease,
        snapshot,
        kit.clock.now(),
      ),
    ).toBe(false);
    await expect(bundleForToken(jobCtxOf(kit), token)).rejects.toMatchObject({ status: 404 });
    expect(await getBundle(kit.env.DB, original.id, null)).toBeNull();
    await expect(
      bundleMutationGrant(job(), {
        id: original.id,
        orgId: pass.orgId,
        mode: 'test',
        authority: undefined,
        actor,
        action: 'rotate_link',
        token: kit.ctx.ids.token(),
      }).commit(),
    ).rejects.toThrow();
    expect(
      (
        await first<{ token: string }>(kit.env.DB, 'SELECT token FROM bundles WHERE id = ?', [
          original.id,
        ])
      )?.token,
    ).toBe(token);
    kit.clock.advance(1001);
    await sweepDelivery(job());
    for (const row of [passRow, bundleRow]) {
      await handleEmailSend({ kind: 'email.send', outboxId: row.outboxId }, job());
      expect(await getOutbox(kit.env.DB, row.outboxId)).toMatchObject({
        state: 'cancelled',
        errorCode: 'DELIVERY_STALE',
      });
      expect(
        await first(kit.env.DB, 'SELECT id FROM captured_emails WHERE outbox_id = ?', [
          row.outboxId,
        ]),
      ).toBeNull();
    }
  });

  it('does not insert a stale bundle membership after transfer commits', async () => {
    const pass = await kit.pass({ holderEmail: 'bundle-race-old@example.com' });
    const id = kit.ctx.ids.id();
    const pending = createBundleGrant(
      job(),
      {
        id,
        orgId: pass.orgId,
        mode: pass.mode,
        name: 'Delayed',
        token: kit.ctx.ids.token(),
        holderEmail: pass.holderEmail,
        actor,
        passes: [pass],
        now: kit.clock.now(),
      },
      undefined,
      {},
    );
    await reassignHolder(
      jobCtxOf(kit),
      actor,
      { passId: pass.id, email: 'bundle-race-new@example.com' },
      null,
    );
    await expect(pending.commit()).rejects.toThrow();
    expect(await getBundle(kit.env.DB, id, null)).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM bundle_passes WHERE bundle_id = ?', [id]),
    ).toBeNull();
    expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe('bundle-race-new@example.com');
  });
});
