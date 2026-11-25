import { beforeAll, describe, expect, it } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { runOrgPurge } from '../../workflows/org-purge.ts';
import { fakeStep } from '../org-lifecycle/lifecycle-test-fixtures.ts';
import { PURGE_STEPS } from '../org-lifecycle/repo-plan.ts';
import { closeOrg } from '../org-lifecycle/service.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import {
  claim,
  developerInvitation,
  group,
  orgInvitation,
  platformInvitation,
  rule,
  sponsor,
} from './access-test-fixtures.ts';

const DAY = 86_400_000;
let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
}, 30_000);

const tableOrder = () =>
  PURGE_STEPS.flatMap((s) => (Array.isArray(s) ? s : [s])).map((s) => s.table);

describe('the purge plan for Polaris ID access', () => {
  it('removes a claim before the invitations it points at, and rules and setups before their org rows', () => {
    const order = tableOrder();
    const at = (t: string) => order.indexOf(t);
    expect(at('idp_invite_claims')).toBeGreaterThanOrEqual(0);
    expect(at('idp_invite_claims')).toBeLessThan(at('developer_invitations'));
    expect(at('idp_invite_claims')).toBeLessThan(at('org_invitations'));
    expect(at('org_invitation_setups')).toBeLessThan(at('org_invitations'));
    expect(at('idp_group_rules')).toBeGreaterThanOrEqual(0);
  });

  it('a purge removes the closed org’s rules, setups and claims and nothing of another org or the platform', async () => {
    const { kit } = rk;
    const person = (userId: string, subject: string) =>
      kit.env.DB.prepare(
        "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, 1)",
      )
        .bind(subject, userId)
        .run();
    const a = await rk.org(['org_admin']);
    const b = await rk.org(['org_admin']);
    // The purge needs the credential keyset a first pass creates.
    await kit.pass({ orgId: a.orgId });
    await person(a.userId, 'sub-purge-a');
    await person(b.userId, 'sub-purge-b');
    const platform = await rk.org(['org_admin']);
    await group(kit.fx, 'g_purge');
    await group(kit.fx, 'g_purge_b');
    const seed = async (orgId: string, userId: string, key: string, label: string) => {
      await rule(kit.fx, key, orgId, userId);
      const orgInv = await orgInvitation(kit.fx, orgId, `${label}@example.test`);
      await kit.env.DB.prepare(
        'INSERT INTO org_invitation_setups (idp_token_id, invitation_id, created_at, expires_at) VALUES (?, ?, 1, 2)',
      )
        .bind(`token-${label}`, orgInv)
        .run();
      await claim(kit.fx, { org: orgInv }, `claim-org-${label}`);
      const devInv = await developerInvitation(kit.fx, orgId, userId, {
        email: `${label}-dev@example.test`,
      });
      await claim(kit.fx, { developer: devInv }, `claim-dev-${label}`);
    };
    await seed(a.orgId, a.userId, 'g_purge', 'a');
    await seed(b.orgId, b.userId, 'g_purge_b', 'b');
    await sponsor(kit.fx, a.orgId, { id: a.userId, email: a.email, subject: 'sub-purge-a' });
    const platformInv = await platformInvitation(kit.fx, platform.userId, { groups: ['g_purge'] });
    await claim(kit.fx, { platform: platformInv }, 'claim-platform');

    const count = async (table: string, where: string, ...params: string[]) =>
      (
        await first<{ n: number }>(
          kit.env.DB,
          `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
          params,
        )
      )?.n;
    const orgOf = (id: string) => `(SELECT id FROM org_invitations WHERE org_id = '${id}')`;
    const tally = async (id: string) => ({
      rules: await count('idp_group_rules', 'org_id = ?', id),
      setups: await count('org_invitation_setups', `invitation_id IN ${orgOf(id)}`),
      claims: await count(
        'idp_invite_claims',
        `org_invitation_id IN ${orgOf(id)} OR developer_invitation_id IN (SELECT id FROM developer_invitations WHERE org_id = '${id}')`,
      ),
    });
    expect(await tally(a.orgId)).toEqual({ rules: 1, setups: 1, claims: 2 });
    const beforeB = await tally(b.orgId);

    await closeOrg(kit.ctx, { type: 'system', id: null }, a.orgId, {
      kind: 'platform',
      ...(await rk.platform()),
    });
    kit.clock.advance(31 * DAY);
    const result = await runOrgPurge(
      kit.env,
      { orgId: a.orgId },
      fakeStep(undefined, kit.clock),
      undefined,
      kit.clock,
      2,
    );
    expect(result.state).toBe('purged');

    expect(await tally(a.orgId)).toEqual({ rules: 0, setups: 0, claims: 0 });
    expect(await tally(b.orgId)).toEqual(beforeB);
    expect(await count('idp_invite_claims', "subject = 'claim-platform'")).toBe(1);
    expect(await count('idp_groups', "key = 'g_purge'")).toBe(1);
    expect(await all(kit.env.DB, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});
