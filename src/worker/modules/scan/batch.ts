import type { z } from 'zod';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type {
  ScanBatchRequestSchema,
  ScanBatchResultSchema,
} from '../../../shared/contracts/scan-session.ts';
import {
  CLIENT_TS_MAX_AGE_MS,
  CLIENT_TS_SLACK_MS,
  offlineModeOf,
} from '../../../shared/scan-offline.ts';
import { safeEqualBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { act } from './act.ts';
import { type ScanActor, scopeSessionId } from './actor.ts';
import { deepFreeze } from './freeze.ts';
import { requireOfflineQueue } from './offline-policy.ts';
import { unknownOutcome } from './outcome.ts';
import { markScanOffline } from './repo-act-claim.ts';
import { offlineReadScan, recordOfflineRead } from './repo-roster.ts';
import { rosterSig } from './roster.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
} from './scanning-workspace-observation.ts';
import { openAt } from './session-hours.ts';

type Request = z.infer<typeof ScanBatchRequestSchema>;
type Item = Request['items'][number];
type Result = z.infer<typeof ScanBatchResultSchema>['items'][number];
type Door = NonNullable<Item['door']>;

/**
 * What a batch may carry out of the server: the verdict and nothing of the holder. A queued read
 * never sees a card, a value or a screen, so a stolen device learns no more by syncing than by scanning.
 */
const bare = (o: ScanOutcome): ScanOutcome => ({
  ...o,
  card: null,
  display: null,
  value: null,
  access: null,
  admit: null,
  tag: null,
  occupancy: null,
});

/**
 * How the server will treat the door's own word for a read. Nothing here lets a read in: `act`
 * decides every item again from the live pass. This only labels the record and refuses a read made
 * on a list that had already expired.
 *  - `refused`: the door turned the code away. It is recorded and never acted on.
 *  - `listed`: counts only under the offline list mode and a roster stamp this server signed.
 *  - anything else is `unverified`.
 */
async function doorOf(
  ctx: ServiceContext,
  actor: ScanActor,
  item: Item,
  roster: Request['roster'],
): Promise<{ door: Door; expired: boolean }> {
  if (item.door === 'refused') return { door: 'refused', expired: false };
  if (item.door !== 'listed' || offlineModeOf(actor.settings) !== 'list' || !roster)
    return { door: 'unverified', expired: false };
  const want = await rosterSig(ctx, actor, roster.asOf, roster.validUntil);
  const enc = new TextEncoder();
  if (!safeEqualBytes(enc.encode(want), enc.encode(roster.sig)))
    return { door: 'unverified', expired: false };
  return { door: 'listed', expired: item.clientTs > roster.validUntil };
}

/**
 * Was the session taking reads at `t`? Once it is paused, ended or on Stop, a read made before that change
 * still counts (the door was right to take it); one made after is recorded as ended. The change is dated by
 * the session's last edit. Closed hours are read at the read's own time.
 */
export function sessionAcceptsAt(actor: ScanActor, t: number): boolean {
  const changedAt = actor.scanningSession?.updatedAt ?? actor.scanner?.updatedAt ?? 0;
  const live =
    (actor.scanningSession ? actor.scanningSession.status === 'active' : true) &&
    offlineModeOf(actor.settings) !== 'stop';
  if (!live && t >= changedAt) return false;
  const parent = captureObservedScanningSession(actor)?.parent;
  return !parent || openAt(parent, t);
}

const endedOutcome = (at: number): ScanOutcome => ({
  ...unknownOutcome().outcome,
  kind: 'heads_up',
  reason: 'ended',
  at,
});

/**
 * `POST /batch`: a device's queued reads, oldest first, each through the same `act` as an online scan
 * under its own idempotency key. First scan wins across every door, online or not: a read that loses
 * (pass voided, already in elsewhere, not found) is recorded as such and returned as a `conflict`.
 *  - Stop refuses the whole batch.
 *  - A read stamped over 5 minutes ahead is clamped to now; one older than the roster's life is
 *    recorded as `ended` and changes nothing.
 *  - An upload repeated whole or in part returns the first answers.
 */
export async function syncBatch(
  ctx: ServiceContext,
  actor: ScanActor,
  request: Request,
): Promise<{ items: Result[] }> {
  requireOfflineQueue(actor);
  const now = ctx.clock.now();
  const order = request.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.clientTs - b.item.clientTs || a.index - b.index);
  const results: Result[] = [];
  for (const { item, index } of order) {
    const { door, expired } = await doorOf(ctx, actor, item, request.roster);
    const clientTs = item.clientTs > now + CLIENT_TS_SLACK_MS ? now : item.clientTs;
    let outcome: ScanOutcome;
    let scanId: string | null = null;
    const taken =
      door === 'refused' ||
      sessionAcceptsAt(actor, clientTs) ||
      (await offlineReadScan(ctx.env.DB, actor.actorKey, item.idempotencyKey)) !== null;
    if (door === 'refused') outcome = bare(unknownOutcome().outcome);
    else if (expired || !taken || now - item.clientTs > CLIENT_TS_MAX_AGE_MS)
      outcome = endedOutcome(item.clientTs);
    else {
      // The daily gate is the day the door read the code, not the day it synced.
      const done = await act(
        ctx,
        deepFreeze({ ...cloneObservedScanActor(actor), gateAt: clientTs }),
        {
          idempotencyKey: item.idempotencyKey,
          input: { code: item.code, method: item.method },
          clientTs,
          actionId: 'auto',
          ...(item.direction ? { direction: item.direction } : {}),
        },
      );
      outcome = bare(done.outcome);
      scanId = outcome.scanId;
      if (scanId) await markScanOffline(ctx.env.DB, scanId, door);
    }
    const conflict = door !== 'refused' && outcome.kind !== 'ok';
    await recordOfflineRead(ctx.env.DB, {
      id: ctx.ids.id(),
      actorKey: actor.actorKey,
      idempotencyKey: item.idempotencyKey,
      orgId: actor.orgId,
      mode: actor.mode,
      sessionId: scopeSessionId(actor),
      scannerId: actor.scanner?.id ?? null,
      door,
      scanId,
      outcome: outcome.kind === 'ok' || outcome.kind === 'heads_up' ? outcome.kind : 'refused',
      reason: outcome.reason,
      conflict,
      clientTs: item.clientTs,
      recordedTs: outcome.at ?? clientTs,
      syncedAt: now,
    });
    results[index] = { idempotencyKey: item.idempotencyKey, outcome, conflict };
  }
  return { items: results };
}
