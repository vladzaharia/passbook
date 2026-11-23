// The Google change message (docs/design/wallet-providers/google-messages.md sections 6 to 8): after an object write,
// one `addMessage` per operation. At most once: a message whose transport is ambiguous is checked with one GET and
// never sent again. A message failure never fails the object write, so only a rate limit, a stale token and a lost
// fence leave this step.
import { HISTORY_WINDOW_MS, MAX_HISTORY } from '../../../passkit/wallets/google/messages.ts';
import { GoogleWalletError } from './google-errors.ts';
import {
  type GoogleMessageText,
  googleMessageId,
  openGoogleMessages,
} from './google-message-seal.ts';
import {
  type GoogleMessageReason,
  getSendingGoogleMessage,
  googleMessageBase,
  listDeliveredGoogleMessages,
} from './repo-google-messages.ts';
import {
  markGoogleMessageQuota,
  releaseGoogleMessage,
  settleGoogleMessage,
} from './repo-google-messages-write.ts';
import {
  addGoogleRuntimeMessage,
  findGoogleRuntimeMessage,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime.ts';
import type { WalletSyncOperationExecution } from './sync-operation-context.ts';
import {
  beginMessage,
  classify,
  confirm,
  type GoogleMessageIdentity,
  type GoogleMessagePrepare,
  messageType,
} from './sync-operation-google-message-support.ts';

export type { GoogleMessageIdentity, GoogleMessagePrepare };

const MAX_TRIES = 8;

/**
 * Before the object write: settles a message a crashed try left `sending` (one GET: present, or `unknown`), and reads
 * the base version and the delivered history the object's `messages` carries.
 */
export async function prepareGoogleMessages(
  execution: WalletSyncOperationExecution,
  scope: WalletRuntimeScope,
  identity: GoogleMessageIdentity,
): Promise<GoogleMessagePrepare> {
  try {
    return await prepareUnguarded(execution, scope, identity);
  } catch (error) {
    if (execution.fenceLost) throw error;
    // Never wedge the object write: send nothing, and leave `messages` out of the write (blocked).
    execution.ctx.log.error('wallet.google_message_prepare_failed', {
      code: 'WALLET_GOOGLE_MESSAGE_PREPARE',
      orgId: execution.op.orgId,
    });
    return { base: null, blocked: true, history: [] };
  }
}

async function prepareUnguarded(
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
    history: rows.flatMap((row, i) => {
      const text = texts[i];
      return text ? [{ id: googleMessageId(row.id), ...text, settledAt: row.settledAt ?? 0 }] : [];
    }),
  };
}

/** After the object write: builds, budgets and sends the one message of this operation. */
export async function sendGoogleMessage(
  execution: WalletSyncOperationExecution,
  scope: WalletRuntimeScope,
  identity: GoogleMessageIdentity,
  prepared: GoogleMessagePrepare,
): Promise<void> {
  try {
    await sendUnguarded(execution, scope, identity, prepared);
  } catch (error) {
    // Provider errors that mean "try the operation again" (rate limit, stale token) and a lost fence leave this
    // step; anything else (a database or key error) is logged and the finished object write completes.
    if (
      execution.fenceLost ||
      error instanceof GoogleWalletError ||
      error instanceof WalletRuntimeError
    )
      throw error;
    execution.ctx.log.error('wallet.google_message_failed', {
      code: 'WALLET_GOOGLE_MESSAGE_FAILED',
      orgId: execution.op.orgId,
    });
  }
}

async function sendUnguarded(
  execution: WalletSyncOperationExecution,
  scope: WalletRuntimeScope,
  identity: GoogleMessageIdentity,
  prepared: GoogleMessagePrepare,
): Promise<void> {
  const { ctx, claim, op, assertCurrent, onProviderResponse } = execution;
  const base = prepared.base;
  const target = op.passVersion;
  if (prepared.blocked || base === null || target <= base) return;
  let begun: { id: string; tries: number } | null;
  let id: string;
  let text: GoogleMessageText;
  let notify: boolean;
  try {
    const found = await beginMessage(execution, base, target);
    if (!found) return;
    ({ begun, id, text, notify } = found);
  } catch (error) {
    if (execution.fenceLost) throw error;
    // The object write is done: a failure before the request leaves the row as it was, and the operation completes.
    ctx.log.error('wallet.google_message_failed', {
      code: 'WALLET_GOOGLE_MESSAGE_FAILED',
      orgId: op.orgId,
    });
    return;
  }
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
        // Written first, so a crash or a refused resend still leaves the budget spent.
        await markGoogleMessageQuota(ctx, claim, op, id);
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
      if (failure.kind === 'stale') {
        await releaseGoogleMessage(ctx, claim, op, id, null);
        throw error;
      }
      if (failure.kind === 'not_sent') {
        // Never left, and the object write is done (and must not be retried): the message is dropped, visibly.
        ctx.log.warn('wallet.google_message_not_sent', {
          code: 'WALLET_GOOGLE_MESSAGE_NOT_SENT',
          orgId: op.orgId,
        });
        await settle('failed', 'not_sent', failure.status);
        return;
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
