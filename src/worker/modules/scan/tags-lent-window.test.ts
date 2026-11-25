import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { handleLentWindow } from '../nfc/lent-window.ts';
import { publishPass } from '../passes/publish.ts';
import { updatePass } from '../passes/service.ts';
import { addType, clearTypes } from './tags-policy-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';

let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});
afterEach(() => {
  f.kit.clock.set(TEST_NOW);
  return clearTypes(f);
});

const HOUR = 3_600_000;
const guest = {
  actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  tags: { uses: ['staff', 'visitor'] },
  access: {
    input: { plan: 'tier', until: 'endsAt' },
    plans: [{ id: 'guest', label: 'Guest', kind: 'guest', zones: [{ zone: '*' }] }],
  },
} as const;

describe('a guest pass window that changes', () => {
  async function lent() {
    const tpl = await f.kit.scanTemplate('Visitor', guest as never);
    const type = await addType(f, { use: 'visitor', scopes: 'pass' });
    const s = await f.desk({ templateIds: [tpl] });
    const endsAt = f.kit.clock.now() + 2 * HOUR;
    const { card, pass } = await f.pass({
      template: tpl,
      input: { memberName: 'Leo Park', tier: 'guest', endsAt: new Date(endsAt).toISOString() },
    });
    const res = await f.bind(s, { card, typeId: type });
    const { bindingId } = (await res.json()) as { bindingId: string };
    return { pass, bindingId };
  }
  const expiry = async (id: string) =>
    (
      await first<{ expires_at: number | null }>(
        f.kit.env.DB,
        'SELECT expires_at FROM tag_bindings WHERE id = ?',
        [id],
      )
    )?.expires_at;
  const move = async (pass: { id: string; orgId: string }, endsAt: number) => {
    const ctx = jobCtxOf(f.kit);
    await updatePass(
      ctx,
      { type: 'system', id: null },
      pass.id,
      { input: { endsAt: new Date(endsAt).toISOString() } },
      { scope: null },
    );
    await handleLentWindow({ kind: 'tags.lent_window', passId: pass.id, orgId: pass.orgId }, ctx);
  };

  it('extending the window gives the tag a later expiry', async () => {
    const { pass, bindingId } = await lent();
    const later = f.kit.clock.now() + 5 * HOUR;
    await move(pass, later);
    expect(await expiry(bindingId)).toBe(later);
  });

  it('shortening the window gives the tag an earlier expiry', async () => {
    const { pass, bindingId } = await lent();
    const earlier = f.kit.clock.now() + HOUR / 2;
    await move(pass, earlier);
    expect(await expiry(bindingId)).toBe(earlier);
  });

  /** A job context whose queue records what it is sent. */
  const recording = () => {
    const sent: { kind?: string }[] = [];
    const base = jobCtxOf(f.kit);
    const ctx = {
      ...base,
      env: { ...f.kit.env, JOBS: { send: async (m: { kind?: string }) => void sent.push(m) } },
    } as unknown as typeof base;
    return { ctx, queued: () => sent.filter((m) => m.kind === 'tags.lent_window') };
  };

  it('queues the recompute only when the pass holds a lent tag', async () => {
    const tpl = await f.kit.scanTemplate('Visitor', guest as never);
    const bare = await f.pass({
      template: tpl,
      input: {
        memberName: 'No Tag',
        tier: 'guest',
        endsAt: new Date(TEST_NOW + HOUR).toISOString(),
      },
    });
    const { ctx, queued } = recording();
    const edit = (id: string) =>
      updatePass(
        ctx,
        { type: 'system', id: null },
        id,
        { input: { endsAt: new Date(TEST_NOW + 3 * HOUR).toISOString() } },
        { scope: null },
      );
    await edit(bare.pass.id);
    expect(queued()).toHaveLength(0);
    const { pass } = await lent();
    await edit(pass.id);
    expect(queued()).toEqual([{ kind: 'tags.lent_window', passId: pass.id, orgId: pass.orgId }]);
  });

  it('queues it from any publish, as an import or a sync does', async () => {
    const { pass } = await lent();
    const { ctx, queued } = recording();
    await publishPass(ctx, {
      orgScope: null,
      passId: pass.id,
      cause: 'api',
      actor: { type: 'system', id: null },
      dispatch: false,
      mutate: (current) => ({
        personalization: {
          ...current.personalization,
          endsAt: new Date(TEST_NOW + 4 * HOUR).toISOString(),
        },
      }),
    });
    expect(queued()).toHaveLength(1);
  });
});
