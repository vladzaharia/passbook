import type { z } from 'zod';
import type { OpenIncidentSchema, PublicIncidentSchema } from '../../../shared/contracts/status.ts';
import type { Actor } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt, auditStmtWhere } from '../audit/repo.ts';
import { auditActor } from '../audit/service.ts';
import { clearPublicStatusMemo } from './public.ts';
import {
  adminIncidents,
  getIncident,
  type IncidentRow,
  insertIncidentStmt,
  RESOLVED_AT_CONDITION,
  resolveIncidentStmt,
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

/** Every open note and those resolved in the last 14 days. */
export async function listIncidents(
  ctx: ServiceContext,
): Promise<{ items: Incident[]; nextCursor: null }> {
  const rows = await adminIncidents(ctx.env.DB, ctx.clock.now() - 14 * DAY);
  // A capped set (100), so there is never a next page.
  return { items: rows.map(toDto), nextCursor: null };
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
  // One batch: a note never goes live without its audit row, and a retry after a failure cannot duplicate it.
  await ctx.env.DB.batch([
    insertIncidentStmt(ctx.env.DB, row),
    auditStmt(ctx.env.DB, ctx, {
      ...auditActor(actor),
      action: 'status.incident.open',
      targetType: 'status_incident',
      targetId: row.id,
      detail: { component: row.component, impact: row.impact },
    }),
  ]);
  clearPublicStatusMemo(ctx.env.DB);
  return toDto({ ...row, resolved_at: null });
}

export async function resolveIncident(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
): Promise<Incident> {
  const existing = await getIncident(ctx.env.DB, id);
  if (!existing) throw new NotFoundError('Incident not found.', 'INCIDENT_NOT_FOUND');
  // One batch: the audit row is written only while this call's time is the note's resolved time, so a second resolve
  // (which changes nothing) writes none, and a failed audit rolls the resolve back so a retry still audits it.
  const at = ctx.clock.now();
  await ctx.env.DB.batch([
    resolveIncidentStmt(ctx.env.DB, id, at),
    auditStmtWhere(
      ctx.env.DB,
      ctx,
      {
        ...auditActor(actor),
        action: 'status.incident.resolve',
        targetType: 'status_incident',
        targetId: id,
      },
      RESOLVED_AT_CONDITION,
      [id, at, id],
    ),
  ]);
  clearPublicStatusMemo(ctx.env.DB);
  const after = await getIncident(ctx.env.DB, id);
  return toDto(after ?? existing);
}
