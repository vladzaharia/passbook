import type { Mode } from './contracts/common.ts';
import type { ScanRole } from './contracts/scan.ts';
import type { WeeklyHours } from './contracts/scan-access.ts';
import {
  type PlannedEvent,
  type ScanSetupIntent,
  type ScanSetupPlan,
  type SetupLink,
  SetupRefSchema,
} from './contracts/scan-setup-intent.ts';
import type { SetupIssue } from './scan-setup-plan-derive.ts';

/** What the server (or the web) loads for the plan: plain data, in the caller's org and mode. */
export interface TemplateFacts {
  id: string;
  name: string;
  /** An Access card's plans; null on any other template. */
  plans: { id: string; label: string; zones: string[]; hours: WeeklyHours | null }[] | null;
  issued: Record<Mode, number>;
  /** `planEvents` over the issued passes, for `fromTemplate`. `existingId`: the live event it is. */
  upcomingEvents?: {
    name: string;
    opensAt: number;
    closesAt: number;
    timeZone: string | null;
    match: { input: string; value: string } | null;
    existingId: string | null;
  }[];
}
export interface ZoneFacts {
  id: string;
  key: string;
  name: string;
  parentId: string | null;
  archived: boolean;
  occupancy: 'off' | 'track' | 'enforce';
  capacity: number | null;
}
export interface EventFacts {
  id: string;
  name: string;
  templateIds: string[];
  reentry: boolean;
  capacity: number | null;
}
export interface StaffFacts {
  id: string;
  role: ScanRole;
  active: boolean;
}
export interface SetupPlanContext {
  mode: Mode;
  orgTimeZone?: string | null;
  templates: TemplateFacts[];
  zones: ZoneFacts[];
  /** Live (not archived) events of the mode. */
  events: EventFacts[];
  staff: StaffFacts[];
}
export type SetupPlanResult =
  | { ok: true; plan: ScanSetupPlan }
  | { ok: false; issues: SetupIssue[] };

/** A zone may sit up to three levels below its root. */
export const MAX_ZONE_DEPTH = 3;
export const isRef = (v: string) => SetupRefSchema.safeParse(v).success;

/** What a ref names: a place, an event, or a template's event group. */
export type RefTarget =
  | { kind: 'place' }
  | { kind: 'event' }
  | { kind: 'group'; templateId: string; links: SetupLink[] };

/** What a door plan reads, and where it reports issues. */
export interface DoorPlanEnv {
  intent: ScanSetupIntent;
  ctx: SetupPlanContext;
  refs: Map<string, RefTarget>;
  events: PlannedEvent[];
  issues: SetupIssue[];
}
