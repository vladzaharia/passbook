import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../test/helpers/index.ts';
import { createApp } from '../app.ts';
import { type Kit, setupKit } from '../modules/passes/pass-test-fixtures.ts';
import { createAuthStores } from '../stores.ts';
import { run } from './db.ts';

// A platform key (no org) is platform authority, not an org's API use: `api` off does not stop it, on
// every read path alike, however the handler checks the org (assertOrgAccess or tenantAuthorityOf). An
// org-bound key of the same org is refused on all of them.
const SCOPES = ['passes:read', 'templates:read', 'scans:read'];
let kit: Kit;
let app: ReturnType<typeof createApp>;
let off: string;
let on: string;
let orgKey: Record<string, string>;
let platformKey: Record<string, string>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: createAuthStores(kit.env, kit.clock), clock: kit.clock });
  off = (await makeOrg(kit.fx)).id;
  on = (await makeOrg(kit.fx)).id;
  await run(
    kit.env.DB,
    "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'api', '\"off\"', 1)",
    [off],
  );
  orgKey = (await makeApiKey(kit.fx, { orgId: off, scopes: SCOPES })).headers;
  platformKey = (await makeApiKey(kit.fx, { orgId: null, scopes: SCOPES })).headers;
});

const get = (path: string, orgId: string, headers: Record<string, string>) =>
  app.request(
    `https://wallet.test${path}${path.includes('?') ? '&' : '?'}orgId=${orgId}`,
    { headers },
    kit.env,
  );

// pass-access.ts (requireTenantPassRead), templates/service-access.ts, templates/eligible.ts,
// scan/routes-scans.ts: each checks a key with assertOrgAccess only.
const PATHS = [
  '/api/v1/passes',
  '/api/v1/templates',
  '/api/v1/templates/eligible?mode=live&provider=apple',
  '/api/v1/scans',
];

describe('platform keys and the api gate', () => {
  for (const path of PATHS) {
    it(`${path}: a platform key reads an api=off org exactly as it reads an api=on org`, async () => {
      const [a, b] = [await get(path, off, platformKey), await get(path, on, platformKey)];
      expect({ path, status: a.status }).toEqual({ path, status: b.status });
      expect(await a.clone().text()).not.toContain('FEATURE_NOT_INCLUDED');
      expect(a.status, path).toBe(200);
    });

    it(`${path}: the org-bound key of the api=off org is refused`, async () => {
      await expectProblem(await get(path, off, orgKey), 403, 'FEATURE_NOT_INCLUDED');
    });
  }
});
