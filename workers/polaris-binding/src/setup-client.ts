import { echoBody, readClient, sameFields } from './client-dto.ts';
import { aliasIds } from './group-find.ts';
import { failure, ok } from './pocket-http.ts';
import { refuse, sameSet } from './policy.ts';
import { passbookOrigin, type Registry } from './registry.ts';
import { setupRunner } from './setup-shell.ts';
import type { SetupRpc } from './setup-types.ts';
import type { Shared } from './shared.ts';
import { invalidateHealth } from './store.ts';
import { IdpError } from './types.ts';

type ClientApi = Pick<SetupRpc, 'allowClientGroups' | 'restrictClient' | 'setClientLogo'>;

/** The configured roles that have no group yet. The PassBook client cannot allow a role it does not have. */
export function unplacedRoles(registry: Registry): string[] {
  const placed = new Set(registry.entries.map((e) => e.role));
  return [
    ...new Set([...registry.unplaced, ...registry.unplacedProtected].map((u) => u.role)),
  ].filter((role) => !placed.has(role));
}

const LOGO_PATH = '/icons/icon-512.png';

/**
 * Three writes on PassBook's own client, none taking an id or a URL. They only tighten: groups are a union,
 * the restriction is only ever set to `true`, and the logo URL is PassBook's own origin and a fixed path.
 */
export function setupClientApi(s: Shared): ClientApi {
  const { db, env, r } = s;
  const run = setupRunner(s);

  return {
    allowClientGroups: (ctx) =>
      run(
        {
          method: 'allowClientGroups',
          delta: 'client_groups',
          lease: 'setup:client',
          bucket: 'client_write',
          fresh: true,
          check: (registry) => {
            if (unplacedRoles(registry).length) refuse('A role group is not placed.');
          },
        },
        ctx,
        async ({ req, dry, registry, note }) => {
          const client = await readClient(s, req);
          // Union only: what the owner allowed stays; PassBook's registry groups and the alias groups that exist are added.
          const aliases = await aliasIds(s.r, req, registry.aliases);
          const want = [...new Set([...client.allowed, ...registry.ids, ...aliases])];
          const added = want.length - client.allowed.length;
          if (!added) return { result: 'already' as const, added: 0, dryRun: dry };
          if (dry) {
            await note();
            return { result: 'allowed' as const, added, dryRun: true };
          }
          const res = await req('PUT', r.clientGroups(env.PASSBOOK_CLIENT_ID), {
            userGroupIds: want,
          });
          if (!ok(res)) throw failure(res);
          const back = await readClient(s, req);
          if (!sameSet(back.allowed, want))
            throw new IdpError('IDP_DRIFT', 'The client groups did not come back as written.');
          await invalidateHealth(db);
          return { result: 'allowed' as const, added, dryRun: false };
        },
      ),

    restrictClient: (ctx) =>
      run(
        {
          method: 'restrictClient',
          delta: 'client_restrict',
          lease: 'setup:client',
          bucket: 'client_write',
          fresh: true,
        },
        ctx,
        async ({ req, dry, registry, note }) => {
          const client = await readClient(s, req);
          if (client.restricted) return { result: 'already' as const, dryRun: dry };
          // Restricted with the admin group missing from the allowed set would lock every platform admin out.
          // The same goes for an alias group (`wallet_org_admins`) the main Worker's sign-in still accepts.
          const aliases = await aliasIds(s.r, req, registry.aliases);
          if (
            !registry.adminIds.length ||
            ![...registry.adminIds, ...aliases].every((id) => client.allowed.includes(id))
          )
            throw new IdpError('IDP_CLIENT', 'client_lockout');
          const body = echoBody(client);
          if (dry) {
            await note();
            return { result: 'restricted' as const, dryRun: true };
          }
          const res = await req('PUT', r.client(env.PASSBOOK_CLIENT_ID), body);
          if (!ok(res)) throw failure(res);
          const back = await readClient(s, req);
          if (
            !back.restricted ||
            !sameFields(echoBody(back), body) ||
            !sameSet(back.allowed, client.allowed)
          )
            throw new IdpError('IDP_DRIFT', 'The client did not come back as written.');
          await invalidateHealth(db);
          return { result: 'restricted' as const, dryRun: false };
        },
      ),

    setClientLogo: (ctx) =>
      run(
        {
          method: 'setClientLogo',
          delta: 'client_logo',
          lease: 'setup:client',
          bucket: 'client_write',
        },
        ctx,
        async ({ req, dry, note }) => {
          const origin = passbookOrigin(env.PASSBOOK_CLIENT_ID);
          if (!origin) return refuse('The client id has no origin.');
          const client = await readClient(s, req);
          if (client.hasLogo && client.hasDarkLogo)
            return { result: 'already' as const, dryRun: dry };
          // Every body carries `isGroupRestricted: true`: on an open client that would restrict it unguarded.
          if (!client.restricted) throw new IdpError('IDP_CLIENT', 'client_open');
          const url = `${origin}${LOGO_PATH}`;
          const body = echoBody(client, {
            ...(client.hasLogo ? {} : { logoUrl: url }),
            ...(client.hasDarkLogo ? {} : { darkLogoUrl: url }),
          });
          if (dry) {
            await note();
            return { result: 'set' as const, dryRun: true };
          }
          const res = await req('PUT', r.client(env.PASSBOOK_CLIENT_ID), body);
          if (!ok(res)) throw failure(res);
          const back = await readClient(s, req);
          if (
            !back.hasLogo ||
            !back.hasDarkLogo ||
            !back.restricted ||
            !sameFields(echoBody(back), echoBody(client), ['hasLogo', 'hasDarkLogo']) ||
            !sameSet(back.allowed, client.allowed)
          )
            throw new IdpError('IDP_DRIFT', 'The client did not come back as written.');
          return { result: 'set' as const, dryRun: false };
        },
      ),
  };
}
