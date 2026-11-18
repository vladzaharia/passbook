import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
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
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let base: AppEnv;
beforeAll(async () => {
  base = await makeEnv();
});

describe('pass list: no scan in N days', () => {
  it('leaves out passes scanned in the window, and refuses event targets', async () => {
    const clock = new ManualClock(Date.now());
    const f = fixtures(base, clock);
    const org = await makeOrg(f);
    const other = await makeOrg(f);
    const tpl = makeTemplate({ id: `scan-${f.ids.id()}`, orgId: org.id });
    const scanned = await makePass(f, { orgId: org.id, template: tpl.resolved });
    const quiet = await makePass(f, { orgId: org.id, template: tpl.resolved });
    const staleScan = await makePass(f, { orgId: org.id, template: tpl.resolved });
    const insert = (orgId: string, passId: string, at: number) => {
      const id = crypto.randomUUID();
      return run(
        env.DB,
        `INSERT INTO scans (id, org_id, mode, pass_id, template_id, actor_type, actor_id, actor_key,
           idempotency_key, request_hash, method, state, outcome, action_kind, at)
         VALUES (?, ?, 'live', ?, ?, 'system', 's', ?, ?, 'h', 'manual', 'done', 'ok', 'check_in', ?)`,
        [id, orgId, passId, tpl.resolved.id, id, `k-${id}`, at],
      );
    };
    await insert(org.id, scanned.id, clock.now());
    await insert(org.id, staleScan.id, clock.now() - 100 * 86_400_000);
    const person = await makeUser(f);
    const invitation = f.ids.id();
    const roles = JSON.stringify(['read_only']);
    await run(
      env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
      [
        invitation,
        org.id,
        roles,
        f.ids.token(),
        clock.now(),
        clock.now() + 3_600_000,
        clock.now(),
        person.id,
      ],
    );
    await run(
      env.DB,
      'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [f.ids.id(), org.id, person.id, invitation, roles, clock.now()],
    );
    const list = (scan: unknown, orgId = org.id) =>
      app.request(
        `/api/v1/passes?orgId=${orgId}&scan=${encodeURIComponent(JSON.stringify(scan))}`,
        { headers: fake.user(person.id) },
        base,
      );
    const res = await list({ noScanDays: 90 });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { items: { id: string }[] }).items.map((p) => p.id).sort();
    expect(ids).toEqual([quiet.id, staleScan.id].sort());
    expect(ids).not.toContain(scanned.id);
    // A scan in another org never counts: the clause is tied to the pass's own org.
    await insert(other.id, quiet.id, clock.now());
    const again = ((await (await list({ noScanDays: 90 })).json()) as { items: { id: string }[] })
      .items;
    expect(again.map((p) => p.id)).toContain(quiet.id);
    await expectProblem(await list({ eventId: 'e1', checkedIn: true }), 422, 'VALIDATION');
  });
});
