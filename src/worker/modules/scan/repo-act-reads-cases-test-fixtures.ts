import { expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { act, kit, out, tpl } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerReads() {
  it('stats, scans and summary describe what this scanner did', async () => {
    const s = await kit.scanner({ templateIds: [tpl] });
    const [p, q] = [await kit.scanPass(tpl), await kit.scanPass(tpl)];
    for (const input of [
      codeOf(p),
      codeOf(p),
      codeOf(q),
      { code: 'ZZZZ-2222', method: 'camera' },
    ]) {
      await act(s.headers, input);
      kit.clock.advance(1000);
    }
    const stats = (await (await kit.get(s.headers, '/stats')).json()) as { today: number };
    expect(stats.today).toBe(2);
    const recent = (await (await kit.get(s.headers, '/scans?limit=3')).json()) as {
      items: { outcome: string; actionLabel: string; title: string | null; undoable: boolean }[];
    };
    expect(recent.items).toHaveLength(3);
    expect(recent.items[0]).toMatchObject({ outcome: 'refused' });
    expect(recent.items.find((i) => i.outcome === 'ok')).toMatchObject({
      actionLabel: 'Check in',
      title: 'Anna Popescu',
      undoable: true,
    });
    const summary = (await (await kit.get(s.headers, '/summary')).json()) as Record<
      string,
      unknown
    >;
    expect(summary).toMatchObject({
      total: 4,
      ok: 2,
      headsUp: 1,
      refused: 1,
      undone: 0,
      byAction: [{ actionId: 'check_in', label: 'Check in', count: 2 }],
    });
  });

  it('an admin acts under u:<id> with the org in scope', async () => {
    const pass = await kit.scanPass(tpl);
    const res = await kit.post(kit.admin(), '/actions', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
      scope: { orgId: kit.org.id, templateIds: [tpl], timeZone: 'UTC' },
    });
    expect((await out(res)).kind).toBe('ok');
    const row = await first<{ actor_key: string; actor_type: string }>(
      kit.env.DB,
      "SELECT actor_key, actor_type FROM scans WHERE actor_key LIKE 'u:%' ORDER BY at DESC LIMIT 1",
    );
    expect(row).toEqual({ actor_key: 'u:admin-1', actor_type: 'user' });
  });
}
