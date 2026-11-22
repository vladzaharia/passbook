// The Google change message (docs/design/wallet-providers/google-messages.md sections 6 to 8): after an object write,
// one `addMessage` per operation. At most once: a message whose transport is ambiguous is checked with one GET and
// never sent again. A message failure never fails the object write, so only a rate limit, a stale token and a lost
// fence leave this step.
import {
  type DeliveredMessage,
  googleChangeMessage,
  HISTORY_WINDOW_MS,
  MAX_HISTORY,
} from '../../../passkit/wallets/google/messages.ts';
import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import { GoogleWalletError } from './google-errors.ts';
import {
  type GoogleMessageText,
  googleMessageId,
  openGoogleMessages,
  sealGoogleMessage,
} from './google-message-seal.ts';
import {
  type GoogleMessageReason,
  getGoogleMessage,
  getSendingGoogleMessage,
  googleMessageBase,
  listDeliveredGoogleMessages,
  readPassVersionRange,
} from './repo-google-messages.ts';
import {
  beginGoogleMessage,
  releaseGoogleMessage,
  settleGoogleMessage,
} from './repo-google-messages-write.ts';
import { googleNotifiedSince } from './repo-notify-budget.ts';
import {
  addGoogleRuntimeMessage,
  findGoogleRuntimeMessage,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime.ts';
import type { WalletSyncOperationExecution } from './sync-operation-context.ts';

/** Google's own limit on notifying messages per object (PROVIDER_NOTIFY_LIMIT.google, section 7). */
const NOTIFY_LIMIT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRIES = 8;

/** What the Google runtime needs to name the object. */
export interface GoogleMessageIdentity {
  releaseId: string;
  passId: string;
  credentialGeneration: number;
  channelEpoch: number;
  type: GoogleType;
  classKey?: string;
}

export interface GoogleMessagePrepare {
  /** The version the object last carried; null before the first object, which never notifies. */
  base: number | null;
  /** A message left `sending` whose fate is unknown: nothing is sent this time. */
  blocked: boolean;
  history: DeliveredMessage[];
}

type Failure = 'quota' | 'rate_limited' | 'stale' | 'not_sent' | 'ambiguous' | 'refused';

function classify(error: unknown): { kind: Failure; status: number | null } {
  if (error instanceof WalletRuntimeError)
    return { kind: error.ambiguous ? 'ambiguous' : 'not_sent', status: null };
  if (error instanceof GoogleWalletError) {
    const status = error.status ?? null;
    if (error.code === 'quota_exceeded') return { kind: 'quota', status };
    if (error.code === 'rate_limited') return { kind: 'rate_limited', status };
    if (error.code === 'unauthorized' && error.staleToken) return { kind: 'stale', status };
    if (
      error.code === 'bad_request' ||
      error.code === 'invalid_input' ||
      error.code === 'unauthorized' ||
      error.code === 'forbidden' ||
      error.code === 'not_found' ||
      error.code === 'conflict'
    )
      return { kind: 'refused', status };
  }
  return { kind: 'ambiguous', status: null };
}

const messageType = (found: 'TEXT' | 'TEXT_AND_NOTIFY') =>
  found === 'TEXT_AND_NOTIFY' ? 'notified' : 'text';

/**
 * Before the object write: settles a message a crashed try left `sending` (one GET: present, or `unknown`), and reads
 * the base version and the delivered history the object's `messages` carries.
 */
export async function prepareGoogleMessages(
  execution: WalletSyncOperationExecution,
  scope: WalletRuntimeScope,
  identity: GoogleMessageIdentity,
): Promise<GoogleMessagePrepare> {
  const { ctx, claim, op, assertCurrent, onProviderResponse } = execution;
  const db = ctx.env.DB;
  let blocked = false;
  const open = await getSendingGoogleMessage(db, op.instanceId);
  if (open) {
    try {
      const found = await findGoogleRuntimeMessage(ctx, scope, {
        ...identity,
        assertCurrent,
        onProviderResponse,
        messageId: googleMessageId(open.id),
      });
      await settleGoogleMessage(ctx, claim, op, {
        id: open.id,
        state: found ? messageType(found) : 'unknown',
        reason: found ? (open.notify ? null : 'budget') : 'unconfirmed',
        httpStatus: null,
        targetVersion: open.targetVersion,
      });
    } catch (error) {
      if (execution.fenceLost) throw error;
      if (error instanceof GoogleWalletError && error.code === 'not_found') {
        await settleGoogleMessage(ctx, claim, op, {
          id: open.id,
          state: 'unknown',
          reason: 'unconfirmed',
          httpStatus: null,
          targetVersion: open.targetVersion,
        });
      } else blocked = true;
      if (blocked)
        ctx.log.warn('wallet.google_message_unconfirmed', {
          code: 'WALLET_GOOGLE_MESSAGE_UNCONFIRMED',
          orgId: op.orgId,
        });
    }
  }
  const rows = await listDeliveredGoogleMessages(
    db,
    op.instanceId,
    ctx.clock.now() - HISTORY_WINDOW_MS,
    MAX_HISTORY,
  );
  const texts = await openGoogleMessages(ctx, rows);
  return {
    base: await googleMessageBase(db, op.instanceId),
    blocked,
    history: rows.map((row, i) => ({
      id: googleMessageId(row.id),
      header: texts[i]?.header ?? '',
      body: texts[i]?.body ?? '',
      settledAt: row.settledAt ?? 0,
    })),
  };
}

/** After the object write: builds, budgets and sends the one message of this operation. */
export async function sendGoogleMessage(
  execution: WalletSyncOperationExecution,
  scope: WalletRuntimeScope,
  identity: GoogleMessageIdentity,
  prepared: GoogleMessagePrepare,
): Promise<void> {
  const { ctx, claim, op, assertCurrent, onProviderResponse } = execution;
  const db = ctx.env.DB;
  const base = prepared.base;
  const target = op.passVersion;
  if (prepared.blocked || base === null || target <= base) return;
  const existing = await getGoogleMessage(db, op.instanceId, base, target);
  // A settled pair is never sent again (a re-queue of the same versions); a pending one is a rate-limited retry.
  if (existing && existing.state !== 'pending') return;
  let text: GoogleMessageText | null;
  if (existing) text = (await openGoogleMessages(ctx, [existing]))[0] ?? null;
  else {
    const versions = await readPassVersionRange(db, op.passId, base, target);
    if (!versions) {
      ctx.log.info('wallet.google_message_no_base', { orgId: op.orgId });
      return;
    }
    text = googleChangeMessage(versions);
  }
  if (!text) return;
  const budget = await googleNotifiedSince(
    db,
    { instanceId: op.instanceId },
    ctx.clock.now() - DAY_MS,
  );
  const id = existing?.id ?? ctx.ids.id();
  const notify = budget.used < NOTIFY_LIMIT && budget.quotaAt === null;
  const begun = await beginGoogleMessage(ctx, claim, op, {
    id,
    baseVersion: base,
    targetVersion: target,
    notify,
    envelope: existing?.envelope ?? (await sealGoogleMessage(ctx, op.instanceId, id, text)),
  });
  if (!begun) return;
  let type: 'TEXT' | 'TEXT_AND_NOTIFY' = notify ? 'TEXT_AND_NOTIFY' : 'TEXT';
  let reason: GoogleMessageReason | null = notify ? null : 'budget';
  // A request that left shows as a recorded response; a lost fence with none means it never left.
  let responded = false;
  const sink: typeof onProviderResponse = async (response) => {
    responded = true;
    await onProviderResponse(response);
  };
  const settle = (
    state: 'notified' | 'text' | 'failed' | 'unknown',
    why: GoogleMessageReason | null,
    httpStatus: number | null,
  ) =>
    settleGoogleMessage(ctx, claim, op, {
      id,
      state,
      reason: why,
      httpStatus,
      targetVersion: target,
    });
  const send = () =>
    addGoogleRuntimeMessage(ctx, scope, {
      ...identity,
      assertCurrent,
      onProviderResponse: sink,
      message: {
        id: googleMessageId(id),
        header: text.header,
        body: text.body,
        messageType: type,
      },
    });
  for (;;) {
    try {
      await send();
      await settle(type === 'TEXT_AND_NOTIFY' ? 'notified' : 'text', reason, null);
      return;
    } catch (error) {
      const failure = classify(error);
      if (execution.fenceLost && !responded) {
        await releaseGoogleMessage(ctx, claim, op, id, null);
        throw error;
      }
      // A 429 without the quota marker, twice on a notifying message, is Google's quota in all but name.
      const quota =
        type === 'TEXT_AND_NOTIFY' &&
        (failure.kind === 'quota' || (failure.kind === 'rate_limited' && begun.tries >= 2));
      if (quota) {
        ctx.log.info('wallet.google_message_quota', {
          code: 'WALLET_GOOGLE_NOTIFY_QUOTA',
          orgId: op.orgId,
        });
        type = 'TEXT';
        reason = 'quota';
        continue;
      }
      if (failure.kind === 'rate_limited' && begun.tries >= MAX_TRIES) {
        await settle('failed', 'rate_limited', failure.status);
        return;
      }
      if (failure.kind === 'rate_limited') {
        await releaseGoogleMessage(ctx, claim, op, id, 'rate_limited');
        throw error;
      }
      if (failure.kind === 'stale' || failure.kind === 'not_sent') {
        await releaseGoogleMessage(ctx, claim, op, id, null);
        throw error;
      }
      if (failure.kind === 'refused' || failure.kind === 'quota') {
        ctx.log.warn('wallet.google_message_refused', {
          code: 'WALLET_GOOGLE_MESSAGE_REFUSED',
          orgId: op.orgId,
          httpStatus: failure.status,
        });
        await settle('failed', 'refused', failure.status);
        return;
      }
      if (execution.fenceLost) throw error;
      await confirm(execution, scope, identity, { id, type, reason, settle });
      return;
    }
  }
}

/** Ambiguous transport: one GET decides. Absent is `unknown`; a failed GET leaves the row `sending`. */
async function confirm(
  execution: WalletSyncOperationExecution,
  scope: WalletRuntimeScope,
  identity: GoogleMessageIdentity,
  m: {
    id: string;
    type: 'TEXT' | 'TEXT_AND_NOTIFY';
    reason: GoogleMessageReason | null;
    settle: (
      state: 'notified' | 'text' | 'failed' | 'unknown',
      why: GoogleMessageReason | null,
      status: number | null,
    ) => Promise<boolean>;
  },
): Promise<void> {
  const { ctx, op, assertCurrent, onProviderResponse } = execution;
  try {
    const found = await findGoogleRuntimeMessage(ctx, scope, {
      ...identity,
      assertCurrent,
      onProviderResponse,
      messageId: googleMessageId(m.id),
    });
    if (found) await m.settle(messageType(found), found === 'TEXT' ? m.reason : null, null);
    else await m.settle('unknown', 'unconfirmed', null);
  } catch (error) {
    if (execution.fenceLost) throw error;
    // No object means no message either; any other failed read leaves the row `sending` for the next run.
    if (error instanceof GoogleWalletError && error.code === 'not_found') {
      await m.settle('unknown', 'unconfirmed', null);
      return;
    }
    ctx.log.warn('wallet.google_message_unconfirmed', {
      code: 'WALLET_GOOGLE_MESSAGE_UNCONFIRMED',
      orgId: op.orgId,
    });
  }
}
