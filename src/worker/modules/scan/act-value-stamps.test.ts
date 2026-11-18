import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { releaseStamps, stampCard, stampVersion } from '../passes/stamps-test-fixtures.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';

beforeAll(setupActionFixture);

let sequence = 0;
/** A scanner and a Stamp card at `stamps` stamps, on a card with the given goal. */
async function setup(stamps: number, goal = 10) {
  const id = `stamps-${sequence++}-${kit.fx.ids.token(3)}`;
  await stampVersion(kit, id, 'v1', goal);
  const release = await releaseStamps(kit, id, 'v1');
  const pass = await stampCard(kit, release, stamps);
  const s = await kit.scanner({ templateIds: [id], settings: { roleWithoutSignIn: 'desk' } });
  const scan = (actionId: string, over: Record<string, unknown> = {}) =>
    act(s.headers, { code: pass.scanCode ?? '', method: 'camera' }, { actionId, ...over });
  return { pass, scan };
}
const stampsOf = async (passId: string) =>
  (
    await rows<{ personalization: string }>('SELECT personalization FROM passes WHERE id = ?', [
      passId,
    ])
  ).map((r) => (JSON.parse(r.personalization) as { stamps: number }).stamps)[0];
const alerts = (passId: string) =>
  rows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pass_events WHERE pass_id = ? AND kind = 'pass.updated' AND json_extract(data, '$.notified') = 1",
    [passId],
  ).then((r) => r[0]?.n ?? 0);

describe('stamp card scans', () => {
  it('adds stamps; only the one that fills the card alerts, and it alerts once', async () => {
    const { pass, scan } = await setup(7);
    const first = await out(await scan('stamp', { amount: 2 }));
    expect(first).toMatchObject({ kind: 'ok', value: { before: 7, after: 9, goal: 10 } });
    expect(first.milestone).toBeNull();
    expect(await alerts(pass.id)).toBe(0);
    kit.clock.advance(6 * 60_000);
    const fills = await out(await scan('stamp'));
    expect(fills).toMatchObject({
      kind: 'ok',
      value: { before: 9, after: 10 },
      milestone: 'reward',
    });
    expect(await alerts(pass.id)).toBe(1);
    kit.clock.advance(6 * 60_000);
    await scan('stamp');
    expect(await stampsOf(pass.id)).toBe(11);
    expect(await alerts(pass.id)).toBe(1);
  });

  it('alerts the stamp that fills a card even at the daily push limit', async () => {
    const { pass, scan } = await setup(9);
    for (let i = 0; i < 3; i++)
      await run(
        kit.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
         VALUES (?, ?, ?, 'live', 'pass.updated', '{"notified":1}', ?)`,
        [kit.fx.ids.id(), kit.org.id, pass.id, kit.clock.now()],
      );
    expect(await alerts(pass.id)).toBe(3);
    expect((await out(await scan('stamp'))).kind).toBe('ok');
    expect(await alerts(pass.id)).toBe(4);
  });

  it('refuses card_full at the maximum, with no partial add', async () => {
    const { pass, scan } = await setup(18);
    const over = await out(await scan('stamp', { amount: 2 }));
    expect(over).toMatchObject({ kind: 'refused', reason: 'card_full', value: { after: 18 } });
    expect(await stampsOf(pass.id)).toBe(18);
    expect((await out(await scan('stamp', { amount: 1 }))).kind).toBe('ok');
    kit.clock.advance(6 * 60_000);
    expect((await out(await scan('stamp'))).reason).toBe('card_full');
    expect(await stampsOf(pass.id)).toBe(19);
  });

  it('caps an add at the maximum of a release waiting to reissue the card', async () => {
    const id = `stamps-cap-${sequence++}-${kit.fx.ids.token(3)}`;
    await stampVersion(kit, id, 'v1', 10);
    const first = await releaseStamps(kit, id, 'v1');
    const pass = await stampCard(kit, first, 8);
    await stampVersion(kit, id, 'v2', 5);
    await releaseStamps(kit, id, 'v2');
    const s = await kit.scanner({ templateIds: [id], settings: { roleWithoutSignIn: 'desk' } });
    const over = await out(
      await act(
        s.headers,
        { code: pass.scanCode ?? '', method: 'camera' },
        { actionId: 'stamp', amount: 2 },
      ),
    );
    expect(over).toMatchObject({ kind: 'refused', reason: 'card_full' });
    expect(await stampsOf(pass.id)).toBe(8);
  });

  it('lists the redeem action on the ready card of a template with a field called reward', async () => {
    const { pass } = await setup(3);
    const s = await kit.scanner({
      templateIds: [pass.templateId],
      settings: { flow: 'choose', roleWithoutSignIn: 'desk' },
    });
    const o = await out(
      await act(s.headers, { code: pass.scanCode ?? '', method: 'camera' }, { actionId: 'auto' }),
    );
    expect(o.card?.actions.map((a) => a.label)).toEqual(['Add stamp', 'Redeem reward']);
  });

  it('redeems the goal by default, carries the extra over and refuses a short card', async () => {
    const { pass, scan } = await setup(12);
    const redeemed = await out(await scan('redeem'));
    expect(redeemed).toMatchObject({ kind: 'ok', value: { before: 12, after: 2, goal: 10 } });
    expect(await stampsOf(pass.id)).toBe(2);
    const short = await out(await scan('redeem'));
    expect(short).toMatchObject({ kind: 'refused', reason: 'no_balance', value: { after: 2 } });
    expect(short.value).not.toHaveProperty('counter');
    expect(await stampsOf(pass.id)).toBe(2);
  });

  it('shows "1 reward ready · 2 saved" on the card it just stamped', async () => {
    const { scan } = await setup(11);
    const o = await out(await scan('stamp'));
    expect(o.kind).toBe('ok');
    const progress = o.display?.panels
      .flatMap((p) => p.rows)
      .find((row) => row.type === 'progress');
    expect(progress).toMatchObject({
      type: 'progress',
      value: 12,
      before: 11,
      goal: 10,
      rewards: 1,
      caption: '1 reward ready · 2 saved',
    });
  });

  it('lays a card of 16 out as discs and one of 17 as a bar', async () => {
    const { scan: scan16 } = await setup(3, 16);
    const { scan: scan17 } = await setup(3, 17);
    const style = async (go: (id: string) => Promise<Response>) => {
      const o = await out(await go('stamp'));
      return o.display?.panels.flatMap((p) => p.rows).find((row) => row.type === 'progress');
    };
    expect(await style(scan16)).toMatchObject({ goal: 16, style: 'stamps' });
    expect(await style(scan17)).toMatchObject({ goal: 17, style: 'bar' });
  });
});
