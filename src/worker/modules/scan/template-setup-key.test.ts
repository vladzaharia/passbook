import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import type { TemplateScanSetup } from '../../../shared/contracts/scan-template-setup.ts';
import { createApp } from '../../app.ts';
import { ROLE_PRESETS } from '../../platform/api-scopes.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { grantAuthorityOf } from './repo-admin-grant.ts';
import { ADMIN_KEY_PURPOSES, WRITE_KEY_PURPOSES } from './repo-admin-purposes.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { eventTemplate } from './template-setup-test-fixtures.ts';

const fixture = scanningSessionsFixture();
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  await fixture.setup();
  const { kit } = fixture;
  app = createApp({
    stores: {
      ...fixture.fake.stores,
      apiKeys: createApiKeyStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

const call = (id: string, headers: Record<string, string>, orgId = fixture.kit.org.id) =>
  app.request(
    `https://wallet.test/api/v1/templates/${id}/scan-setup`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId, timeZone: 'UTC' }),
    },
    fixture.kit.env,
  );
const keyOf = (scopes: string[], over: { roles?: string[]; mode?: 'live' | 'test' } = {}) =>
  makeApiKey(fixture.kit.fx, { orgId: fixture.kit.org.id, scopes, ...over });
/** A role key as minted: the role's bundle is written onto the key, the role is a label. */
const roleKey = (role: OrgRole) => keyOf([...ROLE_PRESETS[role]], { roles: [role] });
const template = () =>
  eventTemplate(fixture.kit, 'Key ticket', {
    scan: { actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }] },
  });
const sessions = (id: string) =>
  all<{ id: string; created_by: string | null }>(
    fixture.kit.env.DB,
    'SELECT id, created_by FROM scanning_sessions WHERE org_id = ? AND setup_template_id = ?',
    [fixture.kit.org.id, id],
  );

describe('template scan setup by API key', () => {
  it('sets up as the key: no user creator, the audit row names the key, and a repeat reuses the session', async () => {
    const id = await template();
    const k = await keyOf(['scanning:write']);
    const res = await call(id, k.headers);
    expect(res.status).toBe(200);
    const made = (await res.json()) as TemplateScanSetup;
    expect(made.created).toBe(true);
    const [session] = await sessions(id);
    expect(session?.created_by).toBeNull();
    expect(
      await first(
        fixture.kit.env.DB,
        "SELECT actor_type AS t, actor_id AS a FROM audit_log WHERE action = 'scan.template_setup' AND target_id = ?",
        [session?.id ?? ''],
      ),
    ).toEqual({ t: 'api_key', a: k.id });
    const again = (await (await call(id, k.headers)).json()) as TemplateScanSetup;
    expect(again).toMatchObject({ created: false, session: { id: session?.id } });
    expect(await sessions(id)).toHaveLength(1);
  });

  it('is open to the org_admin role preset and closed to the roles without scanning:manage', async () => {
    const id = await template();
    for (const role of ['integration_admin', 'pass_operator', 'read_only'])
      await expectProblem(
        await call(id, (await roleKey(role as OrgRole)).headers),
        403,
        'MISSING_SCOPE',
      );
    expect(await sessions(id)).toHaveLength(0);
    expect((await call(id, (await roleKey('org_admin')).headers)).status).toBe(200);
    expect(await sessions(id)).toHaveLength(1);
  });

  it('refuses a key without the scope, including the terminal scope, writing nothing', async () => {
    const id = await template();
    for (const scopes of [['scans:write', 'scans:read'], ['passes:write'], ['templates:read']])
      await expectProblem(await call(id, (await keyOf(scopes)).headers), 403, 'MISSING_SCOPE');
    expect(await sessions(id)).toHaveLength(0);
  });

  it('cannot name another org, and a platform-less key of another org finds nothing', async () => {
    const id = await template();
    const other = await makeOrg(fixture.kit.fx);
    const k = await keyOf(['scanning:write']);
    await expectProblem(await call(id, k.headers, other.id), 404, 'ORG_NOT_FOUND');
    const foreign = await makeApiKey(fixture.kit.fx, {
      orgId: other.id,
      scopes: ['scanning:write'],
    });
    await expectProblem(await call(id, foreign.headers), 404, 'ORG_NOT_FOUND');
    expect(await sessions(id)).toHaveLength(0);
  });

  it('stops at once for a revoked, expired or retired key', async () => {
    const id = await template();
    const revoked = await keyOf(['scanning:write']);
    await run(fixture.kit.env.DB, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
      fixture.kit.clock.now(),
      revoked.id,
    ]);
    const retired = await keyOf(['scanning:write']);
    await run(fixture.kit.env.DB, 'UPDATE api_keys SET retire_at = ? WHERE id = ?', [
      fixture.kit.clock.now() + 1000,
      retired.id,
    ]);
    fixture.kit.clock.advance(2000);
    for (const k of [revoked, retired])
      await expectProblem(await call(id, k.headers), 401, 'INVALID_API_KEY');
    expect(await sessions(id)).toHaveLength(0);
  });

  it('works in the key mode: a test key makes test-mode rows', async () => {
    const id = await template();
    const k = await keyOf(['scanning:write'], { mode: 'test' });
    expect((await call(id, k.headers)).status).toBe(200);
    expect(
      await first(
        fixture.kit.env.DB,
        "SELECT mode FROM scanning_sessions WHERE org_id = ? AND setup_template_id = ? AND mode = 'test'",
        [fixture.kit.org.id, id],
      ),
    ).toEqual({ mode: 'test' });
  });
});

describe('which scan admin grants a key may hold', () => {
  const key = (scope: string) => ({
    kind: 'api_key' as const,
    orgId: 'o1',
    orgAccessRevision: 1,
    keyId: 'k1',
    keyOrgId: 'o1',
    scopes: [scope as never],
    scope: scope as never,
    mode: 'live' as const,
  });

  // Pinned: adding a purpose here is a security decision, so it must change this list too.
  const WRITE_ALLOWED = [
    'org.scan.scanner.mode',
    'org.scan.zone.create',
    'org.scan.zone.update',
    'org_mode.scan.device.update',
    'org_mode.scan.event.archive',
    'org_mode.scan.event.assign',
    'org_mode.scan.event.create',
    'org_mode.scan.event.update',
    'org_mode.scan.scanner.create',
    'org_mode.scan.scanner.revoke',
    'org_mode.scan.scanner.update',
    'org_mode.scan.session.create',
    'org_mode.scan.session.hold',
    'org_mode.scan.session.update',
    'org_mode.scan.setup.apply',
    'org_mode.scan.setup.create',
    'org_mode.scan.visits.reset',
  ];
  const ADMIN_ALLOWED = [
    'org.scan.staff.create',
    'org.scan.staff.pin_reset',
    'org.scan.staff.update',
    'org_mode.scan.pairing.create',
    'org_mode.scan.pairing.token',
    'org_mode.scan.scanner.create',
    'org_mode.scan.setup.apply',
    'org_mode.scan.setup.create',
  ];
  const ADMIN_ONLY = ADMIN_ALLOWED.filter((p) => !WRITE_ALLOWED.includes(p));
  const NEVER = [
    'org_mode.scan.pair',
    'org_mode.scan.pairing.here',
    'org_mode.scan.pairing.redeem',
    'org_mode.scan.pairing.unpair',
    'org_mode.scan.setup.admin_session',
    'org_mode.scan.setup.update',
    'org.scan.staff.pin',
    'org_mode.scan.staff.bind',
    'org_mode.scan.staff.unbind',
    'org_mode.scan.tag.bind',
    'org_mode.scan.tag.enroll',
    'org_mode.scan.tag.unbind',
    'org_mode.nfc.keyset.create',
  ];

  it('holds exactly the expected purposes, each granted to a live key of the scope in the org', () => {
    expect([...WRITE_KEY_PURPOSES].sort()).toEqual(WRITE_ALLOWED);
    expect([...ADMIN_KEY_PURPOSES].sort()).toEqual(ADMIN_ALLOWED);
    for (const purpose of WRITE_ALLOWED)
      expect(grantAuthorityOf(key('scanning:write'), 'k1', 'o1', purpose)).toMatchObject({
        keyId: 'k1',
      });
    for (const purpose of ADMIN_ALLOWED)
      expect(grantAuthorityOf(key('scanning:admin'), 'k1', 'o1', purpose)).toMatchObject({
        keyId: 'k1',
      });
  });

  it('a write key makes no code and no staff; an admin key does not edit zones or events', () => {
    for (const purpose of ADMIN_ONLY)
      expect(() => grantAuthorityOf(key('scanning:write'), 'k1', 'o1', purpose), purpose).toThrow();
    for (const purpose of WRITE_ALLOWED.filter((p) => !ADMIN_ALLOWED.includes(p)))
      expect(() => grantAuthorityOf(key('scanning:admin'), 'k1', 'o1', purpose), purpose).toThrow();
  });

  it('refuses both scopes every purpose that stays with a person: pair here, redeem, unpair, admin sessions, tags, NFC', () => {
    for (const purpose of NEVER)
      for (const scope of ['scanning:write', 'scanning:admin'])
        expect(() => grantAuthorityOf(key(scope), 'k1', 'o1', purpose), purpose).toThrow();
  });

  it('binds every purpose to the key org: a platform key is refused', () => {
    for (const [scope, list] of [
      ['scanning:write', WRITE_ALLOWED],
      ['scanning:admin', ADMIN_ALLOWED],
    ] as const)
      for (const purpose of list)
        expect(
          () => grantAuthorityOf({ ...key(scope), keyOrgId: null }, 'k1', 'o1', purpose),
          purpose,
        ).toThrow();
  });

  it('refuses an admin key in test mode for every admin purpose', () => {
    for (const purpose of ADMIN_ALLOWED)
      expect(
        () =>
          grantAuthorityOf(
            { ...key('scanning:admin'), mode: 'test' as const },
            'k1',
            'o1',
            purpose,
          ),
        purpose,
      ).toThrow();
  });

  it('needs a live key for the scanner mode move, with its own code', () => {
    const test = { ...key('scanning:write'), mode: 'test' as const };
    expect(grantAuthorityOf(test, 'k1', 'o1', 'org.scan.zone.create')).toMatchObject({
      kind: 'api_key',
    });
    expect(() => grantAuthorityOf(test, 'k1', 'o1', 'org.scan.scanner.mode')).toThrow(
      expect.objectContaining({ code: 'SCAN_MODE_LIVE_ONLY' }),
    );
    expect(grantAuthorityOf(test, 'k1', 'o1', 'org_mode.scan.event.create')).toMatchObject({
      keyId: 'k1',
    });
    // A write key makes a device or scanner with no code in either mode.
    expect(grantAuthorityOf(test, 'k1', 'o1', 'org_mode.scan.scanner.create')).toMatchObject({
      keyId: 'k1',
    });
  });

  it('refuses another scope, another key id or another org, whatever the purpose', () => {
    const purpose = 'org_mode.scan.session.create';
    expect(() => grantAuthorityOf(key('scans:write'), 'k1', 'o1', purpose)).toThrow();
    expect(() => grantAuthorityOf(key('scanning:write'), 'k2', 'o1', purpose)).toThrow();
    expect(() => grantAuthorityOf(key('scanning:write'), 'k1', 'o2', purpose)).toThrow();
  });
});
