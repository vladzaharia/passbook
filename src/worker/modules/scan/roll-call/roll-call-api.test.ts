import { beforeAll, describe, expect, it } from 'vitest';
import type { RollCall } from '../../../../shared/contracts/scan-roll-call.ts';
import {
  DISPLAY_TPL,
  personInside,
  presenceOf,
  station,
  trackedZone,
  useKit,
} from '../occupancy/whos-in-test-fixtures.ts';
import { scanningSessionsFixture } from '../scanning-sessions-test-fixtures.ts';

const fixture = scanningSessionsFixture();
let tpl: string;
beforeAll(async () => {
  await fixture.setup();
  useKit(fixture.kit);
  fixture.fake.bindApiKeys(fixture.kit.env, fixture.kit.clock);
  tpl = await fixture.kit.scanTemplate('Gym', DISPLAY_TPL as never);
});

const org = () => fixture.kit.org.id;
const q = (extra = '') => `?orgId=${org()}${extra}`;

describe('roll call API: console and keys', () => {
  it('a signed-in admin starts, confirms and ends a call over every tracked zone', async () => {
    const zone = await trackedZone();
    const p = await personInside(tpl, 'Ana', [`zone:${zone.id}`]);
    const started = await fixture.call('POST', `/roll-calls${q()}`, {});
    expect(started.status).toBe(200);
    const call = (await started.json()) as RollCall;
    expect(call.counts.total).toBeGreaterThanOrEqual(1);
    const marked = await fixture.call('POST', `/roll-calls/${call.id}/marks${q()}`, {
      marks: [{ rollCallId: call.id, passId: p.id, status: 'present' }],
    });
    expect(marked.status).toBe(200);
    expect(((await marked.json()) as RollCall).counts.present).toBe(1);
    const ended = await fixture.call('POST', `/roll-calls/${call.id}/end${q()}`, {});
    expect(((await ended.json()) as RollCall).endedAt).not.toBeNull();
    const audits = await fixture.kit.env.DB.prepare(
      'SELECT action FROM audit_log WHERE target_id = ? ORDER BY at',
    )
      .bind(call.id)
      .all<{ action: string }>();
    expect(audits.results.map((r) => r.action)).toEqual(['rollcall.start', 'rollcall.end']);
  });

  /** A scanner in its own session over `zone`, and a till key bound to it (the binding trigger is for minting). */
  async function boundKey(zoneId: string) {
    const s = await station([tpl], [zoneId]);
    const key = fixture.fake.apiKey({ orgId: org(), scopes: ['scans:write', 'scans:read'] });
    expect(
      (await fixture.call('GET', `/roll-calls/none`, undefined, key)).status,
    ).toBeGreaterThanOrEqual(400);
    const row = await fixture.kit.env.DB.prepare(
      "SELECT id FROM api_keys WHERE org_id = ? AND scopes LIKE '%scans:write%' AND scopes LIKE '%scans:read%' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
      .bind(org())
      .first<{ id: string }>();
    await fixture.kit.env.DB.exec('DROP TRIGGER IF EXISTS api_key_terminals_new_key_only');
    await fixture.kit.env.DB.prepare(
      'INSERT INTO api_key_terminals (key_id, scanner_id) VALUES (?, ?)',
    )
      .bind(row?.id, s.scanner.id)
      .run();
    return { key, sessionId: s.sessionId };
  }

  it('keys: scans:read reads; a till key reaches only its terminals sessions, and none reaches another org', async () => {
    const zone = await trackedZone();
    const other = await trackedZone();
    const p = await personInside(tpl, 'Key Person', [`zone:${zone.id}`]);
    const reader = fixture.fake.apiKey({ orgId: org(), scopes: ['scans:read'] });
    const foreign = fixture.fake.apiKey({ orgId: 'some-other-org', scopes: ['scans:write'] });
    const { key, sessionId } = await boundKey(zone.id);
    const elsewhere = (await station([tpl], [other.id])).sessionId;
    expect((await fixture.call('POST', '/roll-calls', {}, reader)).status).toBe(403);
    // Not its session, and not the whole org: not found.
    expect((await fixture.call('POST', `/roll-calls?sessionId=${elsewhere}`, {}, key)).status).toBe(
      404,
    );
    expect((await fixture.call('POST', '/roll-calls', {}, key)).status).toBe(404);
    const started = await fixture.call('POST', `/roll-calls?sessionId=${sessionId}`, {}, key);
    expect(started.status, await started.clone().text()).toBe(200);
    const call = (await started.json()) as RollCall;
    // Another session's call is not found to it, though an org admin starts and reads it.
    const foreignCall = (await (
      await fixture.call('POST', `/roll-calls${q(`&sessionId=${elsewhere}`)}`, {})
    ).json()) as RollCall;
    expect(
      (await fixture.call('GET', `/roll-calls/${foreignCall.id}`, undefined, key)).status,
    ).toBe(404);
    expect((await fixture.call('POST', `/roll-calls/${foreignCall.id}/end`, {}, key)).status).toBe(
      404,
    );
    expect((await fixture.call('GET', `/roll-calls/${call.id}`, undefined, reader)).status).toBe(
      200,
    );
    expect((await fixture.call('POST', `/roll-calls/${call.id}/end`, {}, reader)).status).toBe(403);
    const crossed = await fixture.call('GET', `/roll-calls/${call.id}${q()}`, undefined, foreign);
    expect(crossed.status).toBeGreaterThanOrEqual(403);
    expect(await crossed.text()).not.toContain('Key Person');
    const marked = await fixture.call(
      'POST',
      `/roll-calls/${call.id}/marks`,
      { marks: [{ rollCallId: call.id, passId: p.id, status: 'present' }] },
      key,
    );
    expect(marked.status).toBe(200);
    expect((await fixture.call('POST', `/roll-calls/${call.id}/end`, {}, key)).status).toBe(200);
  });

  it('a till key starts a call under api=off (scanning.devices governs it) but is gated as API elsewhere', async () => {
    const zone = await trackedZone();
    const { key, sessionId } = await boundKey(zone.id);
    const db = fixture.kit.env.DB;
    await db
      .prepare(
        "INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'api', '\"off\"', 1)",
      )
      .bind(org())
      .run();
    try {
      const started = await fixture.call('POST', `/roll-calls?sessionId=${sessionId}`, {}, key);
      expect(started.status, await started.clone().text()).toBe(200);
      const call = (await started.json()) as RollCall;
      expect((await fixture.call('POST', `/roll-calls/${call.id}/end`, {}, key)).status).toBe(200);
      // A route that does not opt in: the same key is API and refused.
      const scans = await fixture.call('GET', `/scans${q()}`, undefined, key);
      expect(scans.status).toBe(403);
      expect(((await scans.json()) as { code: string }).code).toBe('FEATURE_NOT_INCLUDED');
    } finally {
      await db.prepare('DELETE FROM org_entitlement_overrides WHERE org_id = ?').bind(org()).run();
    }
  });

  it('an admin Out exits the person; a key Out is a confirmation alone', async () => {
    const zone = await trackedZone();
    const a = await personInside(tpl, 'Admin Out', [`zone:${zone.id}`]);
    const b = await personInside(tpl, 'Key Out', [`zone:${zone.id}`]);
    const { key, sessionId } = await boundKey(zone.id);
    const call = (await (
      await fixture.call('POST', `/roll-calls${q(`&sessionId=${sessionId}`)}`, {})
    ).json()) as RollCall;
    await fixture.call('POST', `/roll-calls/${call.id}/marks${q()}`, {
      marks: [{ rollCallId: call.id, passId: a.id, status: 'out' }],
    });
    await fixture.call(
      'POST',
      `/roll-calls/${call.id}/marks`,
      { marks: [{ rollCallId: call.id, passId: b.id, status: 'out' }] },
      key,
    );
    const st = async (id: string) => (await presenceOf(id, `zone:${zone.id}`))[0]?.state;
    expect(await st(a.id)).toBe('out');
    expect(await st(b.id)).toBe('in');
  });

  it('a user with no org membership gets nothing', async () => {
    const res = await fixture.call('GET', `/roll-calls${q()}`, undefined, fixture.userHeaders);
    expect(res.status).toBeGreaterThanOrEqual(403);
  });
});
