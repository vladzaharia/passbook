import type { z } from 'zod';
import type { CreateScanEventSchema } from '../../../shared/contracts/index.ts';
import type { Grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { checkTemplates } from './events-validation.ts';
import { adminActorOf, audited, createdByOf, templatesUsable } from './repo-admin-grant.ts';
import { eventReleaseChecks } from './repo-event-authority.ts';
import { addEventInsert, addEventTemplates, type EventValues } from './repo-events-write.ts';
import type { SetupCapture } from './setup-capture.ts';

export type CreateEvent = z.infer<typeof CreateScanEventSchema>;

export const EVENT_CODES = {
  config: 'SCAN_EVENT_CHANGED',
  lineage: 'SCAN_EVENT_CHANGED',
  release: 'SCAN_EVENT_CHANGED',
} as const;

export interface EventPlan {
  values: EventValues;
  templateIds: string[];
  checks: Check[];
}

/**
 * The reads and rules of an event create: the authority matches the org and mode, and the templates
 * exist, are active, carry a release and can check people in. Nothing is written; the event
 * joins the capture so later plans may admit it.
 * `setupKey` is Scan passes': one live event per key, enforced by the unique index.
 */
export async function planEvent(
  ctx: ServiceContext,
  input: CreateEvent,
  capture: SetupCapture,
  setupKey?: string,
): Promise<EventPlan> {
  const { authority, mode } = capture;
  if (authority.orgId !== input.orgId || authority.mode !== mode) throw new ForbiddenError();
  if (input.hardLimit && input.capacity == null)
    throw new ValidationError('Set a capacity first.', [], 'EVENT_NEEDS_CAPACITY');
  const templateIds = [...new Set(input.templateIds)];
  const stamps = await checkTemplates(
    ctx,
    input.orgId,
    mode,
    templateIds,
    input.match?.input ?? null,
  );
  const values: EventValues = {
    id: ctx.ids.id(),
    orgId: input.orgId,
    mode,
    name: input.name,
    matchInput: input.match?.input ?? null,
    matchValues: input.match?.values ?? null,
    opensAt: input.opensAt,
    closesAt: input.closesAt,
    timeZone: input.timeZone,
    capacity: input.capacity ?? null,
    reentry: input.reentry ?? false,
    hardLimit: input.hardLimit ?? false,
    note: input.note ?? null,
    ...(setupKey ? { setupKey } : {}),
  };
  capture.events.set(values.id, templateIds);
  return {
    values,
    templateIds,
    checks: [...templatesUsable(templateIds), ...eventReleaseChecks(stamps, mode)],
  };
}

/** The event row, its template links and its audit row. */
export function eventStatements(
  g: Grant,
  ctx: ServiceContext,
  plan: EventPlan,
  capture: SetupCapture,
): { id: string } {
  const { values, templateIds } = plan;
  addEventInsert(g, values, createdByOf(capture.authority, capture.userId), ctx.clock.now());
  addEventTemplates(g, values.id, templateIds, false);
  g.add(
    audited(g, ctx, {
      orgId: capture.orgId,
      ...adminActorOf(capture.authority, capture.userId),
      action: 'scan_event.create',
      targetType: 'scan_event',
      targetId: values.id,
      detail: { mode: capture.mode, templates: templateIds.length, capacity: values.capacity },
    }),
  );
  return { id: values.id };
}
