import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  ScanSetupPlan,
  ScanSetupResult,
  SetupLink,
} from '../../../shared/contracts/scan-setup-intent.ts';
import type { Grant } from '../../platform/authority.ts';
import { grantedBatchWith } from '../../platform/authority-batch.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { IdempotencyId } from '../../platform/repo-idempotency.ts';
import { settleStatement } from '../../platform/repo-idempotency.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertSharedWrite } from '../orgs/shared-write.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { isDeveloperOrg } from '../passes/repo-authority.ts';
import { scanningDeviceStatements } from './device-statements.ts';
import { eventStatements } from './events-statements.ts';
import { chargeSecrets, SETUP_CALLS } from './key-credentials.ts';
import { adminActorOf, adminGrant, audited, SETUP_APPLY, setupTables } from './repo-admin-grant.ts';
import { sessionStatements } from './scanning-session-insert.ts';
import { newCapture } from './setup-capture.ts';
import type { SetupFacts } from './setup-intent-load.ts';
import { type PreparedSetup, prepareSetup } from './setup-intent-plan.ts';
import { staffStatements } from './staff-statements.ts';
import { zoneStatements } from './zones-statements.ts';

/** Every object's rules share one grant, so a refusal answers with one code: the plan changed under the call. */
export const SETUP_GRANT = {
  codes: {
    config: 'SCAN_SETUP_CHANGED',
    lineage: 'SCAN_SETUP_CHANGED',
    release: 'SCAN_SETUP_CHANGED',
    stale: 'SCAN_SETUP_CHANGED',
  },
} as const;

export interface ApplyOptions {
  origin: string;
  /** Scan passes: the one session of this template. It makes no device, as it never did. */
  setupTemplateId?: string;
  /** The idempotency claim of this call: its answer commits in the same batch as the work. */
  settle?: IdempotencyId;
  /** The caller's network prefix, in the audit rows of the credentials the setup makes. */
  ip?: string | null;
}

/** Credentials (staff PINs, pairing codes) need `scanning:admin`, org-bound and live; zones need a live key. */
const mayMintSecrets = (authority: TenantPassWrite) =>
  authority.kind === 'session' ||
  (authority.scope === 'scanning:admin' &&
    authority.keyOrgId !== null &&
    authority.mode === 'live');

/** Devices come with a pairing code for those who may see one. A template setup makes none. */
export const pairsNow = (authority: TenantPassWrite, options: { setupTemplateId?: string }) =>
  mayMintSecrets(authority) && options.setupTemplateId === undefined;

/** What a key may name, checked the same for a dry run and an apply. */
export async function assertSetupScope(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  plan: ScanSetupPlan,
): Promise<void> {
  if (authority.kind === 'session') return;
  if (plan.zones.length > 0) await assertSharedWrite(ctx, authority, authority.orgId, 'zones');
  if (plan.staff.length > 0 && !mayMintSecrets(authority))
    throw new ForbiddenError(
      authority.scope === 'scanning:admin'
        ? 'Staff are shared with live mode. Add them with an org-bound live key.'
        : 'Adding staff needs the scanning:admin scope.',
      authority.scope === 'scanning:admin' ? 'SCAN_SETUP_LIVE_ONLY' : 'SCAN_SETUP_ADMIN_SCOPE',
    );
}

/** Devices per grant: each adds about three lineage checks to its grant row (90 binds). */
const DEVICES_PER_GRANT = 10;

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

/** The stored answer holds no secret: PINs and pairing codes are shown to the first caller only. */
export const redacted = (r: ScanSetupResult): ScanSetupResult => ({
  ...r,
  staff: r.staff.map((s) => ({ ...s, pin: null })),
  sessions: r.sessions.map((s) => ({
    ...s,
    devices: s.devices.map((d) => ({ ...d, pairing: null })),
  })),
});

/** The setup as the capture and the plan functions see it: the rules of apply, with nothing written. */
export async function prepareForCaller(
  ctx: ServiceContext,
  actorId: string,
  authority: TenantPassWrite,
  plan: ScanSetupPlan,
  facts: SetupFacts,
  options: ApplyOptions,
) {
  await assertSetupScope(ctx, authority, plan);
  // Scan passes made a session and nothing else, and never stopped on a check.
  const setup: ScanSetupPlan = options.setupTemplateId
    ? { ...plan, sessions: plan.sessions.map((s) => ({ ...s, devices: [] })) }
    : plan;
  const capture = newCapture({
    userId: actorId,
    authority,
    orgId: authority.orgId,
    mode: authority.mode,
    origin: options.origin,
    ip: options.ip ?? null,
  });
  const prepared = await prepareSetup(ctx, setup, capture, facts, {
    pairNow: pairsNow(authority, options),
    ...(options.setupTemplateId ? { setupTemplateId: options.setupTemplateId } : {}),
  });
  return { setup, capture, prepared };
}

/**
 * One batch: every statement of every object, the setup's audit row and the idempotency answer,
 * under one grant. Any failure writes nothing. The PINs and pairing codes are in the answer and
 * nowhere else.
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
  const { setup, capture, prepared } = await prepareForCaller(
    ctx,
    actorId,
    authority,
    plan,
    facts,
    options,
  );
  const sandbox = await isDeveloperOrg(ctx.env.DB, orgId);
  const pairs = pairsNow(authority, options);
  const secrets =
    prepared.staff.length +
    (pairs ? prepared.sessions.reduce((n, s) => n + s.devices.length, 0) : 0);
  const refund = await chargeSecrets(ctx, authority, secrets, SETUP_CALLS);
  try {
    // Each grant row has a bind budget and every write adds lineage checks to its row, so the batch is
    // several grants in order (a later one sees the earlier ones' writes), sharing their refusal codes.
    const grant = (checks: Check[] = []) =>
      adminGrant(
        ctx,
        SETUP_APPLY,
        actorId,
        authority,
        orgId,
        checks,
        SETUP_GRANT.codes,
        undefined,
        setupTables(authority, sandbox),
      );
    const grants: Grant[] = [grant(prepared.checks)];
    const [shared] = grants;
    if (!shared) throw new Error('No grant.');
    for (const z of prepared.zones) zoneStatements(shared, ctx, z, capture);
    for (const e of prepared.events) eventStatements(shared, ctx, e, capture);
    const people = grant();
    grants.push(people);
    const staff = new Map<string, string>();
    for (const s of prepared.staff) {
      const made = staffStatements(people, ctx, s, capture);
      staff.set(made.id, made.pin);
    }
    const pairing = new Map<
      string,
      ScanSetupResult['sessions'][number]['devices'][number]['pairing']
    >();
    for (const s of prepared.sessions) sessionStatements(people, ctx, s.plan, capture);
    const devices = prepared.sessions.flatMap((s) => s.devices);
    for (let at = 0; at < devices.length; at += DEVICES_PER_GRANT) {
      const g = grant();
      grants.push(g);
      for (const d of devices.slice(at, at + DEVICES_PER_GRANT)) {
        const made = scanningDeviceStatements(g, ctx, d, capture);
        pairing.set(made.id, made.pairing);
      }
    }
    if (options.setupTemplateId === undefined)
      people.add(
        audited(people, ctx, {
          orgId,
          ...adminActorOf(authority, actorId, options.ip),
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
            devices: devices.length,
            pins: staff.size,
            pairingCodes: [...pairing.values()].filter((p) => p !== null).length,
          },
        }),
      );
    // The ids are made before the commit, so the answer is too: its redacted copy commits with the work.
    const result = resultOf(setup, facts, prepared, { staff, pairing }, mode);
    const settle = options.settle
      ? [settleStatement(ctx.env.DB, options.settle, 200, JSON.stringify(redacted(result)))]
      : [];
    try {
      await grantedBatchWith(ctx.env.DB, grants, [], settle);
    } catch (error) {
      if (classifyD1Error(error)?.kind === 'unique')
        throw new ConflictError(
          'A name or key was taken while setting up. Try again.',
          'SCAN_SETUP_NAME_TAKEN',
        );
      throw error;
    }
    return result;
  } catch (error) {
    // One batch: a failure wrote nothing, so the budget is given back.
    await refund();
    throw error;
  }
}
