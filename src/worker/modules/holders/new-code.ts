import { bump } from '../../platform/counters.ts';
import { ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import {
  CredentialTransferReissueRequired,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { assertWritableMode, type ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import { assertNoTransfer, type HolderAuthority, load, view } from './service-operations.ts';

const HOUR = 3_600_000;
export const NEW_CODES_PER_HOUR = 3;

/**
 * Mints a new scan code for a pass through the credential transfer, the one place codes are minted
 * on a live pass: the old code stops resolving and the holder's wallet gets the re-signed pass.
 * The holder and owner stay as they are. The audit row never carries a code.
 */
export async function newPassCode(
  ctx: ServiceContext,
  actor: Actor,
  input: { passId: string },
  scope: ScopeArg,
  authorize?: HolderAuthority,
) {
  const pass = await load(ctx, input.passId, scope);
  const authority = await authorize?.(pass.orgId);
  assertWritableMode(scope, pass.mode);
  assertNoTransfer(pass);
  const now = ctx.clock.now();
  const window = now - (now % HOUR);
  if ((await bump(ctx.env.DB, `passes:newcode:${pass.id}`, window)) > NEW_CODES_PER_HOUR)
    throw new RateLimitedError(Math.ceil((window + HOUR - now) / 1000));
  const audit: AuditEntry = {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.new_code',
    targetType: 'pass',
    targetId: pass.id,
    detail: {},
  };
  try {
    const transfer = await startCredentialTransfer(
      ctx,
      actor,
      pass.id,
      { holderEmail: pass.holderEmail, ownerUserId: pass.ownerUserId },
      scope,
      { kind: 'tenant-holder', expected: pass, ...(authority ? { authority } : {}), audit },
    );
    return view(ctx, pass.id, scope, pass.orgId, pass.mode, transfer);
  } catch (error) {
    if (error instanceof CredentialTransferReissueRequired)
      throw new ConflictError(
        "This pass's barcode is not its scan code, so a new code cannot replace it.",
        'NEW_CODE_UNSUPPORTED',
      );
    if (error instanceof ConflictError && error.code === 'PASS_CONFLICT')
      throw new ConflictError('The pass changed meanwhile. Reload.', 'HOLDER_CHANGED');
    throw error;
  }
}
