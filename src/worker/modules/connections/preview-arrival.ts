import type { z } from 'zod';
import type { ConnectionPreviewSchema } from '../../../shared/contracts/index.ts';
import { ForbiddenError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ConnectionAuthority } from './access.ts';
import { type Found, runPreview } from './preview.ts';
import { retentionIdOfArrival } from './repo-webhook-arrivals.ts';
import { retainedById } from './repo-webhook-retention.ts';
import { requireConnection } from './service.ts';
import { decryptRetainedPayload } from './webhook-payload.ts';

/**
 * What the kept event of an accepted arrival makes under the connection's current mapping and template.
 * It reads the kept payload and the connection's passes; it writes nothing.
 */
export async function previewArrival(
  sctx: ServiceContext,
  id: string,
  arrivalId: string,
  authority?: ConnectionAuthority,
): Promise<z.infer<typeof ConnectionPreviewSchema>> {
  const conn = await requireConnection(sctx, id);
  if (authority && authority.orgId !== conn.orgId) throw new ForbiddenError();
  const startedAt = sctx.clock.now();
  const arrival = await retentionIdOfArrival(sctx.env.DB, conn.id, arrivalId);
  if (!arrival.found) throw new NotFoundError('Arrival not found.', 'WEBHOOK_NOT_FOUND');
  const row = arrival.retentionId
    ? await retainedById(sctx.env.DB, conn.id, arrival.retentionId)
    : null;
  if (!row || row.orgId !== conn.orgId)
    throw new UnavailableError('The event is no longer kept.', 'WEBHOOK_PAYLOAD_MISSING');
  const payload = await decryptRetainedPayload(sctx, row);
  const records: Found[] = payload.items.flatMap((i) =>
    i.record && !i.deleted ? [{ ref: i.ref, record: i.record as Found['record'] }] : [],
  );
  return runPreview(
    sctx,
    {
      orgId: conn.orgId,
      connectionId: conn.id,
      mapping: conn.mapping,
      voidWhen: conn.voidWhen,
      autoCreate: conn.autoCreate,
      defaultTemplateId: conn.defaultTemplateId,
    },
    async () => ({ records, excluded: 0 }),
    startedAt,
    conn.id,
  );
}
