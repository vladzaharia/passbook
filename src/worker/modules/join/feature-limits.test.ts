import { beforeAll, describe, expect, it } from 'vitest';
import { limitSuite, refusedWhen, setLimit } from '../../../../test/helpers/index.ts';
import { makeJoinLink } from '../../../../test/helpers/join.ts';
import { first } from '../../platform/db.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { withinCaps } from './caps.ts';
import { joinTemplate } from './join-test-fixtures.ts';

let kit: Kit;
let link: Awaited<ReturnType<typeof makeJoinLink>>;
const DAY = 86_400_000;

beforeAll(async () => {
  kit = await setupKit({ template: (id) => joinTemplate(id) });
  link = await makeJoinLink(kit.fx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    dailyLimit: 5000,
  });
});

/** One card from the public link, as the submit path makes it. */
const join = () =>
  refusedWhen(async () => {
    if (!kit.liveRelease) throw new Error('release');
    await createPassRow(kit.ctx, {
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: kit.liveRelease.version,
      input: { memberName: 'Joined Guest' },
      source: 'manual',
      mode: 'live',
      execution: { kind: 'join', linkId: link.id, generation: link.generation, orgDailyCap: 1000 },
      actor: { type: 'system', id: `join:${link.id}` },
    });
  });

const issuedToday = async () =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      "SELECT COUNT(*) AS n FROM join_issues WHERE org_id = ? AND mode = 'live' AND created_at > ?",
      [kit.org.id, kit.clock.now() - DAY],
    )
  )?.n ?? 0;

const livePasses = async () =>
  (
    await first<{ n: number }>(
      kit.env.DB,
      `SELECT COUNT(*) AS n FROM passes WHERE org_id = ? AND mode = 'live' AND removed_at IS NULL
        AND deleted_at IS NULL AND test_data_quarantined = 0`,
      [kit.org.id],
    )
  )?.n ?? 0;

// A visitor is told the day's limit is reached, never the organization's plan.
limitSuite(
  'join passes per day',
  async () => ({
    db: kit.env.DB,
    orgId: kit.org.id,
    key: 'join.perDay',
    create: join,
    count: issuedToday,
  }),
  { code: 'JOIN_LIMIT', plain: true },
);

limitSuite(
  'live passes through a join link',
  async () => ({
    db: kit.env.DB,
    orgId: kit.org.id,
    key: 'passes.live',
    create: join,
    count: livePasses,
  }),
  { code: 'JOIN_LIMIT', plain: true },
);

describe('join limits', () => {
  it('the refusal a visitor can reach carries no limit, count or feature', async () => {
    await setLimit(kit.env.DB, kit.org.id, 'join.perDay', 0);
    const refused = await join();
    expect(refused?.code).toBe('JOIN_LIMIT');
    expect(refused?.feature).toBeUndefined();
    expect(refused?.limit).toBeUndefined();
    expect(refused?.used).toBeUndefined();
  });

  it('the pre-check reads the plan, and a limit of 0 turns the link off', async () => {
    const row = {
      id: link.id,
      orgId: kit.org.id,
      mode: 'live' as const,
      dailyLimit: 5000,
    };
    await setLimit(kit.env.DB, kit.org.id, 'join.perDay', null);
    expect(await withinCaps(kit.ctx, row, 1000)).toBe(true);
    await setLimit(kit.env.DB, kit.org.id, 'join.perDay', await issuedToday());
    expect(await withinCaps(kit.ctx, row, 1000)).toBe(false);
    await setLimit(kit.env.DB, kit.org.id, 'join.perDay', 0);
    expect(await withinCaps(kit.ctx, row, 1000)).toBe(false);
    expect((await join())?.code).toBe('JOIN_LIMIT');
  });
});
