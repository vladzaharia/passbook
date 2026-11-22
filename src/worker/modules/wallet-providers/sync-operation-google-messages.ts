import type { PassJson } from '../../../passkit/types.ts';
import { googleChangeMessage } from '../../../passkit/wallets/google/messages.ts';
import { recordPassEvent } from '../events/record.ts';
import { BUDGET_WINDOW_MS } from '../passes/change-messages.ts';
import { GoogleWalletError } from './google-errors.ts';
import { PROVIDER_NOTIFY_LIMIT } from './notify-budget.ts';
import {
  dropOpenGoogleMessage,
  findOpenGoogleMessage,
  type GoogleMessageReason,
  type GoogleMessageRow,
  type GoogleMessageState,
  googleMessageBase,
  googleMessageBudget,
  openGoogleMessage,
  passJsonsBetween,
  settleGoogleMessage,
} from './repo-google-messages.ts';
import { priorSucceededOperation } from './repo-instance-prior.ts';
import type { WalletRuntimeScope } from './runtime-core.ts';
import {
  type GoogleMessageApi,
  type GoogleMessageTarget,
  withGoogleMessages,
} from './runtime-google-message.ts';
import type { WalletSyncOperationExecution } from './sync-operation-context.ts';

const HISTORY_KEEP = 9;
/** Refused with one of these, the message is not taken: the object write is still good. */
const REFUSED = new Set(['bad_request', 'forbidden', 'not_found', 'conflict', 'unauthorized']);

const googleIdOf = (rowId: string) => `pbm_${rowId.replaceAll('-', '')}`;

type Settled = {
  state: Exclude<GoogleMessageState, 'sending'>;
  reason: GoogleMessageReason | null;
};

/** The ledger is the one place a message is counted, and the sync log's `wallet.messaged` its one event. */
async function settle(
  execution: WalletSyncOperationExecution,
  row: Pick<GoogleMessageRow, 'id'>,
  result: Settled,
  httpStatus: number | null,
): Promise<void> {
  const { ctx, op } = execution;
  if (
    !(await settleGoogleMessage(ctx.env.DB, {
      id: row.id,
      ...result,
      httpStatus,
      now: ctx.clock.now(),
    }))
  )
    return;
  await recordPassEvent(ctx, {
    orgId: op.orgId,
    passId: op.passId,
    mode: op.mode,
    kind: 'wallet.messaged',
    actor: { type: 'system', id: null },
    data: {
      provider: 'google',
      outcome: result.state,
      ...(result.reason ? { reason: result.reason } : {}),
    },
  });
  if (result.state === 'unknown' || result.reason === 'refused')
    ctx.log.warn('wallet.google_message_unsettled', {
      code:
        result.state === 'unknown'
          ? 'WALLET_GOOGLE_MESSAGE_UNCONFIRMED'
          : 'WALLET_GOOGLE_MESSAGE_REFUSED',
      orgId: op.orgId,
      ...(httpStatus === null ? {} : { httpStatus }),
    });
}

/** After a transport that may have reached Google: one read says whether the message is on the object. */
async function settleFromObject(
  execution: WalletSyncOperationExecution,
  api: GoogleMessageApi,
  row: GoogleMessageRow,
): Promise<void> {
  let found: { messageType: string } | undefined;
  try {
    found = (await api.read()).find((m) => m.id === googleIdOf(row.id));
  } catch {
    return;
  }
  if (!found) return settle(execution, row, { state: 'unknown', reason: 'unconfirmed' }, null);
  const notified = found.messageType === 'TEXT_AND_NOTIFY';
  return settle(
    execution,
    row,
    notified
      ? { state: 'notified', reason: null }
      : { state: 'text', reason: row.notify ? 'quota' : 'budget' },
    null,
  );
}

async function send(
  execution: WalletSyncOperationExecution,
  api: GoogleMessageApi,
  row: GoogleMessageRow,
  message: { header: string; body: string },
): Promise<void> {
  const id = googleIdOf(row.id);
  try {
    await api.trim(HISTORY_KEEP);
    await api.add({ id, ...message, messageType: row.notify ? 'TEXT_AND_NOTIFY' : 'TEXT' });
    return settle(
      execution,
      row,
      row.notify ? { state: 'notified', reason: null } : { state: 'text', reason: 'budget' },
      200,
    );
  } catch (error) {
    if (!(error instanceof GoogleWalletError)) throw error;
    if (error.quota && row.notify) {
      // The object write is done; the same message goes again as plain text and the object's budget is spent.
      execution.ctx.log.info('wallet.google_message_quota', {
        code: 'WALLET_GOOGLE_NOTIFY_QUOTA',
        orgId: execution.op.orgId,
      });
      try {
        await api.add({ id, ...message, messageType: 'TEXT' });
        return settle(execution, row, { state: 'text', reason: 'quota' }, 200);
      } catch {
        return settle(execution, row, { state: 'failed', reason: 'refused' }, error.status ?? null);
      }
    }
    if (error.code === 'rate_limited' || (error.code === 'unauthorized' && error.staleToken)) {
      await dropOpenGoogleMessage(execution.ctx.env.DB, row.id);
      throw error;
    }
    if (REFUSED.has(error.code))
      return settle(execution, row, { state: 'failed', reason: 'refused' }, error.status ?? null);
    // Timeout, network, 5xx: the message may be on the object. Never sent twice.
    return settleFromObject(execution, api, row);
  }
}

/**
 * The change message of a Google update (google-messages.md sections 4 to 8), run after the object write. At
 * most once: a row exists for each (base, target), a crashed try is settled by a read before anything is sent,
 * and a message failure never fails the operation. Only rate limiting, a stale token and a lost fence leave it.
 */
export async function sendGoogleChangeMessage(
  execution: WalletSyncOperationExecution,
  scope: WalletRuntimeScope,
  target: Pick<GoogleMessageTarget, 'type' | 'classKey'>,
): Promise<void> {
  const { ctx, op, assertCurrent, onProviderResponse } = execution;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const full: GoogleMessageTarget = {
    ...target,
    releaseId: op.identityProjectionReleaseId,
    passId: op.passId,
    credentialGeneration: op.credentialGeneration,
    channelEpoch: op.channelEpoch,
    assertCurrent,
    onProviderResponse,
  };
  const open = await findOpenGoogleMessage(db, op.instanceId);
  if (open) {
    await withGoogleMessages(ctx, scope, full, (api) => settleFromObject(execution, api, open));
    return;
  }
  const prior = await priorSucceededOperation(db, op.instanceId, op.version);
  const base = await googleMessageBase(
    db,
    op.instanceId,
    prior?.kind === 'upsert' ? prior.passVersion : null,
  );
  // A first object never notifies, and a version already brought to Google has nothing new.
  if (base === null || op.passVersion <= base) return;
  const raws = await passJsonsBetween(db, op.passId, base, op.passVersion);
  let message: { header: string; body: string } | null = null;
  try {
    message = googleChangeMessage(raws.map((raw) => JSON.parse(raw) as PassJson));
  } catch {
    message = null;
  }
  if (!message) return;
  const budget = await googleMessageBudget(db, op.instanceId, now - BUDGET_WINDOW_MS);
  const row: GoogleMessageRow = {
    id: ctx.ids.id(),
    baseVersion: base,
    targetVersion: op.passVersion,
    notify: budget.used < PROVIDER_NOTIFY_LIMIT.google && budget.quotaAt === null,
    state: 'sending',
  };
  if (
    !(await openGoogleMessage(db, {
      id: row.id,
      instanceId: op.instanceId,
      base,
      target: op.passVersion,
      notify: row.notify,
      now,
    }))
  )
    return;
  const content = message;
  await withGoogleMessages(ctx, scope, full, (api) => send(execution, api, row, content));
}
