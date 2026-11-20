import { beforeAll, describe, expect, it } from 'vitest';
import type { RollCall } from '../../../../shared/contracts/scan-roll-call.ts';
import {
  DISPLAY_TPL,
  personInside,
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
      marks: [{ passId: p.id, status: 'present' }],
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

  it('keys: scans:read reads, scans:write acts, and neither reaches another org', async () => {
    const zone = await trackedZone();
    await personInside(tpl, 'Key Person', [`zone:${zone.id}`]);
    const reader = fixture.fake.apiKey({ orgId: org(), scopes: ['scans:read'] });
    const writer = fixture.fake.apiKey({ orgId: org(), scopes: ['scans:write'] });
    const foreign = fixture.fake.apiKey({ orgId: 'some-other-org', scopes: ['scans:write'] });
    expect((await fixture.call('POST', '/roll-calls', {}, reader)).status).toBe(403);
    const started = await fixture.call('POST', '/roll-calls', {}, writer);
    expect(started.status, await started.clone().text()).toBe(200);
    const call = (await started.json()) as RollCall;
    expect((await fixture.call('GET', `/roll-calls/${call.id}`, undefined, reader)).status).toBe(
      200,
    );
    expect((await fixture.call('POST', `/roll-calls/${call.id}/end`, {}, reader)).status).toBe(403);
    const other = await fixture.call('GET', `/roll-calls/${call.id}${q()}`, undefined, foreign);
    expect(other.status).toBeGreaterThanOrEqual(403);
    expect(await other.text()).not.toContain('Key Person');
    expect((await fixture.call('POST', `/roll-calls/${call.id}/end`, {}, writer)).status).toBe(200);
  });

  it('a user with no org membership gets nothing', async () => {
    const res = await fixture.call('GET', `/roll-calls${q()}`, undefined, fixture.userHeaders);
    expect(res.status).toBeGreaterThanOrEqual(403);
  });
});
