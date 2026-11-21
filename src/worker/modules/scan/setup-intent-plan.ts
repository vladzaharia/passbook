import { CreateScanEventSchema } from '../../../shared/contracts/index.ts';
import { CreateScanZoneSchema } from '../../../shared/contracts/scan-access.ts';
import type { ScanSetupPlan } from '../../../shared/contracts/scan-setup-intent.ts';
import { CreateScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import {
  CreateScanningDeviceSchema,
  CreateScanningSessionSchema,
} from '../../../shared/contracts/scanning-sessions.ts';
import { planBodies } from '../../../shared/scan-setup-plan-bodies.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { planScanningDevice } from './device-statements.ts';
import { type EventPlan, planEvent } from './events-statements.ts';
import { planSession, type SessionPlan } from './scanning-session-insert.ts';
import { type SetupCapture, slotChecks } from './setup-capture.ts';
import { eventKeyOf, type SetupFacts } from './setup-intent-load.ts';
import { pickFreeName } from './setup-names.ts';
import type { SetupPlan } from './setup-statements.ts';
import { planStaff, type StaffPlan } from './staff-statements.ts';
import { planZone, type ZonePlan } from './zones-statements.ts';

/**
 * The plan with names no live object holds, each taken for the rest of the plan. The caller's own
 * names stand unless they clash: a clash gets the lowest free number after it.
 */
export function withFreeNames(plan: ScanSetupPlan, taken: SetupFacts['taken']): ScanSetupPlan {
  const next = structuredClone(plan);
  for (const z of next.zones) z.name = pickFreeName(z.name, 40, taken.zones);
  for (const s of next.staff) s.name = pickFreeName(s.name, 40, taken.staff);
  for (const s of next.sessions)
    for (const d of s.devices) d.name = pickFreeName(d.name, 40, taken.scanners);
  return next;
}

/** The same check from several plans (every event of one template) binds its values once: the grant row has a bind budget. */
const uniqueChecks = (checks: Check[]): Check[] => {
  const seen = new Set<string>();
  return checks.filter((c) => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

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
    const made = await planZone(ctx, CreateScanZoneSchema.parse(bodies().zones[i]), capture);
    ids.set(z.ref, made.values.id);
    zones.push(made);
  }
  const events: EventPlan[] = [];
  for (const [i, e] of plan.events.entries()) {
    const from =
      e.templateIds.length === 1
        ? facts.eventKeys.get(eventKeyOf(e.templateIds[0] ?? '', e.name, e.opensAt, e.closesAt))
        : undefined;
    const body = CreateScanEventSchema.parse({
      ...bodies().events[i],
      ...(from?.note ? { note: from.note } : {}),
    });
    const made = await planEvent(ctx, body, capture, from?.key);
    ids.set(e.ref, made.values.id);
    events.push(made);
  }
  const staff: StaffPlan[] = [];
  for (const [i, s] of plan.staff.entries()) {
    const made = await planStaff(ctx, CreateScanStaffSchema.parse(bodies().staff[i]));
    ids.set(s.ref, made.id);
    staff.push(made);
  }
  const sessions: PreparedSetup['sessions'] = [];
  for (const [i, s] of plan.sessions.entries()) {
    const made = await planSession(
      ctx,
      CreateScanningSessionSchema.parse(bodies().sessions[i]?.body),
      capture,
      i === 0 ? options.setupTemplateId : undefined,
    );
    ids.set(s.ref, made.id);
    const parent = capture.sessions.get(made.id);
    const devices: SetupPlan[] = [];
    for (const [n, d] of s.devices.entries()) {
      const body = CreateScanningDeviceSchema.parse(bodies().sessions[i]?.devices[n]?.body);
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
