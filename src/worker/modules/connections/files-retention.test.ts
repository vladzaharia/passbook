import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeConnection } from './access.ts';
import { createUpload, csvBody, MEMBERS, useUploadConnector } from './files-fixtures.ts';
import { dailyConnectionFiles, FILE_LIMITS, sweepOrphans } from './files-retention.ts';
import { createDraft } from './files-service.ts';
import { addMembership, type Kit, linkedPass, makeKit } from './test-kit.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let kit: Kit;
let authority: Awaited<ReturnType<typeof authorizeConnection>>;
beforeEach(async () => {
  kit = await makeKit();
  vi.restoreAllMocks();
  useUploadConnector();
  await addMembership(kit, kit.actor.id, ['integration_admin']);
  const fixture = await makeSession(kit, { userId: kit.actor.id });
  const session = (await createSessionStore(kit.env, kit.clock).resolve(
    fixture.cookieValue,
  )) as SessionAuth;
  authority = await authorizeConnection(kit.sctx, session, kit.org.id, 'integrations:manage');
});

const draft = (name = 'm.csv') =>
  createDraft(kit.sctx, kit.actor, authority, csvBody(MEMBERS, name));
const prefix = (id: string) => `uploads/connection-files/${kit.org.id}/${id}/`;
const objects = async (id: string) =>
  (await kit.env.BUCKET.list({ prefix: prefix(id) })).objects.length;
const stateOf = async (id: string) =>
  (
    await first<{ state: string }>(kit.env.DB, 'SELECT state FROM connection_files WHERE id = ?', [
      id,
    ])
  )?.state;
const receipts = async () =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM retention_receipts WHERE class = 'imports' AND deleted = 1",
    )
  )?.n ?? 0;

/** A superseded revision of the connection, with an object under it. */
async function superseded(connectionId: string, revision: number, at: number): Promise<string> {
  const id = kit.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connection_files (id, org_id, connection_id, revision, state, name, format, column_labels, bytes, sha256, rows, columns, created_at, superseded_at)
     VALUES (?, ?, ?, ?, 'superseded', 'old.csv', 'csv', '[]', 1, 'x', 1, 1, ?, ?)`,
    [id, kit.org.id, connectionId, revision, at, at],
  );
  await kit.env.BUCKET.put(`${prefix(id)}source`, 'old');
  return id;
}

describe('daily connection files', () => {
  it('expires a draft after 23 hours and deletes its objects, keeping a fresh one', async () => {
    const old = await draft();
    const fresh = await draft('n.csv');
    await run(kit.env.DB, 'UPDATE connection_files SET expires_at = ? WHERE id = ?', [
      kit.clock.now() - 1,
      old.id,
    ]);
    await dailyConnectionFiles(kit.sctx);
    expect(await stateOf(old.id)).toBe('expired');
    expect(await objects(old.id)).toBe(0);
    expect(await stateOf(fresh.id)).toBe('draft');
    expect(await objects(fresh.id)).toBe(2);
  });

  it('discards a pending revision nobody applied, and keeps the current one', async () => {
    const d = await draft();
    const conn = await createUpload(kit, d.id);
    const pending = kit.ids.id();
    await run(
      kit.env.DB,
      `INSERT INTO connection_files (id, org_id, connection_id, revision, state, name, format, column_labels, bytes, sha256, rows, columns, created_at, expires_at)
       VALUES (?, ?, ?, 2, 'pending', 'p.csv', 'csv', '[]', 1, 'x', 1, 1, ?, ?)`,
      [pending, kit.org.id, conn.id, kit.clock.now(), kit.clock.now() + 23 * HOUR],
    );
    await kit.env.BUCKET.put(`${prefix(pending)}source`, 'p');
    kit.clock.advance(24 * HOUR);
    await dailyConnectionFiles(kit.sctx);
    expect(await stateOf(pending)).toBe('discarded');
    expect(await objects(pending)).toBe(0);
    expect(await stateOf(d.id)).toBe('current');
    expect(await objects(d.id)).toBe(4);
  });

  it('keeps the newest 2 superseded revisions and retires the rest with a receipt', async () => {
    const d = await draft();
    const conn = await createUpload(kit, d.id);
    const now = kit.clock.now();
    const ids = [
      await superseded(conn.id, 2, now),
      await superseded(conn.id, 3, now),
      await superseded(conn.id, 4, now),
      await superseded(conn.id, 5, now),
    ];
    const before = await receipts();
    await dailyConnectionFiles(kit.sctx);
    expect(await Promise.all(ids.map(stateOf))).toEqual([
      undefined,
      undefined,
      'superseded',
      'superseded',
    ]);
    expect(await Promise.all(ids.map(objects))).toEqual([0, 0, 1, 1]);
    expect((await receipts()) - before).toBe(2);
    expect(await stateOf(d.id)).toBe('current');
  });

  it('retires a superseded revision older than the org imports days even within the newest 2', async () => {
    const d = await draft();
    const conn = await createUpload(kit, d.id);
    const now = kit.clock.now();
    const ancient = await superseded(conn.id, 2, now - 400 * DAY);
    const recent = await superseded(conn.id, 3, now);
    await dailyConnectionFiles(kit.sctx);
    expect(await stateOf(ancient)).toBeUndefined();
    expect(await stateOf(recent)).toBe('superseded');
  });

  it('holds superseded revisions while an org-wide retention hold stands', async () => {
    const d = await draft();
    const conn = await createUpload(kit, d.id);
    const ids = [
      await superseded(conn.id, 2, kit.clock.now()),
      await superseded(conn.id, 3, kit.clock.now()),
      await superseded(conn.id, 4, kit.clock.now()),
    ];
    await run(
      kit.env.DB,
      `INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, NULL, 'org', ?, 'legal', ?)`,
      [kit.ids.id(), kit.org.id, kit.actor.id, kit.clock.now()],
    );
    await dailyConnectionFiles(kit.sctx);
    expect(await Promise.all(ids.map(stateOf))).toEqual(['superseded', 'superseded', 'superseded']);
  });

  it('holds superseded revisions while a pass the connection issued is held (L3)', async () => {
    const d = await draft();
    const conn = await createUpload(kit, d.id);
    const ids = [
      await superseded(conn.id, 2, kit.clock.now()),
      await superseded(conn.id, 3, kit.clock.now()),
      await superseded(conn.id, 4, kit.clock.now()),
    ];
    const pass = await linkedPass(kit, conn.id, 'm-1');
    await run(
      kit.env.DB,
      `INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, ?, 'org', ?, 'legal', ?)`,
      [kit.ids.id(), kit.org.id, pass.id, kit.actor.id, kit.clock.now()],
    );
    await dailyConnectionFiles(kit.sctx);
    expect(await Promise.all(ids.map(stateOf))).toEqual(['superseded', 'superseded', 'superseded']);
  });

  it('judges an orphan by its newest object even when a listing page split it (L4)', async () => {
    const orphan = kit.ids.id();
    await kit.env.BUCKET.put(`${prefix(orphan)}source`, 'x');
    await kit.env.BUCKET.put(`${prefix(orphan)}rows/b/refs.json`, '[]');
    kit.clock.set(Date.now() + 10 * 60_000);
    const list = kit.env.BUCKET.list.bind(kit.env.BUCKET);
    // The root page shows only the old half of the file; the whole prefix holds a young object too.
    vi.spyOn(kit.env.BUCKET, 'list').mockImplementation(async (options) => {
      const page = await list(options);
      if (options?.prefix !== 'uploads/connection-files/') return page;
      const objects = page.objects
        .filter((o) => o.key === `${prefix(orphan)}source`)
        .map((o) => ({ ...o, uploaded: new Date(0) }));
      return { ...page, objects, truncated: false } as typeof page;
    });
    await run(kit.env.DB, "DELETE FROM settings WHERE key = 'retention.cursor:connection-files'");
    await sweepOrphans(kit.sctx);
    expect(await objects(orphan)).toBe(2);
  });

  it('deletes rows of ended uploads a week later', async () => {
    const d = await draft();
    kit.clock.advance(24 * HOUR);
    await dailyConnectionFiles(kit.sctx);
    expect(await stateOf(d.id)).toBe('expired');
    kit.clock.advance(7 * DAY);
    await dailyConnectionFiles(kit.sctx);
    expect(await stateOf(d.id)).toBeUndefined();
  });

  it('removes objects that no row names once they are an hour old, and leaves young ones', async () => {
    const orphan = kit.ids.id();
    await kit.env.BUCKET.put(`${prefix(orphan)}source`, 'x');
    await kit.env.BUCKET.put(`${prefix(orphan)}refs.json`, '[]');
    const d = await draft();
    expect(await sweepOrphans(kit.sctx)).toBe(0);
    expect(await objects(orphan)).toBe(2);
    kit.clock.set(Date.now() + 2 * HOUR);
    await run(kit.env.DB, "DELETE FROM settings WHERE key = 'retention.cursor:connection-files'");
    expect(await sweepOrphans(kit.sctx)).toBeGreaterThanOrEqual(1);
    expect(await objects(orphan)).toBe(0);
    expect(await objects(d.id)).toBe(2);
  });

  it('bounds the work of one run', () => {
    expect(FILE_LIMITS.unfinished).toBeLessThanOrEqual(500);
  });
});
