import { describe, expect, it } from 'vitest';
import { makeOrg, makePass } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { releasedVersion } from './repo.ts';

const json = { 'content-type': 'application/json' };

async function setup() {
  const kit = await ruleKit();
  const pass = await kit.datedPass();
  const other = await kit.datedPass();
  /** Template routes name the org (the test templates are shared) and, on PUT, the revision read. */
  const call = async (method: string, path: string, body?: unknown, headers = kit.auth.admin()) => {
    const shared = /^\/templates\/[^/?]+\/channels/.test(path);
    const url =
      shared && method === 'GET' && !path.includes('?') ? `${path}?orgId=${kit.org.id}` : path;
    let withOrg =
      shared && body && typeof body === 'object' ? { orgId: kit.org.id, ...body } : body;
    if (shared && method === 'PUT' && withOrg && !('revision' in (withOrg as object))) {
      const view = (await (await call('GET', path, undefined, headers)).json()) as {
        revision?: number;
      };
      withOrg = { revision: view.revision ?? 0, ...(withOrg as object) };
    }
    return kit.api(url, {
      method,
      headers: { ...headers, ...json },
      ...(withOrg === undefined ? {} : { body: JSON.stringify(withOrg) }),
    });
  };
  const setting = async (scope: string, key: string, value: unknown) => {
    await run(
      kit.env.DB,
      'INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      [scope, key, JSON.stringify(value), 'test', 1],
    );
    clearSettingsCache(kit.env.DB);
  };
  const rows = (sql: string, ...p: (string | number)[]) =>
    all<Record<string, unknown>>(kit.env.DB, sql, p);
  const count = async (table: string) =>
    (await first<{ n: number }>(kit.env.DB, `SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0;
  return { kit, pass, other, call, setting, rows, count };
}

describe('channel routes', () => {
  it('reports the defaults with their sources and reasons', async () => {
    const { pass, call } = await setup();
    const res = await call('GET', `/passes/${pass.id}/channels`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effective: Record<string, unknown>; overrides: object };
    expect(body.effective.mobile).toEqual({ on: true, source: 'template' });
    expect(body.effective.apple).toEqual({ on: true, source: 'template' });
    expect(body.effective.google).toEqual({
      on: false,
      source: 'platform',
      reason: 'not_released',
    });
    expect(body.effective.paper).toEqual({ on: false, source: 'template', reason: 'template_off' });
    expect(body.effective.nfc).toEqual({ on: true, source: 'template' });
    expect(body.overrides).toEqual({});
  });

  it('overrides a pass, retires on off, restores on reset, audits and journals', async () => {
    const { kit, pass, call, rows } = await setup();
    let res = await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off' } });
    expect(res.status).toBe(200);
    let body = (await res.json()) as {
      effective: Record<string, { on: boolean; retiredAt?: number }>;
      overrides: object;
    };
    expect(body.effective.apple).toMatchObject({ on: false, source: 'pass', reason: 'pass_off' });
    expect(body.effective.apple?.retiredAt).toBeTypeOf('number');
    expect(body.overrides).toEqual({ apple: 'off' });
    const audit = await rows(
      "SELECT detail FROM audit_log WHERE action = 'pass.channels_change' AND target_id = ?",
      pass.id,
    );
    expect(JSON.parse(audit[0]?.detail as string)).toMatchObject({
      channel: 'apple',
      from: 'on',
      to: 'off',
      source: 'pass',
    });
    await kit.settle();
    const feed = await rows(
      "SELECT type, data FROM event_feed WHERE pass_id = ? AND type = 'pass.channels_changed'",
      pass.id,
    );
    expect(feed).toHaveLength(1);

    res = await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: null } });
    body = (await res.json()) as typeof body;
    expect(body.effective.apple).toEqual({ on: true, source: 'template' });
    expect(body.overrides).toEqual({});
  });

  it('saves a template policy per mode and previews the effect', async () => {
    const { kit, pass, other, call } = await setup();
    await call('PUT', `/passes/${other.id}/channels`, { channels: { apple: 'on' } });
    const t = pass.templateId;
    const dry = (await (
      await call('PUT', `/templates/${t}/channels`, {
        channels: { apple: 'off' },
        dryRun: true,
        orgId: kit.org.id,
      })
    ).json()) as { impact: object[]; channels: unknown };
    expect(dry.impact).toEqual([{ channel: 'apple', passes: 1, rotated: 0, clearedOverrides: 0 }]);
    expect(dry.channels).toBeNull();

    const saved = await call('PUT', `/templates/${t}/channels`, {
      channels: { apple: 'off' },
      orgId: kit.org.id,
    });
    expect(saved.status).toBe(200);
    const view = async (mode?: 'test') =>
      (await (
        await call(
          'GET',
          `/templates/${t}/channels`,
          undefined,
          kit.auth.admin(mode ? { mode } : {}),
        )
      ).json()) as { channels: unknown; effective: Record<string, { reason?: string }> };
    expect((await view()).channels).toEqual({ apple: 'off' });
    expect((await view()).effective.apple?.reason).toBe('template_off');
    expect((await view('test')).channels).toBeNull();
    const effective = (await (await call('GET', `/passes/${pass.id}/channels`)).json()) as {
      effective: Record<string, { on: boolean }>;
    };
    expect(effective.effective.apple?.on).toBe(false);
    const again = (await (
      await call('GET', `/passes/${other.id}/channels`)
    ).json()) as typeof effective;
    expect(again.effective.apple?.on).toBe(true);
  });

  it('only never clears overrides; an org block keeps them', async () => {
    const { kit, pass, other, call, setting, rows } = await setup();
    const t = pass.templateId;
    await call('PUT', `/templates/${t}/channels`, {
      channels: { apple: 'off' },
      orgId: kit.org.id,
    });
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'on' } });
    await call('PUT', `/passes/${other.id}/channels`, { channels: { apple: 'on' } });
    await setting(`org:${kit.org.id}`, 'channels.blocked', ['apple']);
    const blocked = (await (await call('GET', `/passes/${pass.id}/channels`)).json()) as {
      effective: Record<string, unknown>;
      overrides: object;
    };
    expect(blocked.effective.apple).toEqual({ on: false, source: 'org', reason: 'blocked' });
    expect(blocked.overrides).toEqual({ apple: 'on' });
    await run(kit.env.DB, "DELETE FROM settings WHERE key = 'channels.blocked'");
    clearSettingsCache(kit.env.DB);
    const restored = (await (
      await call('GET', `/passes/${pass.id}/channels`)
    ).json()) as typeof blocked;
    expect(restored.effective.apple).toEqual({ on: true, source: 'pass' });

    const dry = (await (
      await call('PUT', `/templates/${t}/channels`, {
        channels: { apple: 'never' },
        dryRun: true,
        orgId: kit.org.id,
      })
    ).json()) as { impact: { clearedOverrides: number; passes: number }[] };
    expect(dry.impact[0]).toMatchObject({ clearedOverrides: 2, passes: 2 });
    await call('PUT', `/templates/${t}/channels`, {
      channels: { apple: 'never' },
      orgId: kit.org.id,
    });
    const left = await rows(
      "SELECT override FROM pass_channels WHERE channel = 'apple' AND override IS NOT NULL AND template_id = ?",
      t,
    );
    expect(left).toEqual([]);
    const after = (await (
      await call('GET', `/passes/${pass.id}/channels`)
    ).json()) as typeof blocked;
    expect(after.effective.apple).toEqual({ on: false, source: 'template', reason: 'never' });
    expect(after.overrides).toEqual({});
    const audit = await rows(
      "SELECT detail FROM audit_log WHERE action = 'template.channels_change'",
    );
    expect(JSON.parse(audit.at(-1)?.detail as string)).toMatchObject({ cleared: 2 });
  });

  it('turns paper on for a pass once the platform allows printing', async () => {
    const { pass, call, setting } = await setup();
    await setting('platform', 'print.enabled', true);
    const res = await call('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
    const body = (await res.json()) as { effective: Record<string, unknown> };
    expect(body.effective.paper).toEqual({ on: true, source: 'pass' });
  });

  it('bulk sets and resets many passes', async () => {
    const { pass, other, call } = await setup();
    const ids = [pass.id, other.id];
    const off = await call('POST', '/passes/bulk/channels', {
      action: 'off',
      channels: ['apple', 'mobile'],
      ids,
    });
    expect(await off.json()).toEqual({ done: 2, skipped: [], operationId: null });
    const one = (await (await call('GET', `/passes/${other.id}/channels`)).json()) as {
      effective: Record<string, { on: boolean }>;
    };
    expect(one.effective.mobile?.on).toBe(false);
    await call('POST', '/passes/bulk/channels', {
      action: 'reset',
      channels: ['apple', 'mobile'],
      ids,
    });
    const back = (await (await call('GET', `/passes/${other.id}/channels`)).json()) as typeof one;
    expect(back.effective.mobile?.on).toBe(true);
  });

  it('rate-limits override changes per pass', async () => {
    const { pass, call } = await setup();
    let last = 200;
    for (let i = 0; i < 21; i++)
      last = (
        await call('PUT', `/passes/${pass.id}/channels`, {
          channels: { apple: i % 2 ? 'on' : 'off' },
        })
      ).status;
    expect(last).toBe(429);
  });

  it('refuses replace codes on a template whose barcode is not the scan code', async () => {
    const { pass, call } = await setup();
    const res = await call('PUT', `/templates/${pass.templateId}/channels`, {
      channels: { apple: 'off' },
      replaceCodes: true,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NEW_CODE_UNSUPPORTED' });
  });
});

describe('channel permissions and isolation', () => {
  it('template writes need a member with templates:publish; no API key writes', async () => {
    const { kit, pass, call, count } = await setup();
    const t = pass.templateId;
    const before = await count('template_channel_policies');
    const key = await kit.auth.apiKey({
      orgId: kit.org.id,
      scopes: ['passes:write', 'passes:read', 'templates:read'],
    });
    expect([401, 403]).toContain(
      (
        await call(
          'PUT',
          `/templates/${t}/channels`,
          { channels: { apple: 'off' }, orgId: kit.org.id },
          key,
        )
      ).status,
    );
    const stranger = kit.auth.user();
    expect(
      (
        await call(
          'PUT',
          `/templates/${t}/channels`,
          { channels: { apple: 'off' }, orgId: kit.org.id },
          stranger,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call('GET', `/templates/${t}/channels?orgId=${kit.org.id}`, undefined, stranger))
        .status,
    ).toBe(404);
    expect(await count('template_channel_policies')).toBe(before);
  });

  it('a pass override needs passes:write on a key and membership on a session', async () => {
    const { kit, pass, call } = await setup();
    const readOnly = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    expect([401, 403]).toContain(
      (await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off' } }, readOnly))
        .status,
    );
    expect((await call('GET', `/passes/${pass.id}/channels`, undefined, readOnly)).status).toBe(
      200,
    );
    const writer = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    expect(
      (await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off' } }, writer))
        .status,
    ).toBe(200);
    expect([403, 404]).toContain(
      (await call('GET', `/passes/${pass.id}/channels`, undefined, kit.auth.user())).status,
    );
    expect([403, 404]).toContain(
      (
        await call(
          'PUT',
          `/passes/${pass.id}/channels`,
          { channels: { apple: 'off' } },
          kit.auth.user(),
        )
      ).status,
    );
  });

  it('a key of another org cannot read or write', async () => {
    const { kit, pass, call } = await setup();
    const foreign = await kit.auth.apiKey({
      orgId: (await makeOrg(kit.fx)).id,
      scopes: ['passes:write', 'passes:read'],
    });
    for (const method of ['GET', 'PUT'])
      expect([403, 404]).toContain(
        (
          await call(
            method,
            `/passes/${pass.id}/channels`,
            method === 'PUT' ? { channels: { apple: 'off' } } : undefined,
            foreign,
          )
        ).status,
      );
  });

  it('the database refuses rows across org, mode or template, and a moved copy_at', async () => {
    const { kit, pass } = await setup();
    const db = kit.env.DB;
    await expect(
      run(
        db,
        "INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, set_by, set_at) VALUES (?, 'org-x', 'live', ?, 'apple', 'u', 1)",
        [pass.id, pass.templateId],
      ),
    ).rejects.toThrow();
    await expect(
      run(
        db,
        "INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, set_by, set_at) VALUES (?, ?, 'test', ?, 'apple', 'u', 1)",
        [pass.id, pass.orgId, pass.templateId],
      ),
    ).rejects.toThrow();
    await run(
      db,
      "INSERT INTO pass_channel_copies (pass_id, org_id, mode, channel, copy_at) VALUES (?, ?, 'live', 'apple', 5)",
      [pass.id, pass.orgId],
    );
    await expect(
      run(db, 'UPDATE pass_channel_copies SET copy_at = 9 WHERE pass_id = ?', [pass.id]),
    ).rejects.toThrow();
    await expect(
      run(
        db,
        "INSERT INTO template_channel_policies (org_id, mode, template_id, channels, updated_by, updated_at) VALUES ('org-x', 'live', ?, '{}', 'u', 1)",
        [pass.templateId],
      ),
    ).rejects.toThrow();
  });
});

describe('review fixes', () => {
  it('refuses a stale template revision (M5) and bumps it on save', async () => {
    const { pass, call } = await setup();
    const t = pass.templateId;
    const first = (await (
      await call('PUT', `/templates/${t}/channels`, { channels: { apple: 'off' }, revision: 0 })
    ).json()) as { revision: number };
    expect(first.revision).toBe(1);
    const stale = await call('PUT', `/templates/${t}/channels`, {
      channels: { google: 'off' },
      revision: 0,
    });
    expect(stale.status).toBe(409);
    const fresh = (await (
      await call('PUT', `/templates/${t}/channels`, { channels: { google: 'off' }, revision: 1 })
    ).json()) as { revision: number; channels: object };
    expect(fresh.revision).toBe(2);
    expect(fresh.channels).toEqual({ apple: 'off', google: 'off' });
  });

  it('a grant-level stale revision also aborts the clearing of overrides (M5)', async () => {
    const { pass, call, rows } = await setup();
    const t = pass.templateId;
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'on' } });
    await call('PUT', `/templates/${t}/channels`, { channels: { samsung: 'off' }, revision: 0 });
    const res = await call('PUT', `/templates/${t}/channels`, {
      channels: { apple: 'never' },
      revision: 0,
    });
    expect(res.status).toBe(409);
    const left = await rows(
      "SELECT override FROM pass_channels WHERE pass_id = ? AND channel = 'apple'",
      pass.id,
    );
    expect(left[0]?.override).toBe('on');
  });

  it('refuses a save whose cleared-override count drifted since the dry run', async () => {
    const { pass, other, call, rows } = await setup();
    const t = pass.templateId;
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'on' } });
    const dry = (await (
      await call('PUT', `/templates/${t}/channels`, { channels: { apple: 'never' }, dryRun: true })
    ).json()) as { impact: { clearedOverrides: number }[] };
    expect(dry.impact[0]?.clearedOverrides).toBe(1);
    // Another admin overrides a second pass after the dry run.
    await call('PUT', `/passes/${other.id}/channels`, { channels: { apple: 'on' } });
    const res = await call('PUT', `/templates/${t}/channels`, {
      channels: { apple: 'never' },
      expectedCleared: 1,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('TEMPLATE_CHANNELS_IMPACT_CHANGED');
    const left = await rows(
      "SELECT override FROM pass_channels WHERE channel = 'apple' AND override IS NOT NULL AND template_id = ?",
      t,
    );
    expect(left).toHaveLength(2);
    const ok = await call('PUT', `/templates/${t}/channels`, {
      channels: { apple: 'never' },
      expectedCleared: 2,
    });
    expect(ok.status).toBe(200);
  });

  it('never in test mode keeps live overrides (L9)', async () => {
    const { kit, pass, call, rows } = await setup();
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'on' } });
    const res = await call(
      'PUT',
      `/templates/${pass.templateId}/channels`,
      { channels: { apple: 'never' } },
      kit.auth.admin({ mode: 'test' }),
    );
    expect(res.status).toBe(200);
    const live = await rows(
      "SELECT override, revision FROM pass_channels WHERE pass_id = ? AND channel = 'apple'",
      pass.id,
    );
    expect(live[0]?.override).toBe('on');
  });

  it('never bumps pass_channels.revision and audits override-only changes (L1, L2)', async () => {
    const { pass, call, rows } = await setup();
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'on' } });
    const audit = await rows(
      "SELECT detail FROM audit_log WHERE action = 'pass.channels_change' AND target_id = ?",
      pass.id,
    );
    expect(JSON.parse(audit[0]?.detail as string)).toMatchObject({
      channel: 'apple',
      override: { from: null, to: 'on' },
    });
    const before = await rows(
      "SELECT revision FROM pass_channels WHERE pass_id = ? AND channel = 'apple'",
      pass.id,
    );
    await call('PUT', `/templates/${pass.templateId}/channels`, { channels: { apple: 'never' } });
    const after = await rows(
      "SELECT revision, override FROM pass_channels WHERE pass_id = ? AND channel = 'apple'",
      pass.id,
    );
    expect(after[0]?.override).toBeNull();
    expect(Number(after[0]?.revision)).toBeGreaterThan(Number(before[0]?.revision));
  });

  it('bulk across orgs is not found (L9)', async () => {
    const { kit, pass, call } = await setup();
    const org2 = await makeOrg(kit.fx);
    const foreign = await makePass(kit.fx, {
      orgId: org2.id,
      template: await kit.registry.resolve(kit.dated.id),
    });
    const res = await call('POST', '/passes/bulk/channels', {
      action: 'off',
      channels: ['apple'],
      ids: [pass.id, foreign.id],
    });
    expect(res.status).toBe(404);
  });

  it('only baked or shared active platform templates are visible (M2)', async () => {
    const { kit, call, rows } = await setup();
    const insert = (id: string, org: string | null, extra: string) =>
      run(
        kit.env.DB,
        `INSERT INTO templates (id, org_id, slug, name, origin, status, created_at, updated_at${extra ? `, ${extra.split('=')[0]}` : ''})
         VALUES (?, ?, ?, 'T', ?, 'active', 1, 1${extra ? `, ${extra.split('=')[1]}` : ''})`,
        [id, org, id, id.startsWith('up') ? 'uploaded' : 'baked'],
      );
    await insert('up-private', null, '');
    await insert('up-shared', null, 'shared=1');
    await insert('bp-one', null, 'blueprint=1');
    const view = (id: string) => call('GET', `/templates/${id}/channels`);
    expect((await view('up-private')).status).toBe(404);
    expect((await view('bp-one')).status).toBe(404);
    expect((await view('up-shared')).status).toBe(200);
    await expect(
      run(
        kit.env.DB,
        "INSERT INTO template_channel_policies (org_id, mode, template_id, channels, updated_by, updated_at) VALUES (?, 'live', 'up-private', '{}', 'u', 1)",
        [kit.org.id],
      ),
    ).rejects.toThrow();
    expect(
      await rows('SELECT 1 FROM template_channel_policies WHERE template_id = ?', 'up-private'),
    ).toEqual([]);
  });

  it('another org gets not found for an org-owned template (L6)', async () => {
    const { kit, call } = await setup();
    const org2 = await makeOrg(kit.fx);
    await run(
      kit.env.DB,
      "INSERT INTO templates (id, org_id, slug, name, origin, status, created_at, updated_at) VALUES ('own-t', ?, 'own-t', 'T', 'uploaded', 'active', 1, 1)",
      [org2.id],
    );
    const key = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['templates:read'] });
    expect((await call('GET', '/templates/own-t/channels', undefined, key)).status).toBe(404);
    expect(
      (await call('GET', '/templates/own-t/channels', undefined, kit.auth.admin())).status,
    ).toBe(404);
  });

  it('reads capability from the org release (M3)', async () => {
    const { kit, pass } = await setup();
    const version = await releasedVersion(kit.env.DB, pass.templateId, pass.orgId, 'live');
    expect(version).toBe(pass.templateVersion);
  });
});
