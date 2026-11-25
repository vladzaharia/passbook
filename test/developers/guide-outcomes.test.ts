import { describe, expect, it, vi } from 'vitest';
import { handleEmailSend } from '../../src/worker/modules/delivery/jobs.ts';
import { all } from '../../src/worker/platform/db.ts';
import { createJobContext } from '../../src/worker/platform/service-context.ts';
import { guideApi, snippetBody } from './guide-api.ts';
import { kit } from './snippet-world.ts';

vi.mock('@passbook/sdk', () => import('../../sdk/typescript/src/index.ts'));

/** The sandbox claims the guides make (issue, update, lifecycle, test mode), each proven by the API. */
describe('issue on purchase', () => {
  it('replays an order to the same pass, refuses a changed body, finds it, emails it and ends at a preview', async () => {
    const { call, world } = await guideApi();
    const body = { ...snippetBody('create-order-pass') };
    const headers = { 'idempotency-key': 'order-8841' };
    const first = await call('POST', '/passes', body, headers);
    expect(first.status).toBe(201);
    expect(first.json.externalId).toBe('order-8841');
    expect(first.json.testPreview).toBe(true);
    expect(first.headers.get('idempotent-replayed')).toBeNull();

    const again = await call('POST', '/passes', body, headers);
    expect(again.json.id).toBe(first.json.id);
    expect(again.headers.get('idempotent-replayed')).toBe('true');

    const changed = await call(
      'POST',
      '/passes',
      { ...body, holderEmail: 'other@example.com' },
      headers,
    );
    expect(changed.status).toBe(422);
    expect(changed.json.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const found = await call('GET', '/passes?externalId=order-8841');
    expect(found.json.items.map((p: { id: string }) => p.id)).toEqual([first.json.id]);

    const mail = await call('POST', `/passes/${first.json.id}/resend-email`, {
      to: 'ada@example.com',
    });
    expect(mail.status).toBe(202);
    // The queue sends it; the test runs that job.
    const { env, clock } = await kit();
    const [queued] = await all<{ id: string }>(
      env.DB,
      "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [first.json.id],
    );
    await handleEmailSend(
      { kind: 'email.send', outboxId: queued?.id ?? '' },
      createJobContext(env, 'test', { clock }),
    );
    const inbox = await call('GET', '/test-inbox');
    expect(inbox.json.items.map((m: { to: string }) => m.to)).toContain('ada@example.com');

    const preview = await world.fetch(first.json.downloadUrl);
    expect(preview.status).toBe(200);
    expect(new URL(first.json.downloadUrl).pathname).toMatch(/^\/preview\//);
  });
});

describe('update a pass', () => {
  it('raises the version, refuses a stale If-Match, voids and unvoids, and logs the change', async () => {
    const { call, makePass } = await guideApi();
    const pass = await makePass('update-1');
    const changed = await call(
      'PATCH',
      `/passes/${pass.id}`,
      { input: { attendee: 'Ada Lovelace' }, notify: true },
      { 'if-match': String(pass.version) },
    );
    expect(changed.status).toBe(200);
    expect(changed.json.version).toBe(pass.version + 1);
    expect(changed.headers.get('etag')).toBe(`"${pass.version + 1}"`);

    const stale = await call(
      'PATCH',
      `/passes/${pass.id}`,
      { input: { attendee: 'Grace Host' } },
      { 'if-match': String(pass.version) },
    );
    expect(stale.status).toBe(412);
    expect(stale.json.code).toBe('VERSION_CONFLICT');

    expect((await call('POST', `/passes/${pass.id}/void`)).json.status).toBe('voided');
    expect((await call('POST', `/passes/${pass.id}/unvoid`)).json.status).toBe('active');

    const events = await call('GET', `/passes/${pass.id}/events`);
    expect(events.json.items.length).toBeGreaterThan(1);
    const detail = await call('GET', `/passes/${pass.id}`);
    expect(
      detail.json.passJson.generic?.primaryFields ?? detail.json.passJson.eventTicket,
    ).toBeDefined();
    expect(JSON.stringify(detail.json.passJson)).toContain('Ada Lovelace');
  });
});

describe('pass lifecycle', () => {
  it('moves a pass through void, remove, restore and delete as the table says, and rotates the links', async () => {
    const { call, makePass, world } = await guideApi();
    const pass = await makePass('life-1');

    expect((await call('POST', `/passes/${pass.id}/void`)).json.status).toBe('voided');
    expect((await call('POST', `/passes/${pass.id}/unvoid`)).json.status).toBe('active');

    const removed = await call('POST', `/passes/${pass.id}/remove`, { message: 'Refunded' });
    expect(removed.status).toBe(200);
    expect(removed.json.removedAt).not.toBeNull();
    // A removed pass reads voided: `removedAt` tells it from a void.
    expect(removed.json.status).toBe('voided');
    const voidRemoved = await call('POST', `/passes/${pass.id}/void`);
    expect(voidRemoved.json.code).toBe('PASS_REMOVED');
    const list = await call('GET', '/passes?status=removed');
    expect(list.json.items.map((p: { id: string }) => p.id)).toContain(pass.id);
    const restored = await call('POST', `/passes/${pass.id}/restore`);
    expect(restored.json.removedAt).toBeNull();

    const rotated = await call('POST', `/passes/${pass.id}/rotate-link`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.downloadUrl).not.toBe(pass.downloadUrl);
    expect((await world.fetch(pass.downloadUrl)).status).toBe(404);
    expect((await world.fetch(rotated.json.downloadUrl)).status).toBe(200);

    expect((await call('DELETE', `/passes/${pass.id}`)).status).toBeLessThan(300);
    const gone = await call('GET', `/passes/${pass.id}`);
    expect(gone.status).toBe(404);
    expect(gone.json.code).toBe('PASS_NOT_FOUND');
  });
});

describe('test mode', () => {
  it('names the key a test key, answers .pkpass with SANDBOX_PREVIEW_ONLY and stops a create at the plan limit', async () => {
    const { call, makePass, world } = await guideApi();
    const me = await call('GET', '/api-keys/me');
    expect(me.json.mode).toBe('test');

    const pass = await makePass('mode-1');
    expect(pass.testPreview).toBe(true);
    const token = new URL(pass.publicUrl).pathname.split('/').filter(Boolean).pop();
    const pkpass = await world.fetch(`https://passbook.mobile/p/${token}/pass.pkpass`);
    expect(pkpass.status).toBe(409);
    expect(((await pkpass.json()) as { code: string }).code).toBe('SANDBOX_PREVIEW_ONLY');

    // The plan allows 10 templates and the sandbox starts with one.
    let refused: Awaited<ReturnType<typeof call>> | undefined;
    for (let i = 0; i < 11 && !refused; i++) {
      const made = await call('POST', '/templates/baked:starter-event-ticket/use', {
        orgId: world.orgId,
        name: `Tickets ${i}`,
      });
      if (made.status >= 400) refused = made;
    }
    expect(refused?.status).toBe(403);
    expect(refused?.json.code).toBe('SANDBOX_QUOTA');
    expect(refused?.json).toMatchObject({ limit: 10, used: 10 });
    expect(refused?.json.feature).toBeDefined();
  }, 60_000);
});
