import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../../sdk/typescript/src/index.ts';
import { fence, guideApi, snippetBody } from './guide-api.ts';

/** The sandbox claims of the door, events, go-live and bulk guides, each proven by the API. */
describe('check in at the door', () => {
  it('sets and reads the rules, finds the code in the pass detail, and has no till scope in a sandbox', async () => {
    const { call, makePass } = await guideApi();
    const pass = await makePass('door-1');
    const rules = snippetBody('check-in-rules');
    expect((await call('PUT', `/passes/${pass.id}/check-in`, rules)).status).toBe(200);
    const read = await call('GET', `/passes/${pass.id}/check-in`);
    expect(read.json.rules.mode).toBe('single');

    const detail = await call('GET', `/passes/${pass.id}`);
    const code = detail.json.passJson.barcodes[0].message as string;
    expect(code.length).toBeGreaterThan(5);

    const till = {
      idempotencyKey: '0193a1b2-7c00-7000-8000-0000000000f1',
      input: { code, method: 'camera' },
      clientTs: Date.now(),
    };
    const bare = await call('POST', '/scan/resolve', till);
    expect([bare.status, bare.json.code]).toEqual([403, 'MISSING_SCOPE']);
    const act = await call(
      'POST',
      '/scan/actions',
      { ...till, actionId: 'auto' },
      { 'x-passbook-device': 'door-1' },
    );
    expect([act.status, act.json.code]).toEqual([403, 'MISSING_SCOPE']);
  });
});

describe('react to events and go live', () => {
  it('shows the secret once, captures a signed test event that verifies, replays it, and signs twice while a rotation overlaps', async () => {
    const { call } = await guideApi();
    const made = await call(
      'POST',
      '/webhook-endpoints/capture',
      fence('react-to-events', 'webhooks.postWebhookEndpointsCapture'),
    );
    expect(made.status).toBe(201);
    const secret = made.json.secret as string;
    expect(typeof secret).toBe('string');
    const id = made.json.endpoint.id as string;
    const later = await call('POST', '/webhook-endpoints/capture', { eventTypes: ['pass.issued'] });
    expect(later.json.secret).toBeNull();
    expect(later.json.endpoint.id).toBe(id);

    const test = await call(
      'POST',
      `/webhook-endpoints/${id}/test`,
      fence('react-to-events', 'webhooks.postWebhookEndpointsByIdTest'),
    );
    expect(test.status).toBe(200);
    expect(test.json.ok).toBe(true);
    const captureId = test.json.captureId as string;
    const list = await call('GET', `/webhook-endpoints/${id}/captures`);
    expect(list.json.items.map((c: { id: string }) => c.id)).toContain(captureId);

    const capture = await call('GET', `/webhook-endpoints/${id}/captures/${captureId}`);
    const raw = capture.json.body as string;
    const headers = new Headers(capture.json.headers as Record<string, string>);
    // The test's clock is not the wall clock: verify at the request's own timestamp.
    const sentAt = Number(headers.get('x-passbook-timestamp'));
    const event = await verifyWebhook(raw, headers, secret, { now: sentAt });
    expect(event.type).toBe('pass.issued');
    expect(
      (await call('POST', `/webhook-endpoints/${id}/captures/${captureId}/replay`)).status,
    ).toBeLessThan(300);

    // Go live: rotate with the guide's overlap, and the next request carries one v1= per live secret.
    const rotated = await call(
      'POST',
      `/webhook-endpoints/${id}/secret`,
      fence('go-live', 'webhooks.postWebhookEndpointsByIdSecret'),
    );
    expect(rotated.status).toBe(200);
    expect(rotated.json.secret).not.toBe(secret);
    const second = await call('POST', `/webhook-endpoints/${id}/test`, { type: 'pass.voided' });
    const after = await call('GET', `/webhook-endpoints/${id}/captures/${second.json.captureId}`);
    const signature = (after.json.headers as Record<string, string>)['x-passbook-signature'] ?? '';
    expect(signature.match(/v1=/g)).toHaveLength(2);

    const feed = await call('GET', '/events');
    expect(feed.status).toBe(200);
    expect(Array.isArray(feed.json.items)).toBe(true);
  });
});

describe('bulk import', () => {
  it('checks five rows, starts the commit, and refuses more than 100 passes in a bulk call', async () => {
    const { call, makePass } = await guideApi();
    const made = await call(
      'POST',
      '/pass-imports',
      fence('bulk-import', 'pass-imports.postPassImports'),
    );
    expect(made.status).toBe(201);
    const checked = await call(
      'POST',
      `/pass-imports/${made.json.id}/check`,
      fence('bulk-import', 'pass-imports.postPassImportsByIdCheck'),
    );
    expect(checked.status).toBeLessThan(300);
    expect(JSON.stringify(checked.json)).toContain('"create":5');
    const commit = await call(
      'POST',
      `/pass-imports/${made.json.id}/commit`,
      fence('bulk-import', 'pass-imports.postPassImportsByIdCommit'),
    );
    expect(commit.status).toBeLessThan(300);
    const state = await call('GET', `/pass-imports/${made.json.id}`);
    expect(state.json.state).toBe('done');

    const pass = await makePass('bulk-1');
    const ok = await call('POST', '/passes/bulk', { action: 'void', ids: [pass.id] });
    expect(ok.status).toBe(200);
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    const over = await call('POST', '/passes/bulk', { action: 'void', ids });
    expect(over.status).toBe(422);
  });
});
