import { beforeAll, describe, expect, it } from 'vitest';
import type { PassNote } from '../../../shared/contracts/scan-history.ts';
import { all, run } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { mayReadNotes, readsAllowed } from './history-scope.ts';
import { passHistorySelector } from './repo-history-pass.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Manage', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
  });
});

type Role = 'door' | 'desk' | 'manager';
async function device(role: Role, name: string) {
  const staff = await kit.staff(role, name);
  return kit.scanner({
    templateIds: [templateId],
    staffId: staff.id,
    settings: { staffSignIn: true },
  });
}
const path = (passId: string, noteId?: string) =>
  `/passes/${passId}/notes${noteId ? `/${noteId}` : ''}`;
async function fetchVerb(
  method: string,
  headers: Record<string, string>,
  p: string,
  body?: unknown,
) {
  const { createApp } = await import('../../app.ts');
  const { denyAllStores } = await import('../../platform/auth.ts');
  const { createScannerStore } = await import('./auth-store.ts');
  const app = createApp({
    clock: kit.clock,
    stores: { ...denyAllStores, scanners: createScannerStore(kit.env, kit.clock) },
  });
  return app.request(
    `https://wallet.test/api/v1/scan${p}`,
    {
      method,
      headers: { ...headers, origin: 'https://wallet.test', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    kit.env,
  );
}
const add = async (passId: string, headers: Record<string, string>, text: string) =>
  (await (
    await kit.post(headers, path(passId), { body: text, idempotencyKey: key() })
  ).json()) as PassNote;

describe('changing and deleting notes', () => {
  it('the author edits and deletes their own; the audit rows carry no text', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk', 'Dana M.');
    const made = await add(pass.id, dana.headers, 'First thought');
    expect(made.own).toBe(true);
    const edited = await fetchVerb('PATCH', dana.headers, path(pass.id, made.id), {
      body: 'Second thought',
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ body: 'Second thought', edited: true, own: true });
    const gone = await fetchVerb('DELETE', dana.headers, path(pass.id, made.id));
    expect(gone.status).toBe(200);
    expect(await all(kit.env.DB, 'SELECT 1 FROM pass_notes WHERE pass_id = ?', [pass.id])).toEqual(
      [],
    );
    const rows = await all<{ action: string; detail: string }>(
      kit.env.DB,
      "SELECT action, detail FROM audit_log WHERE target_id = ? AND action LIKE 'scan.note.%' ORDER BY id",
      [pass.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'scan.note.add',
      'scan.note.edit',
      'scan.note.delete',
    ]);
    expect(JSON.stringify(rows)).not.toContain('thought');
  });

  it('another Desk cannot touch it; a Manager can; a Door and a console read-only cannot', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk', 'Dana N.');
    const eli = await device('desk', 'Eli N.');
    const mia = await device('manager', 'Mia N.');
    const dev = await device('door', 'Dev N.');
    const made = await add(pass.id, dana.headers, 'Mine');
    for (const other of [eli, dev]) {
      expect((await fetchVerb('DELETE', other.headers, path(pass.id, made.id))).status).toBe(
        other === dev ? 403 : 404,
      );
      expect(
        (await fetchVerb('PATCH', other.headers, path(pass.id, made.id), { body: 'No' })).status,
      ).toBe(other === dev ? 403 : 404);
    }
    const listed = (await (await kit.get(eli.headers, path(pass.id))).json()) as {
      items: PassNote[];
    };
    expect(listed.items[0]).toMatchObject({ body: 'Mine', own: false });
    const changed = await fetchVerb('PATCH', mia.headers, path(pass.id, made.id), {
      body: 'Fixed',
    });
    expect(changed.status).toBe(200);
    expect((await fetchVerb('DELETE', mia.headers, path(pass.id, made.id))).status).toBe(200);
    expect((await fetchVerb('DELETE', mia.headers, path(pass.id, made.id))).status).toBe(404);
  });

  it('refuses a malformed edit, and a note of another pass', async () => {
    const pass = await kit.scanPass(templateId);
    const other = await kit.scanPass(templateId);
    const dana = await device('desk', 'Dana O.');
    const made = await add(pass.id, dana.headers, 'Mine');
    expect(
      (await fetchVerb('PATCH', dana.headers, path(pass.id, made.id), { body: 'a\nb' })).status,
    ).toBe(422);
    expect((await fetchVerb('DELETE', dana.headers, path(other.id, made.id))).status).toBe(404);
  });

  it('one device adds at most 10 notes to a person a day; another device and a deleted note free room', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk', 'Dana P.');
    const eli = await device('desk', 'Eli P.');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await add(pass.id, dana.headers, `n${i}`)).id);
    const eleventh = await kit.post(dana.headers, path(pass.id), {
      body: 'one more',
      idempotencyKey: key(),
    });
    expect(eleventh.status).toBe(409);
    expect(await eleventh.json()).toMatchObject({ code: 'NOTE_DEVICE_CAP' });
    expect((await add(pass.id, eli.headers, 'Eli is fine')).body).toBeDefined();
    await fetchVerb('DELETE', dana.headers, path(pass.id, ids[0] ?? ''));
    expect(
      (await kit.post(dana.headers, path(pass.id), { body: 'room', idempotencyKey: key() })).status,
    ).toBe(200);
    await run(kit.env.DB, 'UPDATE pass_notes SET created_at = created_at - ? WHERE pass_id = ?', [
      25 * 3_600_000,
      pass.id,
    ]);
    expect(
      (await kit.post(dana.headers, path(pass.id), { body: 'next day', idempotencyKey: key() }))
        .status,
    ).toBe(200);
  });
});

describe('reads are audited and bounded', () => {
  it('history and notes reads leave one row with a count and no content; a later page does not', async () => {
    const pass = await kit.scanPass(templateId);
    const dana = await device('desk', 'Dana Q.');
    await add(pass.id, dana.headers, 'Secret remark');
    await kit.get(dana.headers, path(pass.id));
    await kit.get(dana.headers, `/passes/${pass.id}/history`);
    await kit.get(dana.headers, `/passes/${pass.id}/history?cursor=1_x`);
    const rows = await all<{ action: string; detail: string }>(
      kit.env.DB,
      "SELECT action, detail FROM audit_log WHERE target_id = ? AND action IN ('scan.history.read', 'scan.note.read')",
      [pass.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['scan.note.read']);
    expect(JSON.stringify(rows)).not.toContain('Secret');
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toHaveProperty('count');
  });

  it('reads of two passes, or after the window, each leave a row', async () => {
    const [a, b] = [await kit.scanPass(templateId), await kit.scanPass(templateId)];
    const dana = await device('desk', 'Dana R.');
    await kit.get(dana.headers, `/passes/${a.id}/history`);
    await kit.get(dana.headers, `/passes/${b.id}/history`);
    kit.clock.advance(61_000);
    await kit.get(dana.headers, `/passes/${a.id}/history`);
    const rows = await all<{ target_id: string }>(
      kit.env.DB,
      "SELECT target_id FROM audit_log WHERE action = 'scan.history.read' AND target_id IN (?, ?)",
      [a.id, b.id],
    );
    expect(rows.map((r) => r.target_id).sort()).toEqual([a.id, a.id, b.id].sort());
  });

  it('a terminal reads no notes', async () => {
    const pass = await kit.scanPass(templateId);
    const till = await kit.scanner({
      kind: 'terminal',
      templateIds: [templateId],
      settings: { roleWithoutSignIn: 'desk' },
    });
    expect([401, 403]).toContain((await kit.get(till.headers, path(pass.id))).status);
  });
});

/** A bare actor: the session rules need only these fields. */
const actorOf = (over: Partial<ScanActor>): ScanActor =>
  ({
    principal: 'scanner',
    role: 'desk',
    terminal: false,
    scanner: { deviceRole: 'scan' },
    invalidScannerScope: false,
    ...over,
  }) as unknown as ScanActor;

describe('the live-session rule', () => {
  it('a paused or ended session, or an invalid scope, reads nothing below Manager', () => {
    const paused = { id: 's', status: 'paused', updatedAt: 0 } as const;
    expect(readsAllowed(actorOf({ scanningSession: paused }), 0)).toBe(false);
    expect(readsAllowed(actorOf({ scanningSession: paused, role: 'manager' }), 0)).toBe(true);
    expect(readsAllowed(actorOf({ invalidScannerScope: true }), 0)).toBe(false);
    expect(readsAllowed(actorOf({}), 0)).toBe(true);
    // An active session whose hours were not observed reads nothing.
    expect(
      readsAllowed(actorOf({ scanningSession: { id: 's', status: 'active', updatedAt: 0 } }), 0),
    ).toBe(false);
  });

  it('a terminal, a Door and a monitor read no notes', () => {
    expect(mayReadNotes(actorOf({ terminal: true }), 0)).toBe(false);
    expect(mayReadNotes(actorOf({ role: 'door' }), 0)).toBe(false);
    expect(mayReadNotes(actorOf({ scanner: { deviceRole: 'monitor' } as never }), 0)).toBe(false);
    expect(mayReadNotes(actorOf({}), 0)).toBe(true);
  });

  it('a mixed scope reads only its own events', () => {
    const q = { passId: 'p', templateId: 't', since: 0, filter: 'all', limit: 5 } as const;
    const mixed = passHistorySelector(
      actorOf({
        events: [
          { event: { id: 'e2' }, templateIds: [] },
          { event: { id: 'e1' }, templateIds: [] },
        ] as never,
      }),
      q,
    );
    expect(mixed.where).toContain('json_each');
    expect(mixed.params).toContain('["e1","e2"]');
    expect(passHistorySelector(actorOf({}), q).where).not.toContain('json_each');
  });
});
