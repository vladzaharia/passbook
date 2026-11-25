import { describe, expect, it, vi } from 'vitest';
import { guideApi, snippetBody } from './guide-api.ts';
import { kit } from './snippet-world.ts';

vi.mock('@passbook/sdk', () => import('../../sdk/typescript/src/index.ts'));

/** The claims of the check-in guide: a sandbox key scans as its own Test terminal, and nothing else. */
describe('check in at the door', () => {
  it('follows the guide: heads-up before the ticket opens, then admit, a second scan refused, undo', async () => {
    const { call, makePass } = await guideApi();
    const ids = (await kit()).f.ids;
    const mode = await call('GET', '/api-keys/me');
    expect(mode.json.scopes).not.toContain('scans:write');

    // The guide's own pass: its ticket starts in 2030.
    const pass = await makePass('door-1');
    const device = { 'x-passbook-device': 'sandbox' };
    // The curl bodies of the guide, each with a key of its own and this pass.
    const scan = (step: string) => ({
      ...snippetBody(step),
      idempotencyKey: ids.id(),
      input: { passId: pass.id, method: 'manual' },
    });

    const early = await call('POST', '/scan/resolve', scan('door-resolve'), device);
    expect([early.status, early.json.kind, early.json.reason]).toEqual([
      200,
      'heads_up',
      'not_yet_valid',
    ]);

    const rules = await call('PUT', `/passes/${pass.id}/check-in`, snippetBody('check-in-rules'));
    expect(rules.status, rules.text).toBe(200);

    const admitted = await call('POST', '/scan/actions', scan('door-check-in'), device);
    expect([admitted.status, admitted.json.kind]).toEqual([200, 'ok']);
    expect(admitted.json.undoUntil).toBeGreaterThan(0);
    const again = await call('POST', '/scan/actions', scan('door-again'), device);
    expect([again.json.kind, again.json.reason]).toEqual(['heads_up', 'already_done']);

    // A refused scan has nothing to undo; the admit does.
    const refusedUndo = await call(
      'POST',
      `/scan/scans/${again.json.scanId}/undo`,
      { idempotencyKey: ids.id() },
      device,
    );
    expect([refusedUndo.status, refusedUndo.json.code]).toEqual([404, 'SCAN_NOT_FOUND']);
    const undone = await call(
      'POST',
      `/scan/scans/${admitted.json.scanId}/undo`,
      { idempotencyKey: ids.id() },
      device,
    );
    expect(undone.status).toBe(200);
    const after = await call('POST', '/scan/actions', scan('door-check-in'), device);
    expect(after.json.kind).toBe('ok');
  });

  // `uuidgen` makes a v4, which the guide warns about.
  it('refuses a v4 idempotencyKey', async () => {
    const { call, makePass } = await guideApi();
    const pass = await makePass('door-v4');
    const refused = await call(
      'POST',
      '/scan/resolve',
      {
        idempotencyKey: crypto.randomUUID(),
        input: { passId: pass.id, method: 'manual' },
        clientTs: 1,
      },
      { 'x-passbook-device': 'sandbox' },
    );
    expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION']);
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
