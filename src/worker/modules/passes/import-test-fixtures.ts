import type { WorkflowStep } from 'cloudflare:workers';
import { makeSession, makeTemplate, makeUser } from '../../../../test/helpers/index.ts';
import { PassImportSchema } from '../../../shared/contracts/pass-imports.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { runPassImport } from '../../workflows/pass-import.ts';
import { grantKitMembership } from './apple-release-test-fixtures.ts';
import type { TenantPassWrite } from './http.ts';
import { importInstanceId } from './import-commit.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { tenantOrgAccessRevision } from './repo-authority.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';
import { setupTenantTestAuth } from './tenant-test-fixtures.ts';

type Headers = Record<string, string>;
export const HEAD = 'Name,Points,Email,Id';

export function importTemplate(id: string) {
  const t = makeTemplate({ id });
  (t.resolved.manifest.inputs as { properties: unknown }).properties = {
    memberName: { type: 'string', title: 'Name', minLength: 1 },
    points: { type: 'integer', title: 'Points', minimum: 0 },
  };
  return t;
}

export const plan = (over: Record<string, unknown> = {}) => ({
  mapping: { memberName: { from: '/Name' }, points: { from: '/Points' } },
  holderEmail: { from: '/Email' },
  externalId: { from: '/Id' },
  match: 'externalId',
  keepManual: false,
  save: false,
  ...over,
});

type Fn = () => Promise<unknown>;
/** A workflow step that runs its callback once; `after` sees each step's name when it has run. */
export const stepOf = (after?: (name: string) => Promise<void>) =>
  ({
    do: async (name: string, a: unknown, b?: unknown) => {
      const out = await ((typeof a === 'function' ? a : b) as Fn)();
      await after?.(name);
      return out;
    },
  }) as unknown as WorkflowStep;

export async function setupImportHarness() {
  const created: { id: string; params: unknown }[] = [];
  const workflow = {
    async create(o: { id: string; params: unknown }) {
      created.push(o);
      return { id: o.id };
    },
  };
  const kit: Kit = await setupKit({
    template: importTemplate,
    env: { PASS_IMPORT: workflow as unknown as Workflow },
  });
  const auth = await setupTenantTestAuth(kit, [kit.org.id]);
  const app = createApp({ stores: auth.stores, clock: kit.clock });
  const q = `?orgId=${kit.org.id}`;
  const admin = auth.admin();
  const keyFx = await makeTenantTestApiKey(kit.fx, {
    orgId: kit.org.id,
    scopes: ['passes:read', 'passes:write'],
  });
  const key = keyFx.headers;
  const keyAuthority: TenantPassWrite = {
    kind: 'api_key',
    orgId: kit.org.id,
    orgAccessRevision: (await tenantOrgAccessRevision(kit.env.DB, kit.org.id)) ?? 0,
    keyId: keyFx.id,
    keyOrgId: kit.org.id,
    scopes: ['passes:read', 'passes:write'],
    scope: 'passes:write',
    mode: 'live',
  };
  /** A key of its own, so a test can revoke it. */
  const newKey = () =>
    makeTenantTestApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read', 'passes:write'] });
  /** A member of their own, so a test can revoke them without touching the shared admin. */
  const newMember = async () => {
    const user = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id });
    await grantKitMembership(kit, kit.org.id, user.id, ['org_admin']);
    return {
      userId: user.id,
      headers: { ...session.headers, origin: 'https://wallet.test' } as Headers,
    };
  };
  const api = (headers: Headers, method: string, path: string, body?: unknown) =>
    app.request(
      `https://wallet.test/api/v1/pass-imports${path}${q}`,
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      kit.env,
    );
  /** Uploads and checks a file; the draft is `ready`. */
  const draft = async (csv: string, withPlan: unknown = plan(), headers = admin) => {
    const res = await api(headers, 'POST', '', {
      templateId: kit.template.id,
      source: { kind: 'file', name: 'people.csv', csv },
      plan: withPlan,
    });
    if (res.status !== 201) throw new Error(`check failed: ${res.status} ${await res.text()}`);
    return PassImportSchema.parse(await res.json());
  };
  const commit = (id: string, body: unknown = {}, headers = admin) =>
    api(headers, 'POST', `/${id}/commit`, body);
  const get = async (id: string, headers = admin) =>
    PassImportSchema.parse(await (await api(headers, 'GET', `/${id}`)).json());
  const runWorkflow = (id: string, step = stepOf()) =>
    runPassImport(
      kit.env,
      importInstanceId(id),
      { importId: id, orgId: kit.org.id, mode: 'live' },
      step,
    );
  /** A live pass with an external id and the unmarked fields of an old import. */
  async function existing(
    externalId: string,
    personalization: Record<string, unknown>,
    sources: Record<string, string> = {},
  ) {
    const pass = await kit.pass({ memberName: String(personalization.memberName) });
    await run(
      kit.env.DB,
      'UPDATE passes SET external_id = ?, personalization = ?, field_sources = ? WHERE id = ?',
      [externalId, JSON.stringify(personalization), JSON.stringify(sources), pass.id],
    );
    return pass;
  }
  return {
    kit,
    auth,
    app,
    admin,
    key,
    keyId: keyFx.id,
    keyAuthority,
    newMember,
    newKey,
    api,
    draft,
    commit,
    get,
    runWorkflow,
    existing,
    created,
    q,
  };
}
export type ImportHarness = Awaited<ReturnType<typeof setupImportHarness>>;
