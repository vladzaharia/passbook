import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import type { TemplateScanSetup } from '../../../shared/contracts/scan-template-setup.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
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
        await call(id, (await keyOf([], { roles: [role] })).headers),
        403,
        'MISSING_SCOPE',
      );
    expect(await sessions(id)).toHaveLength(0);
    expect((await call(id, (await keyOf([], { roles: ['org_admin'] })).headers)).status).toBe(200);
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
    expect((await call(id, k.headers, other.id)).status).toBe(403);
    const foreign = await makeApiKey(fixture.kit.fx, {
      orgId: other.id,
      scopes: ['scanning:write'],
    });
    expect((await call(id, foreign.headers)).status).toBe(403);
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
