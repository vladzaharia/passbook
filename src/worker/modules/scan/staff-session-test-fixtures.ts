import { expect } from 'vitest';
import { type FakeAuth, fakeAuth, type StaffFixture } from '../../../../test/helpers/index.ts';
import { ProblemSchema } from '../../../shared/contracts/common.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { createApp } from '../../app.ts';
import type { Pass } from '../passes/repo.ts';
import { createScannerStore } from './auth-store.ts';
import { getScanner } from './repo-device.ts';
import { staffPinHashRow } from './repo-staff-session-test-fixtures.ts';
import { codeOf, key, ORIGIN, type ScanKit, setupScanKit } from './test-kit.ts';

export type Headers = Record<string, string>;

export function staffSessionFixture() {
  let kit: ScanKit;
  let fake: FakeAuth;
  let call: (method: string, path: string, headers: Headers, body?: unknown) => Promise<Response>;
  let managerTemplate: string;
  let deskTemplate: string;

  async function setup() {
    kit = await setupScanKit();
    fake = fakeAuth(ORIGIN);
    fake.bindSessions(kit.env.DB, kit.clock);
    const app = createApp({
      stores: { ...fake.stores, scanners: createScannerStore(kit.env, kit.clock) },
      clock: kit.clock,
    });
    call = (method, path, headers, body) =>
      Promise.resolve(
        app.request(
          `${ORIGIN}/api/v1${path}`,
          {
            method,
            headers: { ...headers, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          kit.env,
        ),
      );
    managerTemplate = await kit.scanTemplate('Manager check-in', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', minRole: 'manager' }],
    });
    deskTemplate = await kit.scanTemplate('Desk check-in', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', minRole: 'desk' }],
    });
  }

  const signIn = (headers: Headers, staff: StaffFixture, pin: unknown = staff.pin) =>
    call('POST', '/scan/staff', headers, { staffId: staff.id, pin });
  const signOut = (headers: Headers) => call('DELETE', '/scan/staff', headers);
  const getSession = (headers: Headers) => call('GET', '/scan/session', headers);
  const action = (headers: Headers, pass: Pass, scope?: unknown) =>
    call('POST', '/scan/actions', headers, {
      idempotencyKey: key(),
      input: codeOf(pass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
      ...(scope ? { scope } : {}),
    });
  const staffHash = async (staff: StaffFixture) => {
    const row = await staffPinHashRow(kit.env.DB, staff.id);
    expect(row?.pin_hash).toEqual(expect.any(String));
    return row?.pin_hash ?? '';
  };

  function noSecrets(body: unknown, ...secrets: string[]) {
    const text = JSON.stringify(body);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"(?:pin|pinHash|pin_hash)"\s*:/);
  }

  async function session(response: Response, ...secrets: string[]) {
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    noSecrets(body, ...secrets);
    const parsed = ScanSessionSchema.parse(body);
    // Schema parsing strips extra keys; compare the raw projections too.
    if (!body || typeof body !== 'object' || !('staff' in body) || !('staffList' in body))
      throw new Error('Missing staff projections in scanner session');
    expect(body.staff).toEqual(parsed.staff);
    expect(body.staffList).toEqual(parsed.staffList);
    return parsed;
  }

  async function problem(response: Response, status: number, code: string, ...secrets: string[]) {
    expect(response.status).toBe(status);
    const raw: unknown = await response.json();
    const body = ProblemSchema.parse(raw);
    expect(body).toMatchObject({ status, code });
    noSecrets(raw, ...secrets);
    const { requestId: _requestId, ...stable } = body;
    return stable;
  }

  async function binding(id: string) {
    const row = await getScanner(kit.env.DB, id);
    expect(row).not.toBeNull();
    return { staffId: row?.staffId, staffSince: row?.staffSince, staffSeenAt: row?.staffSeenAt };
  }

  return {
    setup,
    get kit() {
      return kit;
    },
    get fake() {
      return fake;
    },
    get call() {
      return call;
    },
    get managerTemplate() {
      return managerTemplate;
    },
    get deskTemplate() {
      return deskTemplate;
    },
    signIn,
    signOut,
    getSession,
    action,
    staffHash,
    session,
    problem,
    binding,
  };
}
