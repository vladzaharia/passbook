import { beforeAll, describe, expect, it } from 'vitest';
import { stampRender } from '../passes/event-boundaries-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { act, kit, out, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);

const SET = { id: 'tier', label: 'Set tier', kind: 'set', input: 'tier', minRole: 'desk' } as const;
const tierOf = async (passId: string) => (await getPass(kit.env.DB, passId))?.personalization.tier;

// An event boundary renders the pass with no version (docs/design/event-boundaries.md): the door
// and its undo, which fence on the version, never see it.
describe('scan value fences after an event boundary', () => {
  it('a set with the card version read before the boundary is applied', async () => {
    const t = await kit.scanTemplate('Tier boundary', { actions: [SET] });
    const s = await kit.scanner({ templateIds: [t], settings: { roleWithoutSignIn: 'desk' } });
    const pass = await kit.scanPass(t, { tier: 'Silver' });
    await stampRender(kit.env, kit.clock, pass.id);
    const o = await out(
      await act(s.headers, codeOf(pass), {
        actionId: 'tier',
        value: 'Gold',
        expectedVersion: pass.version,
      }),
    );
    expect(o).toMatchObject({ kind: 'ok', value: { before: 'Silver', after: 'Gold' } });
    expect(await tierOf(pass.id)).toBe('Gold');
  });

  it('a set undone after the boundary goes back', async () => {
    const t = await kit.scanTemplate('Tier undo boundary', { actions: [SET] });
    const pass = await kit.scanPass(t, { tier: 'Silver' });
    const scope = { orgId: kit.org.id, timeZone: 'UTC' };
    const set = await out(
      await kit.post(kit.admin(), '/actions', {
        scope,
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'tier',
        value: 'Gold',
      }),
    );
    expect(set.kind).toBe('ok');
    await stampRender(kit.env, kit.clock, pass.id);
    const undone = await kit.post(kit.admin(), `/scans/${set.scanId}/undo`, {
      idempotencyKey: key(),
      scope,
    });
    expect(undone.status, await undone.clone().text()).toBe(200);
    expect(await tierOf(pass.id)).toBe('Silver');
  });
});
