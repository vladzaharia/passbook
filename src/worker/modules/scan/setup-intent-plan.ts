import type { z } from 'zod';
import { CreateScanEventSchema } from '../../../shared/contracts/index.ts';
import { CreateScanZoneSchema } from '../../../shared/contracts/scan-access.ts';
import type {
  ScanSetupIntent,
  ScanSetupPlan,
} from '../../../shared/contracts/scan-setup-intent.ts';
import { CreateScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import {
  CreateScanningDeviceSchema,
  CreateScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { planBodies } from '../../../shared/scan-setup-plan-bodies.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { planScanningDevice } from './device-statements.ts';
import { type EventPlan, planEvent } from './events-statements.ts';
import { eventsOpen, templatesUsable } from './repo-admin-grant.ts';
import { zonesOpen } from './repo-zones.ts';
import { planSession, type SessionPlan } from './scanning-session-insert.ts';
import { type SetupCapture, slotChecks } from './setup-capture.ts';
import { foldChecks, type MergeableCheck } from './setup-check-merge.ts';
import type { SetupFacts } from './setup-intent-load.ts';
import { numberedName, pickFreeName } from './setup-names.ts';
import type { SetupPlan } from './setup-statements.ts';
import { planStaff, type StaffPlan } from './staff-statements.ts';
import { planZone, type ZonePlan } from './zones-statements.ts';

/**
 * The plan with names no live object holds, each taken for the rest of the plan. The caller's own
 * names stand unless they clash: a clash gets the lowest free number after it.
 */
export function withFreeNames(
  plan: ScanSetupPlan,
  taken: SetupFacts['taken'],
  intent: ScanSetupIntent,
): ScanSetupPlan {
  const next = structuredClone(plan);
  for (const z of next.zones) z.name = pickFreeName(z.name, 40, taken.zones);
  for (const s of next.staff) s.name = pickFreeName(s.name, 40, taken.staff);
  next.sessions.forEach((s, i) => {
    s.devices.forEach((d, n) => {
      // A name the planner made ("<door> 1") counts on from the door's name; a caller's own gets a number after it.
      const given = intent.doors[i]?.devices?.[n]?.name !== undefined;
      d.name = given
        ? pickFreeName(d.name, 40, taken.scanners)
        : numberedName(s.name, 40, taken.scanners);
    });
  });
  return next;
}

/** A create schema's refusal, with the plan path of the object it was made for. */
function parsed<T>(schema: z.ZodType<T>, body: unknown, at: string): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  throw new ValidationError(
    'This setup needs changes.',
    r.error.issues.map((i) => ({
      path: [at, ...i.path].join('.'),
      message: i.message,
      code: i.code,
    })),
    'SCAN_SETUP_INVALID',
  );
}

/** The same check from several plans (every event of one template) is made once: the grant row has a bind budget. */
const uniqueChecks = (checks: MergeableCheck[]): Check[] =>
  foldChecks(checks, (kind, ids) =>
    kind === 'events'
      ? eventsOpen(ids)
      : kind === 'zones'
        ? zonesOpen(ids)
        : kind === 'templates:active'
          ? templatesUsable(ids, 'active')
          : kind === 'templates:attached'
            ? templatesUsable(ids, 'attached')
            : null,
  );

/** Everything the plan functions read and decided; no write has happened. */
export interface PreparedSetup {
  zones: ZonePlan[];
  events: EventPlan[];
  staff: StaffPlan[];
  sessions: { plan: SessionPlan; devices: SetupPlan[] }[];
  /** Every plan's checks, with the one device-slot check first: the one grant's checks. */
  checks: Check[];
  /** The id each ref got. */
  ids: Map<string, string>;
}

/**
 * Runs the S2 plan functions in commit order (zones, events, staff, sessions, devices), each seeing
 * what the earlier ones registered in the capture. `pairNow`: devices get a pairing code with the row.
 */
export async function prepareSetup(
  ctx: ServiceContext,
  plan: ScanSetupPlan,
  capture: SetupCapture,
  facts: SetupFacts,
  options: { pairNow: boolean; setupTemplateId?: string },
): Promise<PreparedSetup> {
  const { orgId } = capture;
  const ids = new Map<string, string>();
  const bodies = () => planBodies(plan, orgId, (ref) => ids.get(ref) ?? ref);
  const zones: ZonePlan[] = [];
  for (const [i, z] of plan.zones.entries()) {
    const made = await planZone(
      ctx,
      parsed(CreateScanZoneSchema, bodies().zones[i], `zones.${i}`),
      capture,
    );
    ids.set(z.ref, made.values.id);
    zones.push(made);
  }
  const events: EventPlan[] = [];
  for (const [i, e] of plan.events.entries()) {
    const from = facts.eventKeys.get(e.ref);
    const body = parsed(
      CreateScanEventSchema,
      { ...bodies().events[i], ...(from?.note ? { note: from.note } : {}) },
      `events.${i}`,
    );
    const made = await planEvent(ctx, body, capture, from?.key);
    ids.set(e.ref, made.values.id);
    events.push(made);
  }
  const staff: StaffPlan[] = [];
  for (const [i, s] of plan.staff.entries()) {
    const made = await planStaff(
      ctx,
      parsed(CreateScanStaffSchema, bodies().staff[i], `staff.${i}`),
    );
    ids.set(s.ref, made.id);
    staff.push(made);
  }
  const sessions: PreparedSetup['sessions'] = [];
  for (const [i, s] of plan.sessions.entries()) {
    const made = await planSession(
      ctx,
      parsed(CreateScanningSessionSchema, bodies().sessions[i]?.body, `doors.${i}`),
      capture,
      i === 0 ? options.setupTemplateId : undefined,
    );
    ids.set(s.ref, made.id);
    const parent = capture.sessions.get(made.id);
    const devices: SetupPlan[] = [];
    for (const [n, d] of s.devices.entries()) {
      const body = parsed(
        CreateScanningDeviceSchema,
        bodies().sessions[i]?.devices[n]?.body,
        `doors.${i}.devices.${n}`,
      );
      if (!parent) throw new Error('Session not captured.');
      const device = await planScanningDevice(
        ctx,
        parent,
        body,
        capture,
        undefined,
        options.pairNow,
      );
      ids.set(d.ref, device.plan.id);
      devices.push(device.plan);
    }
    sessions.push({ plan: made, devices });
  }
  const plans = [...zones, ...events, ...sessions.flatMap((s) => [s.plan, ...s.devices])];
  return {
    zones,
    events,
    staff,
    sessions,
    checks: uniqueChecks([...slotChecks(capture), ...plans.flatMap((p) => p.checks)]),
    ids,
  };
}
