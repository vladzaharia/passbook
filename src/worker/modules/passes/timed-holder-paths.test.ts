import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { createBundle } from '../bundles/service.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { enqueuePassEmail } from '../delivery/issuance-intent.ts';
import { handleEmailSend } from '../delivery/jobs.ts';
import { myPassesBundle } from '../me/bundle.ts';
import {
  inboxApp,
  inboxHeaders,
  inboxMember,
  scopedInboxPath,
} from '../sandbox/test-tenant-fixtures.ts';
import { passJsonIn, stampRender } from './event-boundaries-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

const ORIGIN = 'https://wallet.test';
// A render's timed key no build of this template writes: it shows the file went through the render.
const RENDERED = { relevantDate: '2031-02-03T04:05:06Z' };
const system = { type: 'system', id: null } as const;

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
  kit.env.RL_REFRESH = fakeLimiter(1000) as unknown as RateLimit;
});

/** A pass of the kit's template, rendered at an event boundary. */
async function rendered(input: { holderEmail?: string; mode?: 'live' | 'test' } = {}) {
  const pass = await kit.pass(input);
  await stampRender(kit.env, kit.clock, pass.id, RENDERED);
  return (await getPass(kit.env.DB, pass.id)) ?? pass;
}
const bytesOf = async (body: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(body).arrayBuffer());

// Every path that hands a holder a .pkpass gives the current render (docs/design/event-boundaries.md).
describe('holder files after an event boundary', () => {
  it('portal Add all bundles the render, with no stale size', async () => {
    const email = 'portal-holder@example.com';
    const user = await makeUser(kit.fx, { primaryEmail: email });
    const pass = await rendered({ holderEmail: email });
    // A first owner attaches without a transfer when the holder email is theirs.
    await run(kit.env.DB, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [user.id, pass.id]);
    const { body } = await myPassesBundle(kit.ctx, user.id, 1);
    expect(passJsonIn(await bytesOf(body), pass.id).relevantDate).toBe(RENDERED.relevantDate);
  });

  it('the bundle link Add all serves the render', async () => {
    const pass = await rendered({ holderEmail: 'bundle-holder@example.com' });
    const bundle = await createBundle(
      jobCtxOf(kit),
      system,
      'live',
      {
        orgId: kit.org.id,
        passIds: [pass.id],
        name: 'Season',
        holderEmail: 'bundle-holder@example.com',
      },
      { kind: 'system' },
    );
    const app = createApp({ stores: fakeAuth(ORIGIN).stores, clock: kit.clock });
    const token = bundle.url?.split('/b/')[1] ?? '';
    const res = await app.request(`${ORIGIN}/b/${token}/passes.pkpasses`, {}, kit.env);
    expect(res.status, await res.clone().text()).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(passJsonIn(bytes, pass.id).relevantDate).toBe(RENDERED.relevantDate);
  });

  it('the pass email attaches the render', async () => {
    const pass = await rendered({ holderEmail: 'mail-holder@example.com' });
    const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
      passId: pass.id,
      to: 'mail-holder@example.com',
      attach: true,
      expected: pass,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
    const content = kit.mailer.sent.at(-1)?.attachments?.[0]?.content;
    expect(content).toBeDefined();
    expect(passJsonIn(content ?? new Uint8Array()).relevantDate).toBe(RENDERED.relevantDate);
  });

  it('a test inbox forward attaches the render made after the capture', async () => {
    const actorId = 'timed-forward-admin';
    await makeUser(kit.fx, { id: actorId, primaryEmail: 'timed-forward@example.com' });
    const { session } = await inboxMember(kit, actorId, kit.org.id, 'org_admin', ['admin', 'user']);
    const to = 'timed-test-holder@example.com';
    const pass = await kit.pass({ mode: 'test', holderEmail: to });
    const { outboxId } = await enqueuePassEmail(jobCtxOf(kit), {
      passId: pass.id,
      to,
      attach: true,
      expected: pass,
    });
    await handleEmailSend({ kind: 'email.send', outboxId }, jobCtxOf(kit));
    const capture = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM captured_emails WHERE outbox_id = ?',
      [outboxId],
    );
    await stampRender(kit.env, kit.clock, pass.id, RENDERED);
    const path = scopedInboxPath(`/test-inbox/${capture?.id}/send-to-me`, kit.org.id);
    const res = await inboxApp(kit).request(
      `${ORIGIN}/api/v1${path}`,
      { method: 'POST', headers: inboxHeaders(session) },
      kit.env,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const content = kit.mailer.sent.at(-1)?.attachments?.[0]?.content;
    expect(passJsonIn(content ?? new Uint8Array()).relevantDate).toBe(RENDERED.relevantDate);
  });
});
