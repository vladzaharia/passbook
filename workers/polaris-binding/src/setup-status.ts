import { parseClient, readProvider } from './client-dto.ts';
import { meta } from './ledger.ts';
import { failure, ok } from './pocket-http.ts';
import { assertTokenHashes, sha256Hex } from './policy.ts';
import { passbookOrigin } from './registry.ts';
import { planRoles } from './setup-groups.ts';
import type { SetupRpc, SetupStatus } from './setup-types.ts';
import type { Shared } from './shared.ts';

/**
 * One read of everything setup needs to decide: the PassBook client, its SCIM connection and the unplaced role
 * groups. Polaris ID answers the SCIM token in clear: it is hashed here, compared with the caller's hashes and
 * dropped. The answer says which of two hashes matched, never the token.
 */
export function setupStatusApi(s: Shared): Pick<SetupRpc, 'setupStatus'> {
  const { env, r, call, gate } = s;
  return {
    async setupStatus(opts) {
      const m = meta('setupStatus');
      const hashes = await call.guard(m, () =>
        assertTokenHashes((opts as { tokenHashes?: unknown } | undefined)?.tokenHashes),
      );
      const { registry } = await gate.readable();
      return call.ledgered('setup_read', m, async (req): Promise<SetupStatus> => {
        const { roles } = await planRoles(s, req, registry);
        const status: SetupStatus = {
          client: {
            found: false,
            cimd: false,
            ours: false,
            restricted: false,
            missingRoles: [],
            otherGroups: 0,
            logo: false,
            darkLogo: false,
          },
          roles,
          scim: { exists: false, endpointOk: false, token: null, lastSyncedAt: null },
        };
        const res = await req('GET', r.client(env.PASSBOOK_CLIENT_ID));
        if (res.status === 404) return status;
        if (!ok(res)) throw failure(res);
        const c = parseClient(res.body);
        status.client = {
          found: true,
          cimd: c.clientType === 'cimd',
          ours: c.id === env.PASSBOOK_CLIENT_ID,
          restricted: c.restricted,
          missingRoles: [
            ...new Set(
              registry.entries.filter((e) => !c.allowed.includes(e.id)).map((e) => e.role),
            ),
          ],
          otherGroups: c.allowed.filter((id) => !registry.allIds.includes(id)).length,
          logo: c.hasLogo,
          darkLogo: c.hasDarkLogo,
        };
        const p = await readProvider(s, req);
        if (!p) return status;
        const origin = passbookOrigin(env.PASSBOOK_CLIENT_ID);
        const at = hashes.indexOf(await sha256Hex(p.token));
        status.scim = {
          exists: true,
          endpointOk: origin !== null && p.endpoint === `${origin}/scim/v2`,
          token: !hashes.length ? null : at === 0 || at === 1 ? at : 'other',
          lastSyncedAt: p.lastSyncedAt,
        };
        return status;
      });
    },
  };
}
