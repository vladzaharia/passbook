import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeRateLimiter, makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Notes', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
  });
});

const desk = () =>
  kit.scanner({ templateIds: [templateId], settings: { roleWithoutSignIn: 'desk' } });
const door = () =>
  kit.scanner({ templateIds: [templateId], settings: { roleWithoutSignIn: 'door' } });
const add = (passId: string, headers: Record<string, string>, body: unknown) =>
  kit.post(headers, `/passes/${passId}/notes`, body);
const noteBody = (text = 'Waiver unsigned. Ask at the desk.') => ({
  body: text,
  idempotencyKey: key(),
});
const count = async (passId: string) =>
  (await all(kit.env.DB, 'SELECT 1 FROM pass_notes WHERE pass_id = ?', [passId])).length;

describe('staff notes', () => {
  it('a Desk device adds a note, reads it back, and the audit row carries no text', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    const text = 'Climbing waiver unsigned';
    const res = await add(pass.id, headers, noteBody(text));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ body: text });
    const listed = await (await kit.get(headers, `/passes/${pass.id}/notes`)).json();
    expect(listed).toMatchObject({ items: [{ body: text }] });
    const audit = await all<{ actor_type: string; detail: string }>(
      kit.env.DB,
      "SELECT actor_type, detail FROM audit_log WHERE target_id = ? AND action = 'scan.note.add'",
      [pass.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_type).toBe('scanner');
    expect(audit[0]?.detail).not.toContain('waiver');
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({ via: 'scanner', chars: text.length });
  });

  it('never writes the text to a log', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    const text = 'Secret-looking note text 7731';
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      expect((await add(pass.id, headers, noteBody(text))).status).toBe(200);
      await kit.get(headers, `/passes/${pass.id}/notes`);
      await kit.get(headers, `/passes/${pass.id}/history`);
      for (const spy of spies)
        expect(JSON.stringify(spy.mock.calls)).not.toContain('Secret-looking');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('a Door device neither reads nor writes notes', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await door();
    expect((await add(pass.id, headers, noteBody())).status).toBe(403);
    expect((await kit.get(headers, `/passes/${pass.id}/notes`)).status).toBe(403);
    expect(await count(pass.id)).toBe(0);
  });

  it('a terminal, a customer screen and a monitor cannot write', async () => {
    const pass = await kit.scanPass(templateId);
    const terminal = await kit.scanner({ kind: 'terminal' });
    const screen = await kit.scanner({ deviceRole: 'customer' });
    const monitor = await kit.scanner({ deviceRole: 'monitor' });
    for (const d of [terminal, screen, monitor])
      expect([401, 403]).toContain((await add(pass.id, d.headers, noteBody())).status);
    expect(await count(pass.id)).toBe(0);
  });

  it('answers a pass of another org, another mode or another template as missing', async () => {
    const { headers } = await desk();
    const other = await makeOrg(kit.fx);
    const foreign = await kit.pass({ orgId: other.id });
    const test = await kit.scanPass(templateId, {}, { mode: 'test' });
    const otherTemplate = await kit.scanTemplate('Elsewhere', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
    });
    const elsewhere = await kit.scanPass(otherTemplate);
    const scoped = await desk();
    for (const [pass, h] of [
      [foreign, headers],
      [test, headers],
      [elsewhere, scoped.headers],
    ] as const) {
      expect((await add(pass.id, h, noteBody())).status).toBe(404);
      expect((await kit.get(h, `/passes/${pass.id}/notes`)).status).toBe(404);
      expect(await count(pass.id)).toBe(0);
    }
  });

  it('a deleted or removed pass has no notes to read or add', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    expect((await add(pass.id, headers, noteBody())).status).toBe(200);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
      kit.clock.now(),
      pass.id,
    ]);
    expect((await kit.get(headers, `/passes/${pass.id}/notes`)).status).toBe(404);
    expect((await add(pass.id, headers, noteBody())).status).toBe(404);
  });

  it('notes go with the pass', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    await add(pass.id, headers, noteBody());
    expect(await count(pass.id)).toBe(1);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(await count(pass.id)).toBe(0);
  });

  it('takes one plain line of at most 280 characters', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    const bad = [
      'x'.repeat(281),
      '',
      '   ',
      'two\nlines',
      'bell\u0007',
      'bidi‮flip',
      { body: 'ok', idempotencyKey: key(), extra: 1 },
    ];
    for (const body of bad)
      expect(
        (
          await add(
            pass.id,
            headers,
            typeof body === 'string' ? { body, idempotencyKey: key() } : body,
          )
        ).status,
      ).toBe(422);
    expect((await add(pass.id, headers, noteBody('x'.repeat(280)))).status).toBe(200);
    expect(await count(pass.id)).toBe(1);
  });

  it('a retried tap is one note', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    const body = noteBody();
    const first = await (await add(pass.id, headers, body)).json();
    const again = await (await add(pass.id, headers, body)).json();
    expect(again).toEqual(first);
    expect(await count(pass.id)).toBe(1);
  });

  it('limits writes per device', async () => {
    const pass = await kit.scanPass(templateId);
    const a = await desk();
    const b = await desk();
    const before = kit.env.RL_SCAN_LOOKUP;
    Object.assign(kit.env, { RL_SCAN_LOOKUP: fakeRateLimiter({ limit: 2 }) });
    try {
      expect((await add(pass.id, a.headers, noteBody())).status).toBe(200);
      expect((await add(pass.id, a.headers, noteBody())).status).toBe(200);
      expect((await add(pass.id, a.headers, noteBody())).status).toBe(429);
      // Another device has its own budget.
      expect((await add(pass.id, b.headers, noteBody())).status).toBe(200);
    } finally {
      Object.assign(kit.env, { RL_SCAN_LOOKUP: before });
    }
  });

  it('keeps at most 100 notes on a pass', async () => {
    const pass = await kit.scanPass(templateId);
    const { headers } = await desk();
    for (let i = 0; i < 100; i++)
      await run(
        kit.env.DB,
        `INSERT INTO pass_notes (id, org_id, mode, pass_id, body, author_name, idempotency_key, created_at)
         VALUES (?, ?, 'live', ?, 'n', 'Desk', ?, ?)`,
        [`note-${pass.id}-${i}`, kit.org.id, pass.id, `k${i}`, kit.clock.now() + i],
      );
    expect((await add(pass.id, headers, noteBody())).status).toBe(409);
    expect(await count(pass.id)).toBe(100);
  });

  it('refuses at commit when the device is revoked after the guard', async () => {
    const pass = await kit.scanPass(templateId);
    const device = await desk();
    await run(kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
      kit.clock.now(),
      device.id,
    ]);
    expect((await add(pass.id, device.headers, noteBody())).status).toBe(401);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_notes WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
  });
});
