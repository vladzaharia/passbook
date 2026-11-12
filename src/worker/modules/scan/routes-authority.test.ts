import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { createScannerStore } from './auth-store.ts';
import {
  codeOf,
  grantScanMembership,
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

type Headers = Record<string, string>;

let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
let templateId: string;
let reader: Headers;
let platformReader: Headers;
let operator: Headers;
let platformOperator: Headers;
let manager: Headers;
let outsider: Headers;
let platformOutsider: Headers;

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Tenant scanner routes', {
    actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
  });
  const otherOrg = await makeOrg(kit.fx);
  const session = async (
    roles: ('user' | 'admin')[],
    membership: 'read_only' | 'pass_operator' | 'org_admin',
    orgId = kit.org.id,
  ) => {
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, orgId, user.id, [membership]);
    return (await makeSession(kit.fx, { userId: user.id, roles })).headers;
  };
  reader = await session(['user'], 'read_only');
  platformReader = await session(['user', 'admin'], 'read_only');
  operator = await session(['user'], 'pass_operator');
  platformOperator = await session(['user', 'admin'], 'pass_operator');
  manager = await session(['user'], 'org_admin');
  outsider = await session(['user'], 'org_admin', otherOrg.id);
  platformOutsider = await session(['user', 'admin'], 'org_admin', otherOrg.id);
  app = createApp({
    clock: kit.clock,
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
  });
});

const scope = () => ({ orgId: kit.org.id, timeZone: 'UTC' });
const query = () => new URLSearchParams(scope()).toString();
const capabilities = {
  width: 390,
  height: 800,
  touch: true,
  camera: 'available',
  keyboard: true,
  nativeBarcode: false,
  surfaces: ['phone'],
  preferred: 'phone',
};

function call(method: string, path: string, headers: Headers, body?: unknown) {
  return app.request(
    `${ORIGIN}/api/v1/scan${path}`,
    {
      method,
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
}

async function forbidden(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
}

describe('scanner route tenant capabilities', () => {
  it('lets a non-platform-admin read the scanner views, resolve, search and fetch a granted asset', async () => {
    for (const path of ['/session', '/scans', '/summary', '/stats', '/activity']) {
      const response = await call('GET', `${path}?${query()}`, reader);
      expect(response.status, path).toBe(200);
      if (path === '/session') expect(await response.json()).toMatchObject({ principal: 'admin' });
    }

    const pass = await kit.scanPass(templateId);
    const resolved = await call('POST', '/resolve', reader, {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      scope: scope(),
    });
    expect(resolved.status).toBe(200);
    const result = (await resolved.json()) as {
      kind: string;
      card: { passId: string; passView: { assetGrant: string } };
    };
    expect(result).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    const image = await call(
      'GET',
      `/passes/${pass.id}/assets/icon.png?g=${encodeURIComponent(result.card.passView.assetGrant)}&${query()}`,
      reader,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');

    const lookup = await call('POST', '/lookup', reader, { q: pass.id, scope: scope() });
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ items: [{ passId: pass.id }] });
    expect(
      await first(kit.env.DB, 'SELECT count(*) AS n FROM scans WHERE pass_id=?', [pass.id]),
    ).toEqual({ n: 0 });
  });

  it('denies every read and mutation without membership in the selected org, including platform admins', async () => {
    const pass = await kit.scanPass(templateId);
    const scanId = kit.fx.ids.id();
    const requests: [string, string, unknown?][] = [
      ...['/session', '/scans', '/summary', '/stats', '/activity'].map((path): [string, string] => [
        'GET',
        `${path}?${query()}`,
      ]),
      ['GET', `/passes/${pass.id}/assets/icon.png?g=x&${query()}`],
      [
        'POST',
        '/resolve',
        { idempotencyKey: key(), input: codeOf(pass), clientTs: kit.clock.now(), scope: scope() },
      ],
      ['POST', '/lookup', { q: pass.id, scope: scope() }],
      [
        'POST',
        '/actions',
        {
          idempotencyKey: key(),
          input: codeOf(pass),
          clientTs: kit.clock.now(),
          actionId: 'enter',
          scope: scope(),
        },
      ],
      ['POST', `/scans/${scanId}/undo`, { idempotencyKey: key(), scope: scope() }],
      ['POST', '/device', { capabilities, scope: { ...scope(), setupId: kit.fx.ids.id() } }],
      ['POST', '/staff', { staffId: kit.fx.ids.id(), pin: '123456', scope: scope() }],
      ['DELETE', '/staff', { scope: scope() }],
    ];
    for (const headers of [outsider, platformOutsider])
      for (const [method, path, body] of requests)
        await forbidden(await call(method, path, headers, body));
  });

  it('rechecks the D1 membership on the next scanner request after revocation', async () => {
    const user = await makeUser(kit.fx);
    const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
    const headers = (await makeSession(kit.fx, { userId: user.id, roles: ['user'] })).headers;
    expect((await call('GET', `/session?${query()}`, headers)).status).toBe(200);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      membershipId,
    ]);
    await forbidden(await call('GET', `/session?${query()}`, headers));
    await forbidden(await call('POST', '/lookup', headers, { q: 'example', scope: scope() }));
  });

  it('keeps action and undo with pass operators, but denies read-only members and their platform admins', async () => {
    const pass = await kit.scanPass(templateId);
    expect((await call('GET', `/session?${query()}`, operator)).status).toBe(200);
    expect((await call('GET', `/scans?${query()}`, operator)).status).toBe(200);
    const resolved = await call('POST', '/resolve', operator, {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      scope: scope(),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    expect((await call('POST', '/lookup', operator, { q: pass.id, scope: scope() })).status).toBe(
      200,
    );
    const action = () => ({
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'enter',
      scope: scope(),
    });
    const made = await call('POST', '/actions', operator, action());
    expect(made.status).toBe(200);
    const result = (await made.json()) as { kind: string; scanId: string | null };
    expect(result.kind).toBe('ok');
    if (!result.scanId) throw new Error('Missing check-in scan');

    for (const headers of [reader, platformReader]) {
      await forbidden(await call('POST', '/actions', headers, action()));
      await forbidden(
        await call('POST', `/scans/${result.scanId}/undo`, headers, {
          idempotencyKey: key(),
          scope: scope(),
        }),
      );
    }
    expect(
      await first(kit.env.DB, 'SELECT undone_at FROM scans WHERE id=?', [result.scanId]),
    ).toEqual({ undone_at: null });
    expect(
      await first(kit.env.DB, 'SELECT count(*) AS n FROM scans WHERE pass_id=?', [pass.id]),
    ).toEqual({ n: 1 });
    const undone = await call('POST', `/scans/${result.scanId}/undo`, operator, {
      idempotencyKey: key(),
      scope: scope(),
    });
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ kind: 'ok' });
  });

  it('uses desk permissions for pass operators regardless of platform-admin status', async () => {
    const restricted = await kit.scanTemplate('Manager-only check-in', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in', minRole: 'manager' }],
    });
    for (const headers of [operator, platformOperator, manager]) {
      const pass = await kit.scanPass(restricted);
      const response = await call('POST', '/actions', headers, {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'enter',
        scope: scope(),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject(
        headers === manager ? { kind: 'ok' } : { kind: 'heads_up', reason: 'needs_approval' },
      );
    }
  });

  it('reserves device and staff mutations for scanning managers, even for platform admins', async () => {
    const deviceBody = { capabilities, scope: { ...scope(), setupId: kit.fx.ids.id() } };
    for (const headers of [reader, platformReader, operator, platformOperator]) {
      await forbidden(await call('POST', '/device', headers, deviceBody));
      await forbidden(
        await call('POST', '/staff', headers, {
          staffId: kit.fx.ids.id(),
          pin: '123456',
          scope: scope(),
        }),
      );
      await forbidden(await call('DELETE', '/staff', headers, { scope: scope() }));
    }

    const created = await app.request(
      `${ORIGIN}/api/v1/scan-setups/admin-session`,
      {
        method: 'POST',
        headers: { ...manager, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(scope()),
      },
      kit.env,
    );
    expect(created.status).toBe(200);
    const setup = (await created.json()) as { orgId: string; setupId: string; timeZone: string };
    const reported = await call('POST', '/device', manager, { capabilities, scope: setup });
    expect(reported.status).toBe(200);
  });

  it('fails closed for other methods and scan subpaths instead of inheriting read authority', async () => {
    for (const path of ['/resolve', '/lookup', '/actions', `/scans/${kit.fx.ids.id()}/undo`])
      await forbidden(await call('GET', `${path}?${query()}`, reader));
    for (const path of ['/session', '/scans', '/summary', '/stats', '/activity'])
      await forbidden(await call('POST', path, reader, { scope: scope() }));
  });

  it('retains cookie and terminal scanner credential behavior without user membership', async () => {
    for (const kind of ['device', 'terminal'] as const) {
      const scanner = await kit.scanner({ kind, templateIds: [templateId] });
      const pass = await kit.scanPass(templateId);
      expect((await call('GET', '/session', scanner.headers)).status).toBe(200);
      expect((await call('GET', '/scans', scanner.headers)).status).toBe(200);
      const resolved = await call('POST', '/resolve', scanner.headers, {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
      });
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({ kind: 'ready' });
      const made = await call('POST', '/actions', scanner.headers, {
        idempotencyKey: key(),
        input: codeOf(pass),
        clientTs: kit.clock.now(),
        actionId: 'enter',
      });
      expect(made.status).toBe(200);
      const result = (await made.json()) as { kind: string; scanId: string | null };
      expect(result.kind).toBe('ok');
      if (!result.scanId) throw new Error('Missing check-in scan');
      const undone = await call('POST', `/scans/${result.scanId}/undo`, scanner.headers, {
        idempotencyKey: key(),
      });
      expect(undone.status).toBe(200);
      expect(await undone.json()).toMatchObject({ kind: 'ok' });
      const lookup = await call('POST', '/lookup', scanner.headers, { q: pass.id });
      expect(lookup.status).toBe(kind === 'terminal' ? 403 : 200);
      if (kind === 'terminal')
        expect(await lookup.json()).toMatchObject({ code: 'SCAN_LOOKUP_DISABLED' });
    }
  });

  it('preserves staff-optional and screen-allowed routes', async () => {
    const scanner = await kit.scanner({
      templateIds: [templateId],
      settings: { staffSignIn: true },
    });
    const staff = await kit.staff('door');
    const session = await call('GET', '/session', scanner.headers);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ state: 'staff_required' });
    expect((await call('POST', '/device', scanner.headers, { capabilities })).status).toBe(200);
    const blocked = await call('GET', '/stats', scanner.headers);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'STAFF_REQUIRED' });
    expect(
      (await call('POST', '/staff', scanner.headers, { staffId: staff.id, pin: staff.pin })).status,
    ).toBe(200);
    expect((await call('DELETE', '/staff', scanner.headers)).status).toBe(200);

    const screen = await kit.scanner({ kind: 'display', deviceRole: 'monitor' });
    expect((await call('GET', '/session', screen.headers)).status).toBe(200);
    expect((await call('POST', '/device', screen.headers, { capabilities })).status).toBe(200);
    const screenBlocked = await call('GET', '/stats', screen.headers);
    expect(screenBlocked.status).toBe(403);
    expect(await screenBlocked.json()).toMatchObject({ code: 'SCREEN_ONLY' });
  });
});
