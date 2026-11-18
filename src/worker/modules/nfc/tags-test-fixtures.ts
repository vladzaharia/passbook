import { makeOrg, makePass, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { run } from '../../platform/db.ts';
import { resolveSession } from '../auth/sessions.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { tagAuthorityOf } from './tags-admin.ts';

/** A kit, and orgs with an operator who can bind tags. One kit per test file: D1 lasts for the file. */
export async function tagFixture(options: { releases?: boolean } = {}) {
  const kit: Kit = await setupKit({ approvedReleases: options.releases === true });
  let uid = 0;

  async function org(options: { enabled?: boolean } = {}) {
    const row = await makeOrg(kit.fx);
    if (options.enabled !== false)
      await run(
        kit.env.DB,
        "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'nfc.tags', '{\"enabled\":true}', 1)",
        [`org:${row.id}`],
      );
    const operator = await makeUser(kit.fx);
    await grantKitMembership(kit, row.id, operator.id, ['pass_operator']);
    const session = await makeSession(kit.fx, { userId: operator.id, roles: ['user'] });
    const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
    if (!resolved) throw new Error('The operator session did not resolve.');
    return {
      org: row,
      operator,
      headers: session.headers,
      async authority(mode: Mode = 'live') {
        return tagAuthorityOf(
          await tenantAuthorityOf(kit.ctx, { ...resolved, mode }, row.id, 'passes:operate'),
        );
      },
    };
  }

  const pass = (
    orgId: string,
    options: { ownerUserId?: string | null; holderEmail?: string | null; mode?: Mode } = {},
  ) => makePass(kit.fx, { orgId, template: kit.template, persist: false, ...options });

  /** A fresh 7-byte UID as hex. */
  const nextUid = () => `04${(++uid).toString(16).padStart(12, '0')}`;

  return { kit, org, pass, nextUid, user: () => makeUser(kit.fx) };
}
