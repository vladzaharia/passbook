import type { z } from 'zod';
import type { OpenIncidentSchema, PublicIncidentSchema } from '../../../shared/contracts/status.ts';
import type { Actor } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { clearPublicStatusMemo } from './public.ts';
import {
  getIncident,
  type IncidentRow,
  incidents,
  insertIncident,
  resolveIncidentRow,
} from './repo-public.ts';

type Incident = z.infer<typeof PublicIncidentSchema>;

const DAY = 86_400_000;

const toDto = (n: IncidentRow): Incident => ({
  id: n.id,
  title: n.title,
  note: n.note,
  component: n.component,
  impact: n.impact,
  startedAt: n.started_at,
  resolvedAt: n.resolved_at,
});

/** The notes the public page lists: open ones and those resolved in the last 14 days. */
export async function listIncidents(ctx: ServiceContext): Promise<{ items: Incident[] }> {
  const rows = await incidents(ctx.env.DB, ctx.clock.now() - 14 * DAY);
  return { items: rows.map(toDto) };
}

export async function openIncident(
  ctx: ServiceContext,
  actor: Actor,
  input: z.infer<typeof OpenIncidentSchema>,
): Promise<Incident> {
  const row = {
    id: ctx.ids.id(),
    title: input.title,
    note: input.note,
    component: input.component,
    impact: input.impact,
    started_at: ctx.clock.now(),
  };
  await insertIncident(ctx.env.DB, row);
  clearPublicStatusMemo(ctx.env.DB);
  await recordAudit(ctx, {
    ...auditActor(actor),
    action: 'status.incident.open',
    targetType: 'status_incident',
    targetId: row.id,
    detail: { component: row.component, impact: row.impact },
  });
  return toDto({ ...row, resolved_at: null });
}

export async function resolveIncident(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
): Promise<Incident> {
  const existing = await getIncident(ctx.env.DB, id);
  if (!existing) throw new NotFoundError('Incident not found.', 'INCIDENT_NOT_FOUND');
  // A second resolve changes nothing, so it keeps the first time and writes no second audit row.
  if (await resolveIncidentRow(ctx.env.DB, id, ctx.clock.now())) {
    clearPublicStatusMemo(ctx.env.DB);
    await recordAudit(ctx, {
      ...auditActor(actor),
      action: 'status.incident.resolve',
      targetType: 'status_incident',
      targetId: id,
    });
  }
  const after = await getIncident(ctx.env.DB, id);
  return toDto(after ?? existing);
}
