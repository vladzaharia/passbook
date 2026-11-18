import { systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { problemResponse } from '../../platform/errors.ts';
import { createDetachedContext, type ServiceContext } from '../../platform/service-context.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { cloneLiveAttachment, type LiveAttachment } from './live-auth.ts';
import { LIVE_ROW_TTL_MS, type LiveRingRow, ringRowOf } from './live-ring.ts';
import { staleScanRead } from './stale-read.ts';

export const RING = 'recent';
/** A device's control socket is tagged apart from screens, so the screen cap never counts or closes it. */
export const DEVICE_TAG = 'dev:';
export const deviceTag = (scannerId: string) => `${DEVICE_TAG}${scannerId}`;

/** Pin one key ring for every asynchronous live operation. */
export function liveContext(env: AppEnv, callerNow?: number) {
  // The caller's request clock, carried as an offset so time still advances inside the call. A
  // Durable Object has no request clock of its own; without one it reads the system clock.
  const offset = callerNow === undefined ? 0 : callerNow - systemClock.now();
  const ctx = createDetachedContext(
    env,
    callerNow === undefined ? {} : { clock: { now: () => systemClock.now() + offset } },
  );
  return { ...ctx, env: snapshotCredentialEnv(env) };
}

/** The unexpired ring, oldest first; an entry from before plain rows is kept as a redacted row. */
export async function readRing(storage: DurableObjectStorage, now: number): Promise<LiveRingRow[]> {
  const stored = (await storage.get<unknown[]>(RING)) ?? [];
  return stored
    .map(ringRowOf)
    .filter((r): r is LiveRingRow => r !== null && now - r.row.at < LIVE_ROW_TTL_MS);
}

/** A sealed attachment the hub no longer serves: lost access is a bare 401, drift a 409 to reconnect. */
export async function refusedUpgrade(
  ctx: ServiceContext,
  attachment: LiveAttachment,
): Promise<Response> {
  const captured = cloneLiveAttachment(attachment);
  if (!captured || captured.expiresAt <= ctx.clock.now())
    return new Response(null, { status: 401 });
  const refusal = await staleScanRead(ctx, captured.actor);
  return refusal.status === 409 ? problemResponse(refusal) : new Response(null, { status: 401 });
}
