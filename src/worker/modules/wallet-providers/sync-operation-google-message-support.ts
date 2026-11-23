// Helpers of the Google change-message step: failure classes, the pre-send read and begin, and the ambiguous-transport GET.

import {
  type DeliveredMessage,
  googleChangeMessage,
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
  readPassVersionRange,
} from './repo-google-messages.ts';
import { beginGoogleMessage, settleGoogleMessage } from './repo-google-messages-write.ts';
import { googleNotifiedSince } from './repo-notify-budget.ts';
import {
  findGoogleRuntimeMessage,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime.ts';
import type { WalletSyncOperationExecution } from './sync-operation-context.ts';

/** Google's own limit on notifying messages per object (PROVIDER_NOTIFY_LIMIT.google, section 7). */
const NOTIFY_LIMIT = 3;
const MAX_TRIES = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

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

export type Failure = 'quota' | 'rate_limited' | 'stale' | 'not_sent' | 'ambiguous' | 'refused';

export function classify(error: unknown): { kind: Failure; status: number | null } {
  if (error instanceof WalletRuntimeError)
    return { kind: error.ambiguous ? 'ambiguous' : 'not_sent', status: null };
  if (error instanceof GoogleWalletError) {
    const status = error.status ?? null;
    // A token that could not be minted changed nothing at Google: the message never left.
    if (error.operation === 'oauth') return { kind: 'not_sent', status };
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

export const messageType = (found: 'TEXT' | 'TEXT_AND_NOTIFY') =>
  found === 'TEXT_AND_NOTIFY' ? 'notified' : 'text';

/** Reads, budgets, seals and begins the row: everything before the request. Null when there is nothing to send. */
export async function beginMessage(
  execution: WalletSyncOperationExecution,
  base: number,
  target: number,
) {
  const { ctx, claim, op } = execution;
  const db = ctx.env.DB;
  const existing = await getGoogleMessage(db, op.instanceId, base, target);
  // A settled pair is never sent again (a re-queue of the same versions); a pending one is a rate-limited retry.
  if (existing && existing.state !== 'pending') return null;
  if (existing && existing.tries >= MAX_TRIES) {
    // The rate-limit retries ran out: settle it rather than leave a row no begin will take.
    await settleGoogleMessage(ctx, claim, op, {
      id: existing.id,
      state: 'failed',
      reason: 'rate_limited',
      httpStatus: null,
      targetVersion: target,
    });
    return null;
  }
  let text: GoogleMessageText | null;
  if (existing) text = (await openGoogleMessages(ctx, [existing]))[0] ?? null;
  else {
    const versions = await readPassVersionRange(db, op.passId, base, target);
    if (!versions) {
      ctx.log.info('wallet.google_message_no_base', { orgId: op.orgId });
      return null;
    }
    text = googleChangeMessage(versions);
  }
  if (!text) return null;
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
  if (!begun) return null;
  return { begun, id, text, notify };
}

/** Ambiguous transport: one GET decides. Absent is `unknown`; a failed GET leaves the row `sending`. */
export async function confirm(
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
