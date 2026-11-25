import { describe, expect, it, vi } from 'vitest';
import { guideApi, snippetBody } from './guide-api.ts';
import { kit } from './snippet-world.ts';

vi.mock('@passbook/sdk', () => import('../../sdk/typescript/src/index.ts'));

/** The claims of the check-in guide: a sandbox key scans as its own Test terminal, and nothing else. */
describe('check in at the door', () => {
  it('resolves, admits once and undoes with the sandbox key as the sandbox terminal', async () => {
    const { call, world } = await guideApi();
    const ids = (await kit()).f.ids;
    const v7 = () => ids.id();
    const mode = await call('GET', '/api-keys/me');
    expect(mode.json.scopes).not.toContain('scans:write');

    // A pass that is valid now: the sample ticket starts in 2030, which the door reports as not yet valid.
    const hour = 3_600_000;
    const iso = (h: number) =>
      new Date(world.clock.now() + h * hour).toISOString().replace('Z', '+00:00');
    const body = snippetBody('create-order-pass') as { input: object };
    const made = await call('POST', '/passes', {
      ...body,
      externalId: 'door-1',
      input: { ...body.input, startsAt: iso(-1), endsAt: iso(2) },
    });
    expect(made.status, made.text).toBe(201);
    const rules = await call(
      'PUT',
      `/passes/${made.json.id}/check-in`,
      snippetBody('check-in-rules'),
    );
    expect(rules.status).toBe(200);

    const device = { 'x-passbook-device': 'sandbox' };
    const read = (n: number) => ({
      idempotencyKey: v7(),
      input: { passId: made.json.id, method: 'manual' },
      clientTs: world.clock.now() + n,
    });
    const seen = await call('POST', '/scan/resolve', read(0), device);
    expect(seen.status, seen.text).toBe(200);
    const admitted = await call('POST', '/scan/actions', { ...read(1), actionId: 'auto' }, device);
    expect(admitted.json.kind).toBe('ok');
    // single: a second scan is not an admit.
    const again = await call('POST', '/scan/actions', { ...read(2), actionId: 'auto' }, device);
    expect(again.json.kind).not.toBe('ok');
    const undone = await call(
      'POST',
      `/scan/scans/${admitted.json.scanId}/undo`,
      { idempotencyKey: v7() },
      device,
    );
    expect(undone.status).toBe(200);
  });

  it('refuses a missing terminal, another terminal id and a key of an ordinary org', async () => {
    const { call, world } = await guideApi();
    const ids = (await kit()).f.ids;
    const v7 = () => ids.id();
    const body = {
      idempotencyKey: v7(),
      input: { code: 'x', method: 'manual' },
      clientTs: 1,
    };
    const none = await call('POST', '/scan/resolve', body);
    expect([none.status, none.json.code]).toEqual([422, 'DEVICE_REQUIRED']);
    const stranger = await call('POST', '/scan/resolve', body, {
      'x-passbook-device': '0193a1b2-7c00-7000-8000-0000000000e1',
    });
    expect([stranger.status, stranger.json.code]).toEqual([404, 'TERMINAL_NOT_FOUND']);

    const plain = await guideApi({ sandbox: false });
    expect(plain.world.terminalId).toBeNull();
    // The alias names the sandbox terminal for a sandbox key only; the id is no way in for another org's key.
    for (const device of ['sandbox', world.terminalId ?? '']) {
      const refused = await plain.call('POST', '/scan/resolve', body, {
        'x-passbook-device': device,
      });
      expect([refused.status, refused.json.code]).toEqual([404, 'TERMINAL_NOT_FOUND']);
    }
  });
});
