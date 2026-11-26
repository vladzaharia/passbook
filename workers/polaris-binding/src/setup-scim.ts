import { readClient, readProvider } from './client-dto.ts';
import { meta } from './ledger.ts';
import { failure, ok } from './pocket-http.ts';
import { assertScimToken, refuse, sha256Hex } from './policy.ts';
import { passbookOrigin } from './registry.ts';
import { setupRunner } from './setup-shell.ts';
import type { SetupRpc } from './setup-types.ts';
import type { Shared } from './shared.ts';
import { IdpError } from './types.ts';

type ScimApi = Pick<SetupRpc, 'ensureScim' | 'syncScim'>;

/** Polaris ID answers the push inline, so only the sync waits this long. */
const SYNC_TIMEOUT_MS = 30_000;

/**
 * PassBook's SCIM connection in Polaris ID. The endpoint is PassBook's own `/scim/v2`, derived from the client id:
 * no caller value can point the directory anywhere else. Never deletes; a provider the owner pointed elsewhere is
 * refused, not overwritten.
 */
export function setupScimApi(s: Shared): ScimApi {
  const { env, r, call } = s;
  const run = setupRunner(s);
  const endpointOf = (): string => {
    const origin = passbookOrigin(env.PASSBOOK_CLIENT_ID);
    return origin ? `${origin}/scim/v2` : refuse('The client id has no origin.');
  };

  return {
    async ensureScim(token, ctx) {
      const tok = await call.guard(meta('ensureScim'), () => assertScimToken(token));
      return run(
        { method: 'ensureScim', delta: 'scim', lease: 'scim', bucket: 'scim_write' },
        ctx,
        async ({ req, dry, note }) => {
          const endpoint = endpointOf();
          // Only a restricted client: an open one would push every account.
          if (!(await readClient(s, req)).restricted)
            throw new IdpError('IDP_CLIENT', 'client_open');
          const live = await readProvider(s, req);
          const want = await sha256Hex(tok);
          if (live && live.endpoint !== endpoint)
            throw new IdpError('IDP_SCIM_FOREIGN', 'scim_endpoint_foreign');
          if (live && (await sha256Hex(live.token)) === want)
            return { result: 'already' as const, dryRun: dry };
          const result = live ? ('rotated' as const) : ('created' as const);
          if (dry) {
            await note();
            return { result, dryRun: true };
          }
          const body = { endpoint, token: tok, oidcClientId: env.PASSBOOK_CLIENT_ID };
          const res = live
            ? await req('PUT', r.scim(live.id), body)
            : await req('POST', r.scimCreate, body);
          if (!ok(res)) throw failure(res);
          const after = await readProvider(s, req);
          if (!after || after.endpoint !== endpoint || (await sha256Hex(after.token)) !== want)
            throw new IdpError('IDP_DRIFT', 'The SCIM connection did not come back as written.');
          return { result, dryRun: false };
        },
      );
    },

    syncScim: (ctx) =>
      run(
        { method: 'syncScim', delta: 'scim_sync', lease: 'scim', bucket: 'scim_sync' },
        ctx,
        async ({ req, dry, note }) => {
          const live = await readProvider(s, req);
          if (!live) throw new IdpError('IDP_NOT_FOUND', 'no_scim_provider');
          if (live.endpoint !== endpointOf())
            throw new IdpError('IDP_SCIM_FOREIGN', 'scim_endpoint_foreign');
          if (dry) {
            await note();
            return { result: 'synced' as const, dryRun: true };
          }
          const res = await req('POST', r.scimSync(live.id), undefined, SYNC_TIMEOUT_MS);
          // Polaris ID's own text is never forwarded.
          if (!ok(res)) throw new IdpError('IDP_UPSTREAM', `Polaris ID answered ${res.status}.`);
          return { result: 'synced' as const, dryRun: false };
        },
      ),
  };
}
