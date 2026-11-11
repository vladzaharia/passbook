import { expect } from 'vitest';
import {
  type EventFixture,
  makeSession,
  makeUser,
  type ScannerFixture,
  type SessionFixture,
  type StaffFixture,
} from '../../../../test/helpers/index.ts';
import { type ScanOutcome, ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import type { Pass } from '../passes/repo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import {
  insertManagedScannerSetup,
  insertManagedSession,
  signedScanEvent,
} from './repo-action-gate-stale-budget-test-fixtures.ts';
import { scanById } from './repo-scans.ts';
import {
  codeOf,
  grantScanMembership,
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

export { effects } from './repo-action-gate-stale-budget-test-fixtures.ts';

const ACTION = { id: 'check_in', label: 'Check in', kind: 'check_in', minRole: 'manager' } as const;

export interface Suite {
  kit: ScanKit;
  template: string;
}
export interface Scenario extends Suite {
  event: EventFixture | null;
  scanner: ScannerFixture;
  manager: StaffFixture;
  pass: Pass;
  post(body: Record<string, unknown>): Promise<Response>;
  managed: { sessionId: string; membershipId: string } | null;
}
export interface ActionRequest extends Record<string, unknown> {
  idempotencyKey: string;
  input: { code: string; method: 'camera' };
  clientTs: number;
  actionId: string;
  approval: { staffId: string; pin: string };
}
export interface EffectState {
  gates: unknown[];
  presence: unknown[];
  scans: unknown[];
  events: unknown[];
  retention: unknown[];
  ledgerAll: unknown[];
  retentionAll: unknown[];
  grants: unknown[];
}
export interface MeasuredResult {
  outcome: ScanOutcome;
  observed: EffectState;
  pendingId: string;
  trips: number;
  marker: string;
}

export async function suite(): Promise<Suite> {
  const kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const template = await kit.scanTemplate('Budgeted signed gate', {
    actions: [ACTION],
    display: {
      v: 1,
      header: { title: 'Welcome', subtitle: '{{history.lastScan.action}}' },
      panels: [
        {
          id: 'p_history',
          rows: [{ id: 'r_history', type: 'history', source: 'scans', show: ['action', 'where'] }],
        },
      ],
    },
  });
  return { kit, template };
}

async function managedSession(
  kit: ScanKit,
  userId: string,
  absoluteMs?: number,
): Promise<SessionFixture> {
  if (absoluteMs === undefined) return makeSession(kit.fx, { userId, roles: ['user'] });
  const cookieValue = kit.fx.ids.token();
  const csrf = kit.fx.ids.token();
  const now = kit.clock.now();
  await insertManagedSession(
    kit.env.DB,
    await hashSessionCookie(cookieValue),
    userId,
    csrf,
    now,
    absoluteMs,
  );
  return {
    userId,
    cookieValue,
    csrf,
    headers: {
      cookie: `__Host-wallet_sid=${cookieValue}`,
      'x-csrf-token': csrf,
      'sec-fetch-site': 'same-origin',
    },
  };
}

export async function scenario(
  base: Suite,
  options: {
    event?: boolean;
    tracked?: boolean;
    photo?: boolean;
    managed?: boolean;
    sessionAbsoluteMs?: number;
  } = {},
): Promise<Scenario> {
  const { kit, template } = base;
  const event = options.event ? await kit.event({ templateIds: [template] }) : null;
  const scanner = await kit.scanner({
    ...(event ? { eventId: event.id } : { templateIds: [template] }),
    settings: {
      letInAgain: 'manager',
      ...(options.tracked
        ? { checkIn: { mode: 'in_out' as const }, direction: 'both' as const }
        : {}),
    },
  });
  const manager = await kit.staff('manager');
  const pass = await kit.scanPass(template, { memberName: 'Private budget member' });
  if (options.photo) {
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
  }
  let post: (body: Record<string, unknown>) => Promise<Response> = (body) =>
    kit.post(scanner.headers, '/actions', body);
  let managed: { sessionId: string; membershipId: string } | null = null;
  if (options.managed) {
    const user = await makeUser(kit.fx);
    const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    const session = await managedSession(kit, user.id, options.sessionAbsoluteMs);
    await insertManagedScannerSetup(kit.env.DB, scanner.id, kit.org.id, user.id);
    const app = createApp({
      stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
      clock: kit.clock,
    });
    const scope = {
      orgId: kit.org.id,
      setupId: scanner.id,
      templateIds: [template],
      timeZone: 'UTC',
    };
    post = (body) =>
      Promise.resolve(
        app.request(
          `${ORIGIN}/api/v1/scan/actions`,
          {
            method: 'POST',
            headers: { ...session.headers, origin: ORIGIN, 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, scope }),
          },
          kit.env,
        ),
      );
    managed = { sessionId: await hashSessionCookie(session.cookieValue), membershipId };
  }
  return { ...base, event, scanner, manager, pass, post, managed };
}

export function request(s: Scenario, extra: Record<string, unknown> = {}): ActionRequest {
  return {
    idempotencyKey: key(),
    input: codeOf(s.pass),
    clientTs: s.kit.clock.now(),
    actionId: ACTION.id,
    approval: { staffId: s.manager.id, pin: s.manager.pin },
    ...extra,
  };
}

export async function send(s: Scenario, body: ActionRequest = request(s)) {
  const response = await s.post(body);
  expect(response.status, await response.clone().text()).toBe(200);
  return ScanOutcomeSchema.parse(await response.json());
}

/** The recorded event and scan for a committed action, with its effect snapshot (no proofs remain). */
export async function signed(s: Scenario, scanId: string) {
  const db = s.kit.env.DB;
  const event = await signedScanEvent(db, s.pass.id, scanId);
  const scan = await scanById(db, s.kit.org.id, scanId);
  if (!event || !scan) throw new Error('Missing recorded scan evidence');
  const data = JSON.parse(event.data) as {
    authority: {
      effect: {
        gateBefore: unknown;
        gateAfter: unknown;
        presenceBefore: unknown;
        presenceAfter: unknown;
      };
    };
  };
  expect(data.authority).not.toHaveProperty('eventProof');
  return { event, scan, effect: data.authority.effect };
}
