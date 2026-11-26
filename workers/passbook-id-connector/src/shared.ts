import type { Call } from './call.ts';
import type { Gate } from './health.ts';
import type { Deps } from './pocket-http.ts';
import type { Routes } from './routes.ts';
import type { BindingEnv } from './types.ts';

/** What every RPC group needs. Built once per request in api.ts. */
export interface Shared {
  env: BindingEnv;
  deps: Deps;
  db: D1Database;
  r: Routes;
  call: Call;
  gate: Gate;
  /** Whether writes are only computed: `WRITE_MODE` is not `live`, or the caller asked for a dry run. */
  dry(callerWants: boolean): boolean;
}
