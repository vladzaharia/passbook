import { writeEvent } from '../../platform/analytics.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { registrationCountStmt } from '../apple/repo.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { recordPassEvents } from '../events/record.ts';
import { syncDevicePasses } from '../workbench/device-pass-sync.ts';
import { notifiesHolder } from './change-messages.ts';
import type { PublishOptions, PublishResult } from './publish.ts';
import type { PreparedPublishAttempt } from './publish-flow-prepare.ts';
import { getPassStmt, passFromResult } from './repo-read-pass.ts';

/** Revalidate the committed pass before recording delivery events and scheduling dispatch. */
export async function completePublishAttempt(
  ctx: ServiceContext,
  options: PublishOptions,
  prepared: PreparedPublishAttempt,
  written: number,
  silenced: boolean,
): Promise<PublishResult> {
  const db = ctx.env.DB;
  const { current, next, artifact, previousParsed, credentialKeysetCommitment } = prepared;
  const pushes = options.cause !== 'resign';
  const [passResult, devicesResult] = await db.batch([
    getPassStmt(db, current.id),
    ...(pushes ? [registrationCountStmt(db, current.id)] : []),
  ]);
  const pass = passFromResult(passResult);
  const devices = (devicesResult?.results?.[0] as { n: number } | undefined)?.n ?? 0;
  if (
    !pass ||
    (options.connectionContext &&
      (pass.version !== written ||
        pass.linkGeneration !== current.linkGeneration ||
        pass.identityId !== current.identityId ||
        pass.credentialGeneration !== current.credentialGeneration ||
        pass.lifecycleGeneration !==
          current.lifecycleGeneration +
            (next.status !== current.status && current.removedAt === null ? 1 : 0) ||
        pass.holderEmail !== current.holderEmail ||
        pass.ownerUserId !== current.ownerUserId ||
        pass.serial !== current.serial ||
        pass.authToken !== current.authToken))
  )
    throw new ConflictError('The connection or pass changed. Retry.', 'PASS_CONFLICT');
  writeEvent(ctx.env, {
    event: 'pass.updated',
    orgId: pass.orgId,
    templateId: pass.templateId,
    identityId: pass.identityId,
    outcome: options.cause,
    mode: pass.mode,
  });
  const base = { orgId: pass.orgId, passId: pass.id, mode: pass.mode };
  await recordPassEvents(ctx, [
    {
      ...base,
      kind: 'pass.updated',
      actor: options.actor,
      data: {
        version: pass.version,
        cause: options.cause,
        source: options.source ?? null,
        // Only a resign skips the push; a push carries a message when a field with one changed.
        notified: pushes && notifiesHolder(artifact.passJson, previousParsed),
        ...(silenced ? { overBudget: true } : {}),
      },
    },
    ...(pushes
      ? [
          {
            ...base,
            kind: 'push.queued' as const,
            data: { version: pass.version, devices },
          },
        ]
      : []),
  ]);
  if (options.dispatch !== false) ctx.waitUntil(dispatchSafely(ctx, { passId: pass.id }));
  // A developer's device passes of this Test pass stand for the new version (a no-op while they are off).
  if (pushes) ctx.waitUntil(syncDevicePasses(ctx, pass));
  return {
    pass,
    changed: true,
    credentialKeysetCommitment,
    passJson: prepared.passJson,
    ...(silenced ? { silenced } : {}),
  };
}
