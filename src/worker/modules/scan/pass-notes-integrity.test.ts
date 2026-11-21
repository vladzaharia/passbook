import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import type { PassNote } from '../../../shared/contracts/scan-history.ts';
import { first, run } from '../../platform/db.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { workspace } from './repo-session-activity-authority-test-fixtures.ts';
import { key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let fake: ReturnType<typeof fakeAuth>;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  fake = fakeAuth('https://wallet.test');
  fake.bindSessions(kit.env.DB, kit.clock);
  templateId = await kit.scanTemplate('Integrity', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
  });
});

const path = (passId: string, noteId?: string) =>
  `/passes/${passId}/notes${noteId ? `/${noteId}` : ''}`;
const body = (text: string) => ({ body: text, idempotencyKey: key() });

async function verb(method: string, headers: Record<string, string>, p: string, payload?: unknown) {
  const { createApp } = await import('../../app.ts');
  const { createScannerStore } = await import('./auth-store.ts');
  const app = createApp({
    clock: kit.clock,
    stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
  });
  return app.request(
    `https://wallet.test/api/v1/scan${p}`,
    {
      method,
      headers: { ...headers, origin: 'https://wallet.test', 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    kit.env,
  );
}

async function manager(name: string) {
  const staff = await kit.staff('manager', name);
  return kit.scanner({
    templateIds: [templateId],
    staffId: staff.id,
    settings: { staffSignIn: true },
  });
}

const hold = (passId: string | null) =>
  run(
    kit.env.DB,
    `INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at)
     VALUES (?, ?, ?, 'platform', 'p', 'r', 1)`,
    [kit.fx.ids.id(), kit.org.id, passId],
  );
const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

describe('notes under a retention hold', () => {
  it.each(['pass', 'org'] as const)(
    'a %s hold refuses edit and delete; adds still work',
    async (scope) => {
      const pass = await kit.scanPass(templateId);
      const mia = await manager(`Mia hold ${scope}`);
      const made = (await (
        await kit.post(mia.headers, path(pass.id), body('Keep me'))
      ).json()) as PassNote;
      const rows = () =>
        kit.env.DB.prepare('SELECT body FROM pass_notes WHERE pass_id = ?').bind(pass.id).all();
      if (scope === 'pass') await hold(pass.id);
      else {
        await hold(null);
      }
      const edit = await verb('PATCH', mia.headers, path(pass.id, made.id), { body: 'Changed' });
      expect(edit.status).toBe(409);
      expect(await code(edit)).toBe('NOTE_HELD');
      const del = await verb('DELETE', mia.headers, path(pass.id, made.id));
      expect(del.status).toBe(409);
      expect(await code(del)).toBe('NOTE_HELD');
      expect((await rows()).results).toEqual([{ body: 'Keep me' }]);
      expect((await kit.post(mia.headers, path(pass.id), body('Added under hold'))).status).toBe(
        200,
      );
      await run(kit.env.DB, 'UPDATE retention_holds SET released_at = 2 WHERE released_at IS NULL');
      expect(
        (await verb('PATCH', mia.headers, path(pass.id, made.id), { body: 'Changed' })).status,
      ).toBe(200);
    },
  );

  it('the console path is refused too', async () => {
    const pass = await kit.scanPass(templateId);
    const mia = await manager('Mia console');
    const made = (await (
      await kit.post(mia.headers, path(pass.id), body('Console'))
    ).json()) as PassNote;
    await hold(pass.id);
    const admin = fake.admin();
    const scope = { orgId: kit.org.id, timeZone: 'UTC' };
    const edit = await verb('PATCH', admin, path(pass.id, made.id), { body: 'x', scope });
    expect(edit.status).toBe(409);
    expect(await code(edit)).toBe('NOTE_HELD');
    const del = await verb('DELETE', admin, path(pass.id, made.id), { scope });
    expect(del.status).toBe(409);
    expect(await code(del)).toBe('NOTE_HELD');
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM pass_notes WHERE id = ?', [made.id]),
    ).not.toBeNull();
  });
});

describe('notes from the console', () => {
  it('a console edit and delete go through over HTTP, and need the org scope', async () => {
    const pass = await kit.scanPass(templateId);
    const mia = await manager('Mia console ok');
    const made = (await (
      await kit.post(mia.headers, path(pass.id), body('Console ok'))
    ).json()) as PassNote;
    const admin = fake.admin();
    const scope = { orgId: kit.org.id, timeZone: 'UTC' };
    expect((await verb('PATCH', admin, path(pass.id, made.id), { body: 'No scope' })).status).toBe(
      422,
    );
    const edit = await verb('PATCH', admin, path(pass.id, made.id), { body: 'Fixed', scope });
    expect(edit.status, await edit.clone().text()).toBe(200);
    expect(await edit.json()).toMatchObject({ body: 'Fixed', edited: true });
    expect((await verb('DELETE', admin, path(pass.id, made.id), { scope })).status).toBe(200);
  });
});

describe('notes through a scanning session', () => {
  async function inSession(status: string, hours: string | null = null) {
    const mia = await manager(`Mia ${kit.fx.ids.id()}`);
    const pass = await kit.scanPass(templateId);
    const made = (await (
      await kit.post(mia.headers, path(pass.id), body('In session'))
    ).json()) as PassNote;
    const id = await workspace(
      kit,
      mia,
      { templateIds: [templateId] },
      { ...DEFAULT_SETTINGS, staffSignIn: true },
    );
    await run(kit.env.DB, 'UPDATE scanning_sessions SET status = ?, hours = ? WHERE id = ?', [
      status,
      hours,
      id,
    ]);
    return { mia, pass, made };
  }

  it('an open session edits and deletes', async () => {
    const { mia, pass, made } = await inSession('active');
    expect(
      (await verb('PATCH', mia.headers, path(pass.id, made.id), { body: 'Fine' })).status,
    ).toBe(200);
    expect((await verb('DELETE', mia.headers, path(pass.id, made.id))).status).toBe(200);
  });

  it('a paused session refuses edit and delete, and reads still work', async () => {
    const { mia, pass, made } = await inSession('paused');
    const edit = await verb('PATCH', mia.headers, path(pass.id, made.id), { body: 'No' });
    expect(edit.status).toBe(403);
    expect(await code(edit)).toBe('SCANNING_SESSION_PAUSED');
    const del = await verb('DELETE', mia.headers, path(pass.id, made.id));
    expect(await code(del)).toBe('SCANNING_SESSION_PAUSED');
    expect((await kit.get(mia.headers, path(pass.id))).status).toBe(200);
  });

  it('a closed session refuses edit and delete', async () => {
    kit.clock.set(Date.UTC(2026, 5, 3, 9));
    const { mia, pass, made } = await inSession('active', '{"thu":["08:00-22:00"]}');
    const edit = await verb('PATCH', mia.headers, path(pass.id, made.id), { body: 'No' });
    expect(await code(edit)).toBe('SCANNING_SESSION_CLOSED');
    expect(await code(await verb('DELETE', mia.headers, path(pass.id, made.id)))).toBe(
      'SCANNING_SESSION_CLOSED',
    );
  });
});
