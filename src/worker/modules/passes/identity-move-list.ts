import type { z } from 'zod';
import type {
  IdentityMoveDto,
  IdentityMoveListQuerySchema,
} from '../../../shared/contracts/identity-moves.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { MoveRow } from './repo-identity-move.ts';
import { listMoves } from './repo-identity-move-list.ts';

const dto = (r: MoveRow): IdentityMoveDto => ({
  id: r.id,
  operationId: r.op_id,
  orgId: r.org_id,
  fromIdentityId: r.from_identity_id,
  toIdentityId: r.to_identity_id,
  oldPassId: r.old_pass_id,
  newPassId: r.new_pass_id,
  state: r.state,
  reason: r.reason,
  conflictCount: r.conflicts ? (JSON.parse(r.conflicts) as unknown[]).length : 0,
  registeredAt: r.registered_at,
  voidAt: r.void_at,
  voidedAt: r.voided_at,
  updatedAt: r.updated_at,
});

/** One page of move rows, newest id last; `nextCursor` is the last id when more follow. */
export async function listIdentityMoves(
  ctx: ServiceContext,
  q: z.infer<typeof IdentityMoveListQuerySchema>,
): Promise<{ items: IdentityMoveDto[]; nextCursor: string | null }> {
  const { cursor, limit, operationId, ...rest } = q;
  const rows = await listMoves(ctx.env.DB, {
    ...rest,
    ...(operationId ? { opId: operationId } : {}),
    after: cursor ?? '',
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map(dto),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
