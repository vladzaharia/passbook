import type { Actor } from '../../platform/context.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ConnectionAuthority } from './access.ts';
import type { ConnectionRow } from './repo.ts';
import { adminBucketMs, adminInstanceId, startSync } from './schedule.ts';

/** Starts the run that lists a connection from the start after an edit cleared its cursor. */
export async function startRelist(
  sctx: ServiceContext,
  actor: Actor,
  conn: ConnectionRow,
  authority?: ConnectionAuthority,
): Promise<void> {
  const instanceId = await adminInstanceId(conn, sctx.clock.now(), adminBucketMs(sctx.env));
  await startSync(sctx, conn, 'admin', instanceId, actor.id, authority);
}
