import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { writePart } from '../../platform/authority-include.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { batch } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { walletClaimHash } from './instance-claims.ts';
import type { WalletClaimRef, WalletOperation } from './instance-types.ts';
import type { GoogleMessageReason } from './repo-google-messages.ts';
import { walletMessagedEventStmt } from './repo-holder-events.ts';
import { instanceCheck } from './repo-instance-current.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { commitWalletGrant, walletQueueGrant } from './repo-queue-grant.ts';

/**
 * Every message write holds only while the operation's claim does (repo-instance-outcomes.ts is the pattern), so
 * a lost claim cannot move a message. `{grant}` ties it to the record grant.
 */
const FENCE = `EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
  JOIN wallet_provider_instances i ON i.id = op.instance_id
  WHERE i.id = ? AND i.org_id = {org} AND i.mode = {mode} AND i.provider = 'google' AND op.id = ? AND op.version = ?
    AND op.claim_hash = ? AND op.state IN ('claimed', 'uncertain')
    AND op.credential_keyset_commitment = ${pinnedKeysetSql} AND i.credential_keyset_commitment = ${pinnedKeysetSql}
    AND {grant})`;

async function fenceOf(claim: WalletClaimRef, op: WalletOperation) {
  return [op.instanceId, op.id, op.version, await walletClaimHash(claim.claimHandle)];
}

/** Commits and returns the rows of `last` (a RETURNING write), or null when the grant refused the batch. */
async function commitRows<T>(g: Grant, last: GrantedStatement): Promise<T[] | null> {
  const committed = await commitWalletGrant(g);
  return 'results' in committed
    ? ((committed.results[g.indexOf(last)]?.results ?? []) as T[])
    : null;
}

export interface BegunGoogleMessage {
  id: string;
  tries: number;
}

/**
 * Supersedes the instance's other pending message, then makes the row for (base, target) `sending`: inserted,
 * or the pending row of an earlier try reused (same id, so Google sees one message). Null when the claim or the
 * row refuses.
 */
export async function beginGoogleMessage(
  ctx: ServiceContext,
  claim: WalletClaimRef,
  op: WalletOperation,
  m: {
    id: string;
    baseVersion: number;
    targetVersion: number;
    notify: boolean;
    envelope: Envelope;
  },
): Promise<BegunGoogleMessage | null> {
  const g = walletQueueGrant(ctx, 'record', op, [instanceCheck(op.instanceId)]);
  const fence = await fenceOf(claim, op);
  const notify = m.notify ? 1 : 0;
  const [, , begun] = g.include(
    writePart(
      `UPDATE wallet_google_messages SET state = 'superseded'
       WHERE instance_id = ? AND state = 'pending' AND NOT (base_version = ? AND target_version = ?)
         AND ${FENCE}`,
      [op.instanceId, m.baseVersion, m.targetVersion, ...fence],
    ),
    writePart(
      `INSERT OR IGNORE INTO wallet_google_messages
         (id, instance_id, operation_id, base_version, target_version, notify, state, tries,
          kek_version, iv, wrapped_dek, ciphertext, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?
       WHERE ${FENCE}`,
      [
        m.id,
        op.instanceId,
        op.id,
        m.baseVersion,
        m.targetVersion,
        notify,
        m.envelope.kekVersion,
        m.envelope.iv,
        m.envelope.wrappedDek,
        m.envelope.ciphertext,
        ctx.clock.now(),
        ...fence,
      ],
    ),
    writePart(
      `UPDATE wallet_google_messages
       SET state = 'sending', operation_id = ?, notify = ?, tries = tries + 1
       WHERE instance_id = ? AND base_version = ? AND target_version = ? AND state = 'pending' AND tries < 8
         AND ${FENCE}
       RETURNING id, tries`,
      [op.id, notify, op.instanceId, m.baseVersion, m.targetVersion, ...fence],
    ),
  );
  if (!begun) return null;
  const rows = await commitRows<BegunGoogleMessage>(g, begun);
  return rows?.[0] ?? null;
}

/** Back to `pending` when the request provably did not leave, or a rate limit asks for a later try. */
export async function releaseGoogleMessage(
  ctx: ServiceContext,
  claim: WalletClaimRef,
  op: WalletOperation,
  id: string,
  reason: 'rate_limited' | null,
): Promise<boolean> {
  const g = walletQueueGrant(ctx, 'record', op, [instanceCheck(op.instanceId)]);
  const [part] = g.include(
    writePart(
      `UPDATE wallet_google_messages SET state = 'pending', reason = ?
       WHERE id = ? AND instance_id = ? AND state = 'sending' AND ${FENCE}
       RETURNING id`,
      [reason, id, op.instanceId, ...(await fenceOf(claim, op))],
    ),
  );
  return part ? ((await commitRows(g, part))?.length ?? 0) === 1 : false;
}

/**
 * Settles the row and, once, tells the pass log (`wallet.messaged`). The event never carries the text; it is
 * guarded by the settled row, so a repeat writes nothing.
 */
export async function settleGoogleMessage(
  ctx: ServiceContext,
  claim: WalletClaimRef,
  op: WalletOperation,
  m: {
    id: string;
    state: 'notified' | 'text' | 'failed' | 'unknown';
    reason: GoogleMessageReason | null;
    httpStatus: number | null;
    targetVersion: number;
  },
): Promise<boolean> {
  const g = walletQueueGrant(ctx, 'record', op, [instanceCheck(op.instanceId)]);
  const now = ctx.clock.now();
  const [part] = g.include(
    writePart(
      `UPDATE wallet_google_messages
       SET state = ?, reason = CASE WHEN reason = 'quota' THEN 'quota' ELSE ? END, http_status = ?, settled_at = ?
       WHERE id = ? AND instance_id = ? AND state IN ('pending', 'sending') AND ${FENCE}
       RETURNING id`,
      [m.state, m.reason, m.httpStatus, now, m.id, op.instanceId, ...(await fenceOf(claim, op))],
    ),
  );
  if (!part || ((await commitRows(g, part))?.length ?? 0) !== 1) return false;
  try {
    await batch(ctx.env.DB, [
      walletMessagedEventStmt(ctx.env.DB, {
        orgId: op.orgId,
        passId: op.passId,
        mode: op.mode,
        messageId: m.id,
        outcome: m.state,
        ...(m.reason === 'budget' || m.reason === 'quota' ? { reason: m.reason } : {}),
        version: m.targetVersion,
        at: now,
      }),
    ]);
  } catch {
    // The ledger row is the truth; a lost sync-log row must not look like a failed message.
    ctx.log.error('wallet.google_message_event_failed', {
      code: 'WALLET_GOOGLE_MESSAGE_EVENT',
      orgId: op.orgId,
    });
  }
  return true;
}

/** Records Google's quota refusal before the TEXT resend, so the spent budget survives a crash or a refused resend. */
export async function markGoogleMessageQuota(
  ctx: ServiceContext,
  claim: WalletClaimRef,
  op: WalletOperation,
  id: string,
): Promise<boolean> {
  const g = walletQueueGrant(ctx, 'record', op, [instanceCheck(op.instanceId)]);
  const [part] = g.include(
    writePart(
      `UPDATE wallet_google_messages SET notify = 0, reason = 'quota'
       WHERE id = ? AND instance_id = ? AND state = 'sending' AND ${FENCE}
       RETURNING id`,
      [id, op.instanceId, ...(await fenceOf(claim, op))],
    ),
  );
  return part ? ((await commitRows(g, part))?.length ?? 0) === 1 : false;
}
