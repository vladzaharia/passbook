import { describe, expect, it } from 'vitest';
import { linkToken, makeOrg } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { rotateLink } from '../passes/pass-service-delivery.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { HOLDER_PRINTS_PER_HOUR } from './service.ts';

const json = { 'content-type': 'application/json' };
const ORIGIN = 'https://wallet.test';
type Minted = { id: string; generation: number; status: string; code: string };

async function setup() {
  const kit = await ruleKit();
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
  const api = (method: string, path: string, body?: unknown, headers = kit.auth.admin()) =>
    kit.api(path, {
      method,
      headers: { ...headers, ...json },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const withPaper = async (holderEmail = 'holder@example.com') => {
    const pass = await kit.datedPass({}, holderEmail);
    const res = await api('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } });
    expect(res.status).toBe(200);
    return pass;
  };
  const tokenOf = (pass: { downloadToken: string }) => linkToken(kit.env, pass as never);
  const holder = (token: string, path = '', origin = ORIGIN) =>
    kit.app.request(
      `${ORIGIN}/p/${token}/print${path}`,
      { method: 'POST', headers: { origin } },
      kit.env,
    );
  const rows = (sql: string, ...p: string[]) => all<Record<string, unknown>>(kit.env.DB, sql, p);
  return { kit, api, withPaper, holder, tokenOf, rows };
}

describe('prints: mint, reprint, void', () => {
  it('mints a code that is never stored, lists without it, and voids the earlier print on reprint', async () => {
    const { api, withPaper, rows } = await setup();
    const pass = await withPaper();
    const first = (await (await api('POST', `/passes/${pass.id}/prints`)).json()) as Minted;
    expect(first.code).toMatch(/^P[A-Z2-7]{26}$/);
    expect(first).toMatchObject({ generation: 1, status: 'active' });
    const second = (await (await api('POST', `/passes/${pass.id}/prints`)).json()) as Minted;
    expect(second.generation).toBe(2);
    expect(second.code).not.toBe(first.code);

    const list = (await (await api('GET', `/passes/${pass.id}/prints`)).json()) as {
      prints: { id: string; status: string; voidCause: string | null }[];
    };
    expect(list.prints.map((p) => [p.id, p.status, p.voidCause])).toEqual([
      [second.id, 'active', null],
      [first.id, 'voided', 'replaced'],
    ]);
    const stored = JSON.stringify(
      await rows('SELECT * FROM pass_prints WHERE pass_id = ?', pass.id),
    );
    expect(stored).not.toContain(first.code);
    expect(stored).not.toContain(second.code);
    expect(JSON.stringify(list)).not.toContain(second.code);

    const audit = JSON.stringify(
      await rows(
        "SELECT detail FROM audit_log WHERE action LIKE 'pass.print%' AND target_id = ?",
        pass.id,
      ),
    );
    expect(audit).toContain(second.id);
    expect(audit).not.toContain(second.code);
    const events = await rows(
      "SELECT kind, data FROM pass_events WHERE pass_id = ? AND kind LIKE 'pass.print%' ORDER BY at, rowid",
      pass.id,
    );
    expect(events.map((e) => e.kind)).toEqual([
      'pass.printed',
      'pass.print_voided',
      'pass.printed',
    ]);
    expect(JSON.parse(events[1]?.data as string)).toEqual({ printId: first.id, cause: 'replaced' });
    expect(JSON.parse(events[2]?.data as string)).toMatchObject({ generation: 2, voided: 1 });
    expect(JSON.stringify(events)).not.toContain(second.code);
  });

  it('needs the paper channel on for the pass', async () => {
    const { kit, api } = await setup();
    const pass = await kit.datedPass();
    const res = await api('POST', `/passes/${pass.id}/prints`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PRINTING_OFF' });
  });

  it('voids by id, once, and ends the print when paper is turned off', async () => {
    const { api, withPaper } = await setup();
    const pass = await withPaper();
    const p = (await (await api('POST', `/passes/${pass.id}/prints`)).json()) as Minted;
    const done = await api('POST', `/passes/${pass.id}/prints/${p.id}/void`);
    expect(await done.json()).toMatchObject({ status: 'voided', voidCause: 'manual' });
    expect((await api('POST', `/passes/${pass.id}/prints/${p.id}/void`)).status).toBe(409);
    expect((await api('POST', `/passes/${pass.id}/prints/nope/void`)).status).toBe(404);

    const q = (await (await api('POST', `/passes/${pass.id}/prints`)).json()) as Minted;
    await api('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'off' } });
    const list = (await (await api('GET', `/passes/${pass.id}/prints`)).json()) as {
      prints: { id: string; voidCause: string | null }[];
    };
    expect(list.prints.find((x) => x.id === q.id)?.voidCause).toBe('channel_off');
  });
});

describe('prints: permissions', () => {
  it('needs passes:operate or a passes:write key; reads need passes:read; strangers see nothing', async () => {
    const { kit, api, withPaper } = await setup();
    const pass = await withPaper();
    const reader = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    const writer = await kit.auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    expect((await api('POST', `/passes/${pass.id}/prints`, undefined, reader)).status).toBe(403);
    expect((await api('GET', `/passes/${pass.id}/prints`, undefined, reader)).status).toBe(200);
    expect((await api('POST', `/passes/${pass.id}/prints`, undefined, writer)).status).toBe(200);
    const stranger = kit.auth.user();
    expect([403, 404]).toContain(
      (await api('POST', `/passes/${pass.id}/prints`, undefined, stranger)).status,
    );
    const foreign = await kit.auth.apiKey({
      orgId: (await makeOrg(kit.fx)).id,
      scopes: ['passes:write'],
    });
    expect([401, 403, 404]).toContain(
      (await api('POST', `/passes/${pass.id}/prints`, undefined, foreign)).status,
    );
  });

  it('a test-mode key cannot print a live pass', async () => {
    const { kit, api, withPaper } = await setup();
    const pass = await withPaper();
    const testKey = await kit.auth.apiKey({
      orgId: kit.org.id,
      scopes: ['passes:write'],
      mode: 'test',
    });
    expect([403, 404]).toContain(
      (await api('POST', `/passes/${pass.id}/prints`, undefined, testKey)).status,
    );
  });
});

describe('prints: holder', () => {
  it('mints on first use, returns the same print, reprints and voids, three changes an hour', async () => {
    const { withPaper, holder, tokenOf, rows } = await setup();
    const pass = await withPaper();
    const token = await tokenOf(pass);
    const first = (await (await holder(token)).json()) as Minted;
    const again = (await (await holder(token)).json()) as Minted;
    expect(again).toMatchObject({ id: first.id, code: first.code });
    const re = (await (await holder(token, '/reprint')).json()) as Minted;
    expect(re.generation).toBe(2);
    const voided = await holder(token, '/void');
    expect(await voided.json()).toMatchObject({ status: 'voided', voidCause: 'holder' });
    expect(HOLDER_PRINTS_PER_HOUR).toBe(3);
    const limited = await holder(token, '/reprint');
    expect(limited.status).toBe(429);
    const audit = await rows(
      "SELECT actor_type, actor_id FROM audit_log WHERE action = 'pass.print_void' AND target_id = ?",
      pass.id,
    );
    expect(audit[0]).toEqual({ actor_type: 'system', actor_id: `link:${pass.id}` });
    expect((await rows('SELECT 1 FROM pass_prints WHERE pass_id = ?', pass.id)).length).toBe(2);
  });

  it('refuses cross-origin posts, a rotated link and a voided pass', async () => {
    const { kit, withPaper, holder, tokenOf } = await setup();
    const pass = await withPaper();
    const token = await tokenOf(pass);
    expect((await holder(token, '', 'https://evil.example')).status).toBe(403);
    const ok = await holder(token);
    expect(ok.status).toBe(200);
    await rotateLink(jobCtxOf(kit), { type: 'user', id: 'admin-1' }, pass.id, null);
    expect((await holder(token)).status).toBe(404);
    const unknown = await kit.app.request(
      `${ORIGIN}/p/${'x'.repeat(30)}/print`,
      { method: 'POST', headers: { origin: ORIGIN } },
      kit.env,
    );
    expect(unknown.status).toBe(404);
  });

  it('needs paper on for the pass', async () => {
    const { kit, api, holder, tokenOf, withPaper } = await setup();
    const pass = await kit.datedPass({}, 'h@example.com');
    const res = await holder(await tokenOf(pass));
    expect(res.status).toBe(409);
    // An existing print's code is not returned once paper is off either.
    const on = await withPaper('h2@example.com');
    const token = await tokenOf(on);
    expect((await holder(token)).status).toBe(200);
    await api('PUT', `/passes/${on.id}/channels`, { channels: { paper: 'off' } });
    expect((await holder(token)).status).toBe(409);
  });
});
