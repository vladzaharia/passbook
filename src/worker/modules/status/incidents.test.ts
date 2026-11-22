import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { fakeAuth, makeEnv } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let base: AppEnv;
beforeAll(async () => {
  base = await makeEnv();
});

const send = (path: string, init: { method?: string; body?: unknown; user?: boolean } = {}) =>
  app.request(
    `/api/v1/status/incidents${path}`,
    {
      method: init.method ?? 'GET',
      headers: { ...(init.user ? fake.user() : fake.admin()), 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    base,
  );
const actions = async () =>
  (
    await all<{ action: string }>(
      env.DB,
      "SELECT action FROM audit_log WHERE action LIKE 'status.incident.%' ORDER BY id",
    )
  ).map((r) => r.action);

describe('incident notes', () => {
  it('are for platform admins only', async () => {
    await expectProblem(await send('', { user: true }), 403, 'FORBIDDEN');
    await expectProblem(
      await send('', {
        method: 'POST',
        user: true,
        body: { title: 't', note: 'n', impact: 'notice' },
      }),
      403,
      'FORBIDDEN',
    );
  });

  it('open, list and resolve once, each audited', async () => {
    await run(env.DB, 'DELETE FROM status_incidents');
    const made = await send('', {
      method: 'POST',
      body: {
        title: ' Push delayed ',
        note: 'Pushes arrive late.',
        component: 'apple_push',
        impact: 'degraded',
      },
    });
    expect(made.status).toBe(201);
    const note = (await made.json()) as { id: string; title: string; resolvedAt: number | null };
    expect(note).toMatchObject({ title: 'Push delayed', resolvedAt: null });
    const listed = (await (await send('')).json()) as { items: { id: string }[] };
    expect(listed.items.map((i) => i.id)).toEqual([note.id]);

    const first = (await (await send(`/${note.id}/resolve`, { method: 'POST' })).json()) as {
      resolvedAt: number;
    };
    expect(first.resolvedAt).toBeGreaterThan(0);
    const again = (await (await send(`/${note.id}/resolve`, { method: 'POST' })).json()) as {
      resolvedAt: number;
    };
    expect(again.resolvedAt).toBe(first.resolvedAt);
    expect((await actions()).filter((a) => a === 'status.incident.resolve')).toHaveLength(1);
    expect(await actions()).toContain('status.incident.open');
    await expectProblem(await send('/nope/resolve', { method: 'POST' }), 404, 'INCIDENT_NOT_FOUND');
  });

  it('writes the note and its audit row together', async () => {
    await run(env.DB, 'DELETE FROM status_incidents');
    await run(
      env.DB,
      `CREATE TRIGGER incident_audit_fails BEFORE INSERT ON audit_log WHEN NEW.action = 'status.incident.open'
       BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
    );
    try {
      const res = await send('', {
        method: 'POST',
        body: { title: 'Down', note: 'Nothing works.', impact: 'outage' },
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await run(env.DB, 'DROP TRIGGER incident_audit_fails');
    }
    expect(await all(env.DB, 'SELECT id FROM status_incidents')).toEqual([]);
  });

  it('rolls a resolve back when its audit fails, so a retry still audits it', async () => {
    await run(env.DB, 'DELETE FROM status_incidents');
    const made = await send('', {
      method: 'POST',
      body: { title: 'Slow', note: 'Slow.', impact: 'notice' },
    });
    const { id } = (await made.json()) as { id: string };
    await run(
      env.DB,
      `CREATE TRIGGER incident_resolve_audit_fails BEFORE INSERT ON audit_log WHEN NEW.action = 'status.incident.resolve'
       BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
    );
    try {
      expect((await send(`/${id}/resolve`, { method: 'POST' })).status).toBeGreaterThanOrEqual(500);
    } finally {
      await run(env.DB, 'DROP TRIGGER incident_resolve_audit_fails');
    }
    expect(
      await all(env.DB, 'SELECT id FROM status_incidents WHERE id = ? AND resolved_at IS NULL', [
        id,
      ]),
    ).toHaveLength(1);
    expect((await send(`/${id}/resolve`, { method: 'POST' })).status).toBe(200);
    expect(
      await all(
        env.DB,
        "SELECT id FROM audit_log WHERE action = 'status.incident.resolve' AND target_id = ?",
        [id],
      ),
    ).toHaveLength(1);
  });

  it('lists an open note older than many newer resolved ones', async () => {
    await run(env.DB, 'DELETE FROM status_incidents');
    const now = Date.now();
    await run(
      env.DB,
      `INSERT INTO status_incidents (id, title, note, impact, started_at) VALUES ('old-open', 'Old', 'n', 'notice', ?)`,
      [now - 10_000_000],
    );
    for (let i = 0; i < 30; i++)
      await run(
        env.DB,
        `INSERT INTO status_incidents (id, title, note, impact, started_at, resolved_at) VALUES (?, 't', 'n', 'notice', ?, ?)`,
        [`r${i}`, now - i * 1000, now],
      );
    const listed = (await (await send('')).json()) as { items: { id: string }[] };
    expect(listed.items[0]?.id).toBe('old-open');
    expect(listed.items).toHaveLength(31);
  });

  it('refuses an empty title and an unknown component', async () => {
    for (const body of [
      { title: ' ', note: 'n', impact: 'notice' },
      { title: 't', note: 'n', impact: 'notice', component: 'billing' },
    ])
      expect((await send('', { method: 'POST', body })).status).toBe(422);
  });
});
