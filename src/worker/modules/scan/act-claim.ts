import type { z } from 'zod';
import type { ScanActRequestSchema } from '../../../shared/contracts/scan.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import type { ScanActor } from './guard.ts';
import type { Claim } from './repo-scans.ts';

export type ActRequest = z.infer<typeof ScanActRequestSchema>;

/**
 * The body of a request, by what it asks for: the pass id or the hash of the code (never the code
 * in clear), the action, amount, value, direction, override, confirmation, group, who approved
 * and the admin's scope (SA 7.2).
 */
export async function requestHashOf(req: ActRequest): Promise<string> {
  const target =
    'passId' in req.input ? req.input.passId : await barcodeHashOfCode(cleanCode(req.input.code));
  return sha256Hex(
    JSON.stringify([
      target,
      req.actionId,
      req.amount ?? null,
      req.value ?? null,
      req.direction ?? null,
      req.overrideOf ?? null,
      req.confirmed ?? null,
      req.group ?? null,
      req.approval?.staffId ?? null,
      req.scope ?? null,
    ]),
  );
}

export function claimOf(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  scanId: string,
  requestHash: string,
): Claim {
  return {
    id: scanId,
    orgId: actor.orgId,
    mode: actor.mode,
    scannerId: actor.scanner?.id ?? null,
    eventId: actor.event?.id ?? null,
    actorType: actor.actor.type,
    actorId: actor.actor.id,
    actorKey: actor.actorKey,
    staffId: actor.staff?.id ?? null,
    idempotencyKey: req.idempotencyKey,
    requestHash,
    method: req.input.method,
    clientTs: req.clientTs,
    now: ctx.clock.now(),
  };
}
