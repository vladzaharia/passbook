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
import {
  offlineFloorOf,
  offlineReadRecorded,
  offlineReadScan,
  recordOfflineRead,
  type SessionChange,
  sessionChanges,
} from './repo-roster.ts';
import { rosterSig } from './roster.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
} from './scanning-workspace-observation.ts';
import { type HoursFields, openAt } from './session-hours.ts';

/**
 * Clock drift between a door and the server, around its last clean contact. The floor is a server time and a
 * read's date is the door's clock, so a door running behind would lose honest reads around the contact.
 * The same bound as a future date (`CLIENT_TS_SLACK_MS`) is what the server already tolerates; a read taken
 * at server time because of the floor logs how far before it was dated.
 */
const ONLINE_SLACK_MS = CLIENT_TS_SLACK_MS;

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

interface StateAt {
  status: string;
  mode: string;
  /** Hours, hold and zone in force then; null when the log has none (older rows): the current ones apply. */
  timing: HoursFields | null;
}

const timingOf = (raw: string | null): HoursFields | null => {
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as { hours: string | null; hold: string | null; timeZone: string };
    return { hours: t.hours, hold: t.hold, time_zone: t.timeZone };
  } catch {
    return null;
  }
};

/** The session's status, offline mode and timing in force at `t`, from its recorded changes; the current ones when it never changed. */
function stateAt(actor: ScanActor, changes: readonly SessionChange[], t: number): StateAt {
  const past = changes.filter((c) => c.at <= t).at(-1);
  const later = changes.find((c) => c.at > t);
  // A row from before timing was kept has none: the next row's `prev_timing` is what was in force until it.
  if (past)
    return {
      status: past.status,
      mode: past.mode,
      timing: timingOf(past.timing) ?? timingOf(later?.prev_timing ?? null),
    };
  if (later)
    return {
      status: later.prev_status,
      mode: later.prev_mode,
      timing: timingOf(later.prev_timing),
    };
  return {
    status: actor.scanningSession?.status ?? 'active',
    mode: offlineModeOf(actor.settings),
    timing: null,
  };
}

/**
 * Was the session taking reads at `t`, and could the door honestly have made one then? Each read is judged by
 * the status, mode, hours and hold in force at its own time (recorded when they changed, so an Open now or an
 * hours edit made later moves nothing), and by the door's last online contact: a read dated before it is a
 * backdated one. A read that fails is recorded as a conflict and never admitted.
 */
export function sessionAcceptsAt(
  actor: ScanActor,
  t: number,
  changes: readonly SessionChange[],
  onlineAt = 0,
): boolean {
  if (t < onlineAt - ONLINE_SLACK_MS) return false;
  const state = stateAt(actor, changes, t);
  // A scanner outside a session has no history: its last edit dates a switch to Stop.
  if (state.mode === 'stop' && (actor.scanningSession || t >= (actor.scanner?.updatedAt ?? 0)))
    return false;
  if (state.status !== 'active') return false;
  const hours = state.timing ?? captureObservedScanningSession(actor)?.parent;
  return !hours || openAt(hours, t);
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
 *  - A read dated before the later of the door's last online contact and its list's `asOf` was made
 *    when the door could not have been offline: it is taken at server time and recorded `late`.
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
  const sessionId = scopeSessionId(actor);
  const changes = sessionId ? await sessionChanges(ctx.env.DB, sessionId) : [];
  const floor = actor.scanner ? await offlineFloorOf(ctx.env.DB, actor.scanner.id) : 0;
  for (const { item, index } of order) {
    const { door, expired } = await doorOf(ctx, actor, item, request.roster);
    // The door's own date is trusted only for a read the list vouched for (a roster this server signed),
    // and only after the floor the server keeps (last online contact, last list download). Any other
    // read is taken at server time.
    const late =
      door !== 'refused' && item.clientTs < (door === 'listed' ? floor : now) - ONLINE_SLACK_MS;
    const clientTs = late || item.clientTs > now + CLIENT_TS_SLACK_MS ? now : item.clientTs;
    let outcome: ScanOutcome;
    let scanId: string | null = null;
    const taken =
      door === 'refused' ||
      sessionAcceptsAt(actor, clientTs, changes) ||
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
      // A replay was labelled by its first run, unless that stopped between the scan and its label.
      if (
        scanId &&
        (!done.outcome.replay ||
          !(await offlineReadRecorded(ctx.env.DB, actor.actorKey, item.idempotencyKey)))
      )
        await markScanOffline(
          ctx.env.DB,
          { id: scanId, orgId: actor.orgId, mode: actor.mode },
          door,
        );
    }
    if (late)
      ctx.log.info('scan.batch.read_before_contact', {
        orgId: actor.orgId,
        code: 'READ_BEFORE_CONTACT',
        gapMs: floor - item.clientTs,
      });
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
      late,
      clientTs: item.clientTs,
      recordedTs: outcome.at ?? clientTs,
      syncedAt: now,
    });
    results[index] = { idempotencyKey: item.idempotencyKey, outcome, conflict };
  }
  return { items: results };
}
