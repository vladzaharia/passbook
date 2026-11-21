import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  ScanSetupPlan,
  ScanSetupResult,
  SetupLink,
} from '../../../shared/contracts/scan-setup-intent.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { scanningDeviceStatements } from './device-statements.ts';
import { eventStatements } from './events-statements.ts';
import { adminActorOf, adminGrant, audited } from './repo-admin-grant.ts';
import { sessionStatements } from './scanning-session-insert.ts';
import { newCapture } from './setup-capture.ts';
import type { SetupFacts } from './setup-intent-load.ts';
import { type PreparedSetup, prepareSetup } from './setup-intent-plan.ts';
import { staffStatements } from './staff-statements.ts';
import { zoneStatements } from './zones-statements.ts';

/** Every object's rules share one grant, so a refusal answers with one code: the plan changed under the call. */
export const SETUP_APPLY_CODES = {
  config: 'SCAN_SETUP_CHANGED',
  lineage: 'SCAN_SETUP_CHANGED',
  release: 'SCAN_SETUP_CHANGED',
  stale: 'SCAN_SETUP_CHANGED',
} as const;

export interface ApplyOptions {
  origin: string;
  /** Scan passes: the one session of this template. It makes no device, as it never did. */
  setupTemplateId?: string;
}

/** Zones and staff are console work: a key that names a new place or person is refused whole. */
export function assertKeyScope(authority: TenantPassWrite, plan: ScanSetupPlan): void {
  if (authority.kind === 'api_key' && (plan.zones.length > 0 || plan.staff.length > 0))
    throw new ForbiddenError(
      'Places and staff are made from a console sign-in. Use existing places or leave staff out.',
      'SCAN_SETUP_CONSOLE_ONLY',
    );
}

const links = (all: SetupLink[][]) => {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const l of all.flat())
    if ('id' in l && !seen.has(l.id)) {
      seen.add(l.id);
      ids.push(l.id);
    }
  return ids;
};

/** Events in the order the sessions admit them, then any a session does not admit. */
function orderedEvents(plan: ScanSetupPlan, facts: SetupFacts, id: (ref: string) => string) {
  const created = new Map(plan.events.map((e) => [e.ref, e]));
  const out: ScanSetupResult['events'] = [];
  const add = (e: ScanSetupResult['events'][number]) => {
    if (!out.some((x) => x.id === e.id)) out.push(e);
  };
  for (const link of plan.sessions.flatMap((s) => s.accepts?.events ?? [])) {
    const made = 'ref' in link ? created.get(link.ref) : undefined;
    const known = 'id' in link ? facts.plan.events.find((e) => e.id === link.id) : undefined;
    if (made) add({ id: id(made.ref), ref: made.ref, name: made.name, created: true });
    else if (known) add({ id: known.id, ref: null, name: known.name, created: false });
  }
  for (const e of plan.events) add({ id: id(e.ref), ref: e.ref, name: e.name, created: true });
  return out;
}

/** The apply answer: made objects first, then the existing zones and events the sessions point at. */
function resultOf(
  plan: ScanSetupPlan,
  facts: SetupFacts,
  prepared: PreparedSetup,
  secrets: {
    staff: Map<string, string>;
    pairing: Map<string, ScanSetupResult['sessions'][number]['devices'][number]['pairing']>;
  },
  mode: Mode,
): ScanSetupResult {
  const id = (ref: string) => prepared.ids.get(ref) ?? ref;
  const known = <T extends { id: string; name: string }>(rows: T[], ids: string[]) =>
    ids.flatMap((x) => {
      const row = rows.find((r) => r.id === x);
      return row ? { id: x, ref: null, name: row.name, created: false } : [];
    });
  return {
    replayed: false,
    pairingReissued: false,
    mode,
    sessions: plan.sessions.map((s) => ({
      id: id(s.ref),
      ref: s.ref,
      name: s.name,
      devices: s.devices.map((d) => ({
        id: id(d.ref),
        name: d.name,
        pairing: secrets.pairing.get(id(d.ref)) ?? null,
      })),
    })),
    zones: [
      ...plan.zones.map((z) => ({ id: id(z.ref), ref: z.ref, name: z.name, created: true })),
      ...known(facts.plan.zones, links(plan.sessions.map((s) => s.zones))),
    ],
    events: orderedEvents(plan, facts, id),
    staff: plan.staff.map((s) => ({
      id: id(s.ref),
      name: s.name,
      role: s.role,
      pin: secrets.staff.get(id(s.ref)) ?? null,
    })),
    checks: plan.checks,
  };
}

/**
 * One batch: every statement of every object, and the setup's audit row, under one grant. Any
 * failure writes nothing. The PINs and pairing codes are in the answer and nowhere else.
 */
export async function applySetupPlan(
  ctx: ServiceContext,
  actorId: string,
  authority: TenantPassWrite,
  plan: ScanSetupPlan,
  facts: SetupFacts,
  options: ApplyOptions,
): Promise<ScanSetupResult> {
  const { orgId, mode } = authority;
  assertKeyScope(authority, plan);
  // Scan passes made a session and nothing else, and never stopped on a check.
  const setup: ScanSetupPlan = options.setupTemplateId
    ? { ...plan, sessions: plan.sessions.map((s) => ({ ...s, devices: [] })) }
    : plan;
  const capture = newCapture({ userId: actorId, authority, orgId, mode, origin: options.origin });
  const prepared = await prepareSetup(ctx, setup, capture, facts, {
    pairNow: authority.kind === 'session' && options.setupTemplateId === undefined,
    ...(options.setupTemplateId ? { setupTemplateId: options.setupTemplateId } : {}),
  });
  const g = adminGrant(
    ctx,
    'org_mode.scan.setup.apply',
    actorId,
    authority,
    orgId,
    prepared.checks,
    SETUP_APPLY_CODES,
  );
  for (const z of prepared.zones) zoneStatements(g, ctx, z, capture);
  for (const e of prepared.events) eventStatements(g, ctx, e, capture);
  const staff = new Map<string, string>();
  for (const s of prepared.staff) {
    const made = staffStatements(g, ctx, s, capture);
    staff.set(made.id, made.pin);
  }
  const pairing = new Map<
    string,
    ScanSetupResult['sessions'][number]['devices'][number]['pairing']
  >();
  for (const s of prepared.sessions) {
    sessionStatements(g, ctx, s.plan, capture);
    for (const d of s.devices) {
      const made = scanningDeviceStatements(g, ctx, d, capture);
      pairing.set(made.id, made.pairing);
    }
  }
  if (options.setupTemplateId === undefined)
    g.add(
      audited(g, ctx, {
        orgId,
        ...adminActorOf(authority, actorId),
        action: 'scan.setup.apply',
        targetType: 'scanning_session',
        targetId: prepared.sessions[0]?.plan.id ?? '',
        detail: {
          mode,
          preset: plan.preset,
          zones: plan.zones.length,
          events: plan.events.length,
          staff: plan.staff.length,
          sessions: plan.sessions.length,
          devices: plan.sessions.reduce((n, s) => n + s.devices.length, 0),
        },
      }),
    );
  try {
    await g.commit();
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique')
      throw new ConflictError(
        'A name or key was taken while setting up. Try again.',
        'SCAN_SETUP_NAME_TAKEN',
      );
    throw error;
  }
  return resultOf(setup, facts, prepared, { staff, pairing }, mode);
}
