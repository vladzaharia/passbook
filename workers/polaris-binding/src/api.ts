import { accountsApi } from './api-accounts.ts';
import { claimsApi } from './api-claims.ts';
import { directoryApi } from './api-directory.ts';
import { signupApi } from './api-groups.ts';
import { createCall } from './call.ts';
import { groupAdminApi } from './group-admin.ts';
import { createGate } from './health.ts';
import { readCalls } from './ledger.ts';
import type { Deps } from './pocket-http.ts';
import { routes } from './routes.ts';
import type { Shared } from './shared.ts';
import type { BindingEnv, IdpRpc } from './types.ts';

/** The binding's RPC methods over injectable I/O. The entrypoint class only delegates here. */
export function createApi(env: BindingEnv, deps: Deps): IdpRpc {
  const r = routes(env.POCKET_ID_API === 'admin' ? 'admin' : 'v2');
  const call = createCall(env, deps);
  const gate = createGate(env, deps, call, r);
  const shared: Shared = {
    env,
    deps,
    db: env.DB,
    r,
    call,
    gate,
    dry: (callerWants) => callerWants || env.WRITE_MODE !== 'live',
  };
  return {
    health: gate.health,
    ...signupApi(shared),
    ...accountsApi(shared),
    ...directoryApi(shared),
    ...groupAdminApi(shared),
    ...claimsApi(shared),
    calls: (since, afterId) => readCalls(env.DB, Number(since), Number(afterId ?? 0)),
  };
}
