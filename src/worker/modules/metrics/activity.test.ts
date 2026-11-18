import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { OrgActivitySchema } from '../../../shared/contracts/metrics.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { clearActivityCache } from './activity.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let base: AppEnv;
beforeAll(async () => {
  base = await makeEnv();
});
beforeEach(() => clearActivityCache(env.DB));

async function join(f: ReturnType<typeof fixtures>, orgId: string, userId: string, role: string) {
  const now = f.clock.now();
  const roles = JSON.stringify([role]);
  const invitation = f.ids.id();
  await run(
    f.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitation, orgId, roles, f.ids.token(), now, now + 3_600_000, now, userId],
  );
  await run(
    f.env.DB,
    'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [f.ids.id(), orgId, userId, invitation, roles, now],
  );
}

async function scan(orgId: string, passId: string, templateId: string, kind: string, at: number) {
  const id = crypto.randomUUID();
  await run(
    env.DB,
    `INSERT INTO scans (id, org_id, mode, pass_id, template_id, actor_type, actor_id, actor_key,
       idempotency_key, request_hash, method, state, outcome, action_kind, at)
     VALUES (?, ?, 'live', ?, ?, 'system', 's', ?, ?, 'h', 'manual', 'done', 'ok', ?, ?)`,
    [id, orgId, passId, templateId, `k-${id}`, id, kind, at],
  );
}

async function setup() {
  const clock = new ManualClock(Date.now());
  const f = fixtures(base, clock);
  const org = await makeOrg(f);
  const device = f.ids.id();
  const other = await makeOrg(f);
  const tpl = makeTemplate({ id: `act-${f.ids.id()}`, orgId: org.id });
  const added = await makePass(f, { orgId: org.id, template: tpl.resolved });
  const waiting = await makePass(f, { orgId: org.id, template: tpl.resolved });
  const removed = await makePass(f, { orgId: org.id, template: tpl.resolved });
  const otherTemplate = makeTemplate({ orgId: other.id });
  const foreign = await makePass(f, { orgId: other.id, template: otherTemplate.resolved });
  await run(
    env.DB,
    'INSERT INTO devices (device_id, identity_id, push_token, updated_at) SELECT ?, identity_id, ?, ? FROM passes WHERE id = ?',
    [device, 't', clock.now(), added.id],
  );
  await run(
    env.DB,
    'INSERT INTO registrations (device_id, identity_id, pass_id, created_at) SELECT ?, identity_id, id, ? FROM passes WHERE id = ?',
    [device, clock.now(), added.id],
  );
  await run(env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [clock.now(), removed.id]);
  // Deleted passes are not counted, as in the pass list.
  const gone = await makePass(f, { orgId: org.id, template: tpl.resolved });
  await run(env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [clock.now(), gone.id]);
  await scan(org.id, added.id, tpl.resolved.id, 'check_in', clock.now());
  await scan(org.id, added.id, tpl.resolved.id, 'use_up', clock.now());
  await scan(other.id, foreign.id, otherTemplate.resolved.id, 'use_up', clock.now());
  const reader = await makeUser(f);
  await join(f, org.id, reader.id, 'read_only');
  const author = await makeUser(f);
  await join(f, org.id, author.id, 'template_author');
  return { f, org, other, tpl, waiting, reader, author };
}

const get = (query: string, headers: Record<string, string>) =>
  app.request(`/api/v1/metrics/activity${query}`, { headers }, base);

describe('organization activity', () => {
  it('counts one org by template and keeps other orgs out', async () => {
    const s = await setup();
    const res = await get(`?orgId=${s.org.id}&range=24h`, fake.user(s.reader.id));
    expect(res.status).toBe(200);
    const data = OrgActivitySchema.parse(await res.json());
    expect(data.templates).toHaveLength(1);
    expect(data.templates[0]).toMatchObject({
      templateId: s.tpl.resolved.id,
      issued: 3,
      added: 1,
      removed: 1,
      scans: 2,
      redemptions: 1,
      inWallet: 1,
      notAdded: 1,
    });
    expect(data.totals).toMatchObject({ scans: 2, notAdded: 1, inWallet: 1 });
    expect(data.series.scans.reduce((n, p) => n + p.v, 0)).toBe(2);
  });

  it('is not found without org and pass read access', async () => {
    const s = await setup();
    const q = `?orgId=${s.org.id}`;
    await expectProblem(await get(q, fake.user(s.author.id)), 404, 'METRICS_NOT_FOUND');
    await expectProblem(
      await get(`?orgId=${s.other.id}`, fake.user(s.reader.id)),
      404,
      'METRICS_NOT_FOUND',
    );
    const admin = fake.session({ userId: s.author.id, roles: ['admin', 'user'] });
    await expectProblem(await get(`?orgId=${s.other.id}`, admin), 404, 'METRICS_NOT_FOUND');
    expect((await get(q, {})).status).toBe(401);
  });
});
