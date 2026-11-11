import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import {
  editSessionAuthority,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
  type UserRow,
} from '../../../../test/helpers/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type OrgCapability,
  OrgCapabilitySchema,
  type OrgRole,
} from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { rolesGranting } from '../orgs/access.ts';
import { updateSettings } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { startBulkReissue } from './bulk.ts';
import { createPassRow } from './create.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { credentialReferences } from './credential-references.ts';
import {
  authOf,
  requireTenantSessionOrApiKey,
  svc,
  type TenantPassWrite,
  tenantAuthorityOf,
} from './http.ts';
import { putMemberPhoto } from './member-photo.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from './repo-authority.ts';
import { memberPhoto } from './repo-member-photo.ts';
import { currentPassJson, getPass } from './repo-read-pass.ts';
import { makeTenantTestApiKey } from './repo-tenant-test-fixtures.ts';
import { reserveWorkflowReleases } from './repo-workflow-releases.ts';
import { casMeta } from './repo-write-publish.ts';
import { getPublishRemovalSnapshot } from './repo-write-publish-snapshot.ts';
import { lookupValueOf, primaryBarcodeMessage } from './scan-code.ts';

const ORIGIN = 'https://wallet.test';
let kit: Kit;
let otherOrg: { id: string };
let releases: Record<Mode, TemplateRelease>;
let otherOrgRelease: TemplateRelease;
let app: OpenAPIHono<AppBindings>;

beforeAll(async () => {
  kit = await setupKit();
  otherOrg = await makeOrg(kit.fx, { name: 'Other tenant' });
  const live = await activeRelease(kit.ctx, kit.template.id, kit.org.id, 'live', 'apple');
  const test = await activeRelease(kit.ctx, kit.template.id, kit.org.id, 'test', 'apple');
  if (!live || !test) throw new Error('Default approved releases are missing');
  releases = { live, test };
  otherOrgRelease = await approveAppleRelease(kit, { orgId: otherOrg.id, mode: 'live' });
  // Both stores authenticate the presented secret against real credential rows in D1.
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
}, 60_000);

async function membership(orgId: string, user: UserRow, roles: OrgRole[]) {
  const invitationId = kit.fx.ids.id();
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      JSON.stringify(roles),
      kit.fx.ids.token(),
      now,
      now + 60_000,
      now,
    ],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, orgId, user.id, invitationId, JSON.stringify(roles), now],
  );
  return id;
}

async function expiringSession(userId: string, roles: ('admin' | 'user')[], expiresAt: number) {
  const cookieValue = kit.fx.ids.token();
  const csrf = kit.fx.ids.token();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
     VALUES (?, ?, 'oidc', ?, ?, ?, ?, ?, ?)`,
    [
      await hashSessionCookie(cookieValue),
      userId,
      JSON.stringify(roles),
      csrf,
      now,
      now,
      now + 3600_000,
      expiresAt,
    ],
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

async function member(
  orgId = kit.org.id,
  roles: OrgRole[] = ['pass_operator'],
  expiresAt?: number,
) {
  const user = await makeUser(kit.fx);
  const membershipId = await membership(orgId, user, roles);
  const session =
    expiresAt === undefined
      ? await makeSession(kit.fx, { userId: user.id, roles: ['user'] })
      : await expiringSession(user.id, ['user'], expiresAt);
  const sessionId = await hashSessionCookie(session.cookieValue);
  return { user, membershipId, session, sessionId };
}

const unique = () => kit.fx.ids.token(12);
const createBody = (mode: Mode = 'live', externalId = unique()) => {
  const release = releases[mode];
  return {
    orgId: kit.org.id,
    templateId: release.templateId,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    mode,
    input: { memberName: 'Tenant authority' },
    externalId,
  };
};

async function issue(headers: Record<string, string>, body: object, key: string) {
  return app.request(
    `${ORIGIN}/api/v1/passes`,
    {
      method: 'POST',
      headers: {
        ...headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    },
    kit.env,
  );
}

async function patch(headers: Record<string, string>, id: string, body: object) {
  return app.request(
    `${ORIGIN}/api/v1/passes/${id}`,
    {
      method: 'PATCH',
      headers: {
        ...headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'if-match': '"1"',
      },
      body: JSON.stringify(body),
    },
    kit.env,
  );
}

async function bulk(path: 'bulk' | 'bulk-reissue', headers: Record<string, string>, body: object) {
  return app.request(
    `${ORIGIN}/api/v1/passes/${path}`,
    {
      method: 'POST',
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
}

type CommitKind =
  | 'insert'
  | 'cas'
  | 'workflow'
  | 'claim'
  | 'release'
  | 'pass-read'
  | 'issued'
  | 'photo';

/** Interleave a real D1 change after preflight, immediately before the selected operation. */
async function atCommit<T>(
  kind: CommitKind,
  change: (db: D1Database) => Promise<void>,
  call: () => Promise<T>,
) {
  const db = kit.env.DB;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; native: D1PreparedStatement }
  >();
  let intercepted = 0;
  const matches = (sql: string) => {
    if (kind === 'insert') return /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+passes\b/i.test(sql);
    if (kind === 'workflow')
      return /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+workflow_runs\b/i.test(sql);
    if (kind === 'claim')
      return /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+idempotency_keys\b/i.test(sql);
    if (kind === 'release') return /^\s*DELETE\s+FROM\s+idempotency_keys\b/i.test(sql);
    if (kind === 'pass-read')
      return (
        /\bFROM\s+passes\s+WHERE\s+id\s*=\s*\?/i.test(sql) &&
        /deleted_at\s+IS\s+NULL\s+AND\s+test_data_quarantined\s*=\s*0/i.test(sql)
      );
    // The issuance event now commits with the pass: the mail's outbox insert is the first step after it.
    if (kind === 'issued') return /^\s*INSERT\s+INTO\s+outbox\b/i.test(sql);
    if (kind === 'photo')
      return /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+member_photos\b/i.test(sql);
    return /^\s*UPDATE\s+passes\s+SET\b/i.test(sql) && /RETURNING\s+version/i.test(sql);
  };
  const intervene = async (sql: string) => {
    if (intercepted === 0 && matches(sql)) {
      intercepted++;
      await change(db);
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === 'first')
          return async (column?: string) => {
            await intervene(sql);
            return column === undefined ? target.first() : target.first(column);
          };
        if (prop === 'run')
          return async () => {
            await intervene(sql);
            return target.run();
          };
        if (prop === 'all')
          return async () => {
            await intervene(sql);
            return target.all();
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { sql, native: statement });
    return wrapped;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          for (const statement of batch) await intervene(statements.get(statement)?.sql ?? '');
          return target.batch(
            batch.map((statement) => statements.get(statement)?.native ?? statement),
          );
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    const result = await call();
    expect(intercepted, `the ${kind} operation was reached`).toBe(1);
    return result;
  } finally {
    Object.assign(kit.env, { DB: db });
  }
}

/** Model time passing during an actual artifact upload, before the final D1 write. */
async function advanceOnUpload<T>(
  ms: number,
  call: () => Promise<T>,
  onUpload?: (key: string) => Promise<void>,
) {
  const bucket = kit.env.BUCKET;
  let uploads = 0;
  const proxy = new Proxy(bucket, {
    get(target, prop) {
      if (prop === 'put')
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.put, target, args);
          if (typeof args[0] === 'string' && args[0].startsWith('passes/')) {
            uploads++;
            await onUpload?.(args[0]);
            kit.clock.advance(ms);
          }
          return result;
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { BUCKET: proxy });
  try {
    const result = await call();
    expect(uploads).toBe(1);
    return result;
  } finally {
    Object.assign(kit.env, { BUCKET: bucket });
  }
}

/** Model an admin session expiring while a requested template version is resolved. */
async function advanceOnResolve<T>(ms: number, call: () => Promise<T>) {
  const resolve = kit.registry.resolve;
  let resolved = 0;
  kit.registry.resolve = async (id, version) => {
    const template = await resolve.call(kit.registry, id, version);
    resolved++;
    kit.clock.advance(ms);
    return template;
  };
  try {
    const result = await call();
    expect(resolved).toBe(1);
    return result;
  } finally {
    kit.registry.resolve = resolve;
  }
}

interface Reservation {
  request_hash: string;
  resource_id: string;
}

async function reservation(db: D1Database, key: string) {
  return first<Reservation>(
    db,
    'SELECT request_hash, resource_id FROM idempotency_keys WHERE org_id = ? AND key = ?',
    [kit.org.id, key],
  );
}

async function expectFailedIssue(response: Response, key: string, passId: string) {
  expect([403, 409, 412]).toContain(response.status);
  expect(await reservation(kit.env.DB, key)).toBeNull();
  expect(await getPass(kit.env.DB, passId)).toBeNull();
  expect(await all(kit.env.DB, 'SELECT * FROM pass_versions WHERE pass_id = ?', [passId])).toEqual(
    [],
  );
  expect(await all(kit.env.DB, 'SELECT * FROM pass_events WHERE pass_id = ?', [passId])).toEqual(
    [],
  );
  expect(await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ?', [passId])).toEqual([]);
  expect((await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects).toHaveLength(0);
}

async function effects(passId: string) {
  return {
    pass: await getPass(kit.env.DB, passId),
    versions: await all(
      kit.env.DB,
      'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
      [passId],
    ),
    events: await all(kit.env.DB, 'SELECT * FROM pass_events WHERE pass_id = ? ORDER BY id', [
      passId,
    ]),
    outbox: await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [passId]),
    audit: await all(
      kit.env.DB,
      'SELECT * FROM audit_log WHERE target_type = ? AND target_id = ? ORDER BY id',
      ['pass', passId],
    ),
    objects: (await kit.env.BUCKET.list({ prefix: `passes/${passId}/` })).objects
      .map((o) => o.key)
      .sort(),
  };
}

describe('tenant pass authorization', () => {
  it('authorizes before claiming or replaying an idempotency key and before a direct write', async () => {
    const operator = await member();
    const readOnly = await member(kit.org.id, ['read_only']);
    const otherTenant = await member(otherOrg.id);
    const nonmember = await makeUser(kit.fx);
    const nonmemberSession = await makeSession(kit.fx, { userId: nonmember.id });
    const platformAdmin = await makeUser(kit.fx);
    const platformSession = await makeSession(kit.fx, {
      userId: platformAdmin.id,
      roles: ['admin', 'user'],
    });
    const wrongKey = await makeApiKey(kit.fx, { orgId: otherOrg.id, scopes: ['passes:write'] });
    const readKey = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
    const denied = [
      readOnly.session.headers,
      otherTenant.session.headers,
      nonmemberSession.headers,
      platformSession.headers,
      wrongKey.headers,
      readKey.headers,
    ];
    const key = unique();
    const body = createBody();

    for (const headers of denied) {
      expect((await issue(headers, body, key)).status).toBe(403);
      expect(await reservation(kit.env.DB, key)).toBeNull();
    }
    const created = await issue(operator.session.headers, body, key);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const original = await effects(id);
    for (const headers of denied) {
      expect((await issue(headers, body, key)).status).toBe(403);
      expect([403, 404]).toContain((await patch(headers, id, { externalId: unique() })).status);
    }
    expect(await effects(id)).toEqual(original);
    const replay = await issue(operator.session.headers, body, key);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ id });
    expect(
      (await patch(operator.session.headers, id, { input: { memberName: 'Operator edit' } }))
        .status,
    ).toBe(200);
    expect(await getPass(kit.env.DB, id)).toMatchObject({ version: 2 });
  }, 60_000);

  it('requires the reviewed mode and approved release for real tenant credentials', async () => {
    const operator = await member();
    const key = unique();
    const body = createBody();
    for (const missing of [
      { mode: undefined },
      { templateVersion: undefined },
      { releaseId: undefined },
      { releaseGeneration: undefined },
    ]) {
      expect((await issue(operator.session.headers, { ...body, ...missing }, key)).status).toBe(
        422,
      );
    }
    expect(
      (await issue({ ...operator.session.headers, 'x-passbook-mode': 'test' }, body, key)).status,
    ).toBe(409);
    for (const mismatch of [
      { templateVersion: 'new-revision' },
      { releaseGeneration: releases.live.generation + 1 },
      { releaseId: otherOrgRelease.id, releaseGeneration: otherOrgRelease.generation },
    ]) {
      const response = await issue(operator.session.headers, { ...body, ...mismatch }, key);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
      expect(await reservation(kit.env.DB, key)).toBeNull();
    }
    const wrongModeRelease = await issue(
      { ...operator.session.headers, 'x-passbook-mode': 'test' },
      { ...body, mode: 'test' },
      key,
    );
    expect(wrongModeRelease.status).toBe(409);
    expect(await wrongModeRelease.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await reservation(kit.env.DB, key)).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT id FROM passes WHERE org_id = ? AND external_id = ?', [
        kit.org.id,
        body.externalId,
      ]),
    ).toBeNull();

    // The approved release, not templates.active_version, controls issuance.
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      'new-revision',
      kit.template.id,
    ]);
    try {
      const live = await issue(operator.session.headers, body, unique());
      expect(live.status).toBe(201);
      const detail = (await live.json()) as { id: string; mode: string; templateVersion: string };
      expect(detail).toMatchObject({ mode: 'live', templateVersion: releases.live.version });
      expect(await getPass(kit.env.DB, detail.id)).toMatchObject({ releaseId: releases.live.id });
    } finally {
      await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        kit.template.version,
        kit.template.id,
      ]);
    }
    const testResult = await issue(
      { ...operator.session.headers, 'x-passbook-mode': 'test' },
      createBody('test', body.externalId),
      key,
    );
    expect(testResult.status).toBe(201);
    const testDetail = (await testResult.json()) as {
      id: string;
      mode: string;
      templateVersion: string;
    };
    expect(testDetail).toMatchObject({ mode: 'test', templateVersion: releases.test.version });
    expect(await getPass(kit.env.DB, testDetail.id)).toMatchObject({ releaseId: releases.test.id });

    const apiKey = await makeTenantTestApiKey(kit.fx, {
      orgId: kit.org.id,
      scopes: ['passes:write'],
      mode: 'test',
    });
    const keyRequest = unique();
    const keyBody = createBody();
    expect((await issue(apiKey.headers, keyBody, keyRequest)).status).toBe(409);
    expect(await reservation(kit.env.DB, keyRequest)).toBeNull();
    const fromTestKey = await issue(
      { ...apiKey.headers, 'x-passbook-mode': 'live' },
      createBody('test', keyBody.externalId),
      keyRequest,
    );
    expect(fromTestKey.status).toBe(201);
    const keyDetail = (await fromTestKey.json()) as {
      id: string;
      mode: string;
      templateVersion: string;
    };
    expect(keyDetail).toMatchObject({ mode: 'test', templateVersion: releases.test.version });
    expect(await getPass(kit.env.DB, keyDetail.id)).toMatchObject({ releaseId: releases.test.id });
  }, 60_000);

  it('requires explicit org scope for sessions and API keys without widening tenant access', async () => {
    const operator = await member();
    const reader = await member(kit.org.id, ['read_only']);
    const foreignOperator = await member(otherOrg.id);
    const nonmember = await makeUser(kit.fx);
    const nonmemberSession = await makeSession(kit.fx, { userId: nonmember.id });
    const foreignKey = await makeApiKey(kit.fx, { orgId: otherOrg.id, scopes: ['passes:read'] });
    const ownKey = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:read'] });
    const globalKey = await makeApiKey(kit.fx, { orgId: null, scopes: ['passes:read'] });
    const platformAdmin = await makeUser(kit.fx);
    const platformSession = await makeSession(kit.fx, {
      userId: platformAdmin.id,
      roles: ['admin', 'user'],
    });
    const own = await kit.pass();
    const foreign = await kit.pass({ orgId: otherOrg.id });
    expect(own).toMatchObject({ orgId: kit.org.id, releaseId: releases.live.id });
    expect(foreign).toMatchObject({ orgId: otherOrg.id, releaseId: otherOrgRelease.id });
    const list = (headers: Record<string, string>, query: string) =>
      app.request(`${ORIGIN}/api/v1/passes${query}`, { headers }, kit.env);

    for (const headers of [operator.session.headers, globalKey.headers, platformSession.headers]) {
      const missingOrg = await list(headers, '');
      expect(missingOrg.status).toBe(422);
    }
    // An org-bound key defaults to its own org (docs/api.md, passes/routes.ts) and sees nothing else.
    const defaulted = await list(ownKey.headers, '');
    expect(defaulted.status).toBe(200);
    const defaultedPage = (await defaulted.json()) as { items: { orgId: string }[] };
    expect(defaultedPage.items.every((item) => item.orgId === kit.org.id)).toBe(true);
    expect((await list(ownKey.headers, '?orgId=null')).status).toBe(403);
    expect((await list(platformSession.headers, '?orgId=null')).status).toBe(403);
    const global = await list(globalKey.headers, '?orgId=null&limit=200');
    expect(global.status).toBe(200);
    const globalPage = (await global.json()) as { items: { id: string; orgId: string }[] };
    expect(globalPage.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: own.id, orgId: kit.org.id }),
        expect.objectContaining({ id: foreign.id, orgId: otherOrg.id }),
      ]),
    );
    for (const headers of [operator.session.headers, reader.session.headers]) {
      const response = await list(headers, `?orgId=${kit.org.id}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { items: { id: string; orgId: string }[] };
      expect(page.items).toContainEqual(expect.objectContaining({ id: own.id, orgId: kit.org.id }));
      expect(page.items.every((item) => item.orgId === kit.org.id)).toBe(true);
      expect(page.items.some((item) => item.id === foreign.id)).toBe(false);
    }
    // A session with no membership in the org is refused like a foreign key is, rather than shown an empty list.
    for (const headers of [foreignOperator.session.headers, nonmemberSession.headers]) {
      const response = await list(headers, `?orgId=${kit.org.id}`);
      expect(response.status).toBe(403);
    }
    expect((await list(foreignKey.headers, `?orgId=${kit.org.id}`)).status).toBe(403);
    expect((await list(ownKey.headers, `?orgId=${kit.org.id}`)).status).toBe(200);
  }, 60_000);

  it('maps every capability to exactly its granting roles and returns independent arrays', () => {
    const expected: Record<OrgCapability, OrgRole[]> = {
      'org:read': [
        'org_admin',
        'integration_admin',
        'template_author',
        'template_reviewer',
        'template_publisher',
        'pass_operator',
        'read_only',
      ],
      'org:manage': ['org_admin'],
      'members:read': ['org_admin'],
      'members:manage': ['org_admin'],
      'integrations:read': ['org_admin', 'integration_admin', 'read_only'],
      'integrations:manage': ['org_admin', 'integration_admin'],
      'templates:read': [
        'org_admin',
        'integration_admin',
        'template_author',
        'template_reviewer',
        'template_publisher',
        'pass_operator',
        'read_only',
      ],
      'templates:author': ['org_admin', 'template_author'],
      'templates:review': ['org_admin', 'template_reviewer'],
      'templates:publish': ['org_admin', 'template_publisher'],
      'passes:read': ['org_admin', 'pass_operator', 'read_only'],
      'passes:operate': ['org_admin', 'pass_operator'],
      'messages:read': ['org_admin', 'pass_operator', 'read_only'],
      'messages:manage': ['org_admin', 'pass_operator'],
      'scanning:read': ['org_admin', 'pass_operator', 'read_only'],
      'scanning:manage': ['org_admin'],
      'audit:read': ['org_admin', 'pass_operator', 'read_only'],
    };
    expect(Object.keys(expected).sort()).toEqual([...OrgCapabilitySchema.options].sort());
    for (const capability of OrgCapabilitySchema.options) {
      const roles = rolesGranting(capability);
      expect([...roles].sort()).toEqual([...expected[capability]].sort());
      roles.length = 0;
      expect([...rolesGranting(capability)].sort()).toEqual([...expected[capability]].sort());
    }
  });

  it('binds the canonical predicate to the target org and current capability', async () => {
    const operator = await member();
    const reader = await member(kit.org.id, ['read_only']);
    const own = await kit.pass();
    const foreign = await kit.pass({ orgId: otherOrg.id });
    const sessionAuth = await createSessionStore(kit.env, kit.clock).resolve(
      operator.session.cookieValue,
    );
    const readerAuth = await createSessionStore(kit.env, kit.clock).resolve(
      reader.session.cookieValue,
    );
    const key = await makeApiKey(kit.fx, { scopes: ['passes:write'] });
    const keyAuth = await createApiKeyStore(kit.env, kit.clock).resolve(key.secret);
    if (!sessionAuth || !readerAuth || !keyAuth) throw new Error('real credential did not resolve');
    const sessionAuthority = await tenantAuthorityOf(
      kit.ctx,
      sessionAuth,
      kit.org.id,
      'passes:operate',
    );
    const readAuthority = await tenantAuthorityOf(kit.ctx, readerAuth, kit.org.id, 'passes:read');
    const authorized = (authority: TenantPassWrite, passId: string) =>
      first(
        kit.env.DB,
        `SELECT 1 AS ok FROM passes p WHERE p.id = ? AND ${tenantPassAuthoritySql(authority, 'p')}`,
        [passId, ...tenantPassAuthorityParams(authority, kit.clock.now())],
      );
    expect(await authorized(sessionAuthority, own.id)).toEqual({ ok: 1 });
    expect(await authorized(sessionAuthority, foreign.id)).toBeNull();
    // Resolving a key alone is not a substitute for the route's required scope guard.
    await expect(
      tenantAuthorityOf(kit.ctx, keyAuth, kit.org.id, 'passes:operate'),
    ).rejects.toMatchObject({ status: 403 });
    expect(readAuthority.kind).toBe('session');
    if (readAuthority.kind !== 'session') throw new Error('expected session authority');
    expect(await authorized(readAuthority, own.id)).toEqual({ ok: 1 });
    // Even an otherwise valid snapshot cannot turn a read-only membership into a write grant.
    expect(await authorized({ ...readAuthority, capability: 'passes:operate' }, own.id)).toBeNull();
    await expect(
      tenantAuthorityOf(kit.ctx, readerAuth, kit.org.id, 'passes:operate'),
    ).rejects.toMatchObject({ status: 403 });
  }, 60_000);
});

describe('issuance commit authority', () => {
  it.each([
    'session revoked',
    'session replaced',
    'session user changed',
    'session roles changed',
    'session amr changed',
    'session expiry immutable',
    'session idle expired',
    'user disabled',
    'organization revised',
    'org settings saved',
    'org branding saved',
    'organization suspended and reactivated',
    'membership revoked',
    'membership replaced with operator',
    'membership replaced with read-only',
  ] as const)(
    'enforces %s after session authorization',
    async (change) => {
      const actor = await member();
      // Another live session for the same user must not substitute for the captured session id.
      await makeSession(kit.fx, { userId: actor.user.id });
      const replacementUser = await makeUser(kit.fx);
      await membership(kit.org.id, replacementUser, ['pass_operator']);
      const key = unique();
      const body = createBody();
      let passId = '';
      const response = await atCommit(
        'insert',
        async (db) => {
          const claimed = await reservation(db, key);
          expect(claimed?.resource_id).toBeTruthy();
          if (!claimed) throw new Error('idempotency claim was not created');
          passId = claimed.resource_id;
          const now = kit.clock.now();
          if (change === 'session revoked')
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              now,
              actor.sessionId,
            ]);
          else if (change === 'session replaced')
            await run(db, 'DELETE FROM sessions WHERE id_hash = ?', [actor.sessionId]);
          else if (change === 'session user changed')
            await expect(
              run(db, 'UPDATE sessions SET user_id = ? WHERE id_hash = ?', [
                replacementUser.id,
                actor.sessionId,
              ]),
            ).rejects.toThrow('session authority is immutable');
          else if (change === 'session roles changed')
            await expect(
              run(db, 'UPDATE sessions SET roles = ? WHERE id_hash = ?', [
                '["user","admin"]',
                actor.sessionId,
              ]),
            ).rejects.toThrow('session authority is immutable');
          else if (change === 'session amr changed')
            await expect(
              run(db, "UPDATE sessions SET amr = 'magic_link' WHERE id_hash = ?", [
                actor.sessionId,
              ]),
            ).rejects.toThrow('session authority is immutable');
          else if (change === 'session expiry immutable')
            await expect(
              run(db, 'UPDATE sessions SET expires_at = ? WHERE id_hash = ?', [
                now,
                actor.sessionId,
              ]),
            ).rejects.toThrow('session authority is immutable');
          else if (change === 'session idle expired')
            await run(db, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
              now,
              actor.sessionId,
            ]);
          else if (change === 'user disabled')
            await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [actor.user.id]);
          else if (change === 'organization revised')
            await run(db, 'UPDATE orgs SET updated_at = updated_at + 1 WHERE id = ?', [kit.org.id]);
          else if (change === 'org settings saved')
            await updateSettings(
              kit.ctx,
              { type: 'system', id: null },
              {
                scope: `org:${kit.org.id}`,
                values: { 'support.email': `${unique()}@example.test` },
              },
            );
          else if (change === 'org branding saved')
            await run(
              db,
              'UPDATE orgs SET branding = ?, updated_at = updated_at + 1 WHERE id = ?',
              [JSON.stringify({ accent: unique() }), kit.org.id],
            );
          else if (change === 'organization suspended and reactivated') {
            await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
            await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
          } else {
            await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              now,
              actor.membershipId,
            ]);
            if (change === 'membership replaced with operator')
              await membership(kit.org.id, actor.user, ['pass_operator']);
            if (change === 'membership replaced with read-only')
              await membership(kit.org.id, actor.user, ['read_only']);
          }
        },
        () => issue(actor.session.headers, body, key),
      );
      // Immutable inputs cannot change, and updated_at is a timestamp rather than an epoch: the issue lands.
      if (
        [
          'session user changed',
          'session expiry immutable',
          'session roles changed',
          'session amr changed',
          'organization revised',
          'org settings saved',
          'org branding saved',
        ].includes(change)
      ) {
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ id: passId });
        const replay = await issue(actor.session.headers, body, key);
        expect(replay.status).toBe(201);
        expect(await replay.json()).toMatchObject({ id: passId });
        return;
      }
      await expectFailedIssue(response, key, passId);
      // A fresh, authorized credential can reuse the released reservation for the same request.
      const retry = await member();
      const success = await issue(retry.session.headers, body, key);
      expect(success.status).toBe(201);
      const { id } = (await success.json()) as { id: string };
      const replay = await issue(retry.session.headers, body, key);
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({ id });
    },
    60_000,
  );

  it.each([
    'revoked',
    'key replaced',
    'expiry immutable',
    'scope removed',
    'scope added',
    'other org',
    'unbound org',
    'bound org',
    'mode changed',
    'organization revised',
    'org settings saved',
    'org branding saved',
    'organization suspended and reactivated',
  ] as const)(
    'enforces API key %s after authorization',
    async (change) => {
      const actor = await makeApiKey(kit.fx, {
        orgId: change === 'bound org' ? null : kit.org.id,
        scopes: ['passes:write'],
      });
      // The presence of another key with the same rights must not substitute for this key id.
      await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
      const key = unique();
      const body = createBody();
      let passId = '';
      const response = await atCommit(
        'insert',
        async (db) => {
          const claimed = await reservation(db, key);
          expect(claimed?.resource_id).toBeTruthy();
          if (!claimed) throw new Error('idempotency claim was not created');
          passId = claimed.resource_id;
          if (change === 'revoked')
            await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              actor.id,
            ]);
          else if (change === 'key replaced')
            await run(db, 'DELETE FROM api_keys WHERE id = ?', [actor.id]);
          else if (change === 'organization revised')
            await run(db, 'UPDATE orgs SET updated_at = updated_at + 1 WHERE id = ?', [kit.org.id]);
          else if (change === 'org settings saved')
            await updateSettings(
              kit.ctx,
              { type: 'system', id: null },
              {
                scope: `org:${kit.org.id}`,
                values: { 'support.email': `${unique()}@example.test` },
              },
            );
          else if (change === 'org branding saved')
            await run(
              db,
              'UPDATE orgs SET branding = ?, updated_at = updated_at + 1 WHERE id = ?',
              [JSON.stringify({ accent: unique() }), kit.org.id],
            );
          else if (change === 'organization suspended and reactivated') {
            await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [kit.org.id]);
            await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [kit.org.id]);
          } else {
            const mutations: Record<string, [string, string | number | null]> = {
              'expiry immutable': [
                'UPDATE api_keys SET expires_at = ? WHERE id = ?',
                kit.clock.now(),
              ],
              'scope removed': ['UPDATE api_keys SET scopes = ? WHERE id = ?', '["passes:read"]'],
              'scope added': [
                'UPDATE api_keys SET scopes = ? WHERE id = ?',
                '["passes:write","templates:read"]',
              ],
              'other org': ['UPDATE api_keys SET org_id = ? WHERE id = ?', otherOrg.id],
              'unbound org': ['UPDATE api_keys SET org_id = ? WHERE id = ?', null],
              'bound org': ['UPDATE api_keys SET org_id = ? WHERE id = ?', kit.org.id],
              'mode changed': ['UPDATE api_keys SET mode = ? WHERE id = ?', 'test'],
            };
            const mutation = mutations[change];
            if (!mutation) throw new Error(`Unexpected API key change: ${change}`);
            await expect(run(db, mutation[0], [mutation[1], actor.id])).rejects.toThrow(
              'api key identity is immutable',
            );
          }
        },
        () => issue(actor.headers, body, key),
      );
      if (
        change !== 'revoked' &&
        change !== 'key replaced' &&
        change !== 'organization suspended and reactivated'
      ) {
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ id: passId });
        const replay = await issue(actor.headers, body, key);
        expect(replay.status).toBe(201);
        expect(await replay.json()).toMatchObject({ id: passId });
        return;
      }
      await expectFailedIssue(response, key, passId);
      const retry = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
      const success = await issue(retry.headers, body, key);
      expect(success.status).toBe(201);
      const { id } = (await success.json()) as { id: string };
      const replay = await issue(retry.headers, body, key);
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({ id });
    },
    60_000,
  );

  it.each(['session', 'api key'] as const)(
    'does not claim an idempotency key if a %s is revoked at claim time',
    async (kind) => {
      const actor = kind === 'session' ? await member() : null;
      const apiKey =
        kind === 'api key'
          ? await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] })
          : null;
      const headers = actor?.session.headers ?? apiKey?.headers;
      if (!headers) throw new Error('credential missing');
      const key = unique();
      const body = createBody();
      const response = await atCommit(
        'claim',
        async (db) => {
          expect(await reservation(db, key)).toBeNull();
          if (actor)
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              kit.clock.now(),
              actor.sessionId,
            ]);
          else if (apiKey)
            await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              apiKey.id,
            ]);
        },
        () => issue(headers, body, key),
      );
      expect(response.status).toBe(403);
      expect(await reservation(kit.env.DB, key)).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT id FROM passes WHERE org_id = ? AND external_id = ?', [
          kit.org.id,
          body.externalId,
        ]),
      ).toBeNull();
      const replacement = await member();
      expect((await issue(replacement.session.headers, body, key)).status).toBe(201);
    },
    60_000,
  );

  it.each(['session', 'api key'] as const)(
    'uses the current clock when a %s expires during artifact upload',
    async (kind) => {
      const expiresAt = kit.clock.now() + 1;
      const session =
        kind === 'session' ? await member(kit.org.id, ['pass_operator'], expiresAt) : null;
      const apiKey =
        kind === 'api key'
          ? await makeTenantTestApiKey(kit.fx, {
              orgId: kit.org.id,
              scopes: ['passes:write'],
              expiresAt,
            })
          : null;
      const headers = session?.session.headers ?? apiKey?.headers;
      if (!headers) throw new Error('credential missing');
      const key = unique();
      const body = createBody();
      let passId = '';
      const response = await advanceOnUpload(
        2,
        () => issue(headers, body, key),
        async () => {
          const claimed = await reservation(kit.env.DB, key);
          if (!claimed) throw new Error('idempotency claim was not created');
          passId = claimed.resource_id;
        },
      );
      await expectFailedIssue(response, key, passId);
    },
    60_000,
  );

  it.each(['resource id', 'request hash'] as const)(
    'does not release another reservation with a changed %s',
    async (change) => {
      const actor = await member();
      const key = unique();
      const body = createBody();
      let originalId = '';
      let replacement: Reservation | null = null;
      const response = await atCommit(
        'insert',
        async (db) => {
          const claimed = await reservation(db, key);
          if (!claimed) throw new Error('idempotency claim was not created');
          originalId = claimed.resource_id;
          replacement =
            change === 'resource id'
              ? { ...claimed, resource_id: unique() }
              : { ...claimed, request_hash: unique() };
          await run(
            db,
            'UPDATE idempotency_keys SET request_hash = ?, resource_id = ? WHERE org_id = ? AND key = ?',
            [replacement.request_hash, replacement.resource_id, kit.org.id, key],
          );
          await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
            kit.clock.now(),
            actor.sessionId,
          ]);
        },
        () => issue(actor.session.headers, body, key),
      );
      expect([403, 409, 412]).toContain(response.status);
      expect(await getPass(kit.env.DB, originalId)).toBeNull();
      expect(replacement).not.toBeNull();
      expect(await reservation(kit.env.DB, key)).toEqual(replacement);
    },
    60_000,
  );

  it('keeps its reservation when a pass appears immediately before release', async () => {
    const actor = await member();
    const key = unique();
    const body = createBody();
    let passId = '';
    const response = await atCommit(
      'release',
      async () => {
        expect(passId).toBeTruthy();
        await createPassRow(jobCtxOf(kit), {
          ...body,
          passId,
          source: 'manual',
          execution: { kind: 'system' },
          actor: { type: 'system', id: null },
        });
      },
      () =>
        atCommit(
          'insert',
          async (db) => {
            const claimed = await reservation(db, key);
            if (!claimed) throw new Error('idempotency claim was not created');
            passId = claimed.resource_id;
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              kit.clock.now(),
              actor.sessionId,
            ]);
          },
          () => issue(actor.session.headers, body, key),
        ),
    );
    expect([403, 409, 412]).toContain(response.status);
    expect(await getPass(kit.env.DB, passId)).not.toBeNull();
    expect(await reservation(kit.env.DB, key)).toMatchObject({ resource_id: passId });
    const replacement = await member();
    const replay = await issue(replacement.session.headers, body, key);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ id: passId });
  }, 60_000);

  it('records a committed issuance and still queues its email after the initiator signs out (owner answer 2)', async () => {
    const actor = await member();
    const key = unique();
    const body = { ...createBody(), holderEmail: `${unique()}@example.com`, sendEmail: true };
    let passId = '';
    const response = await atCommit(
      'issued',
      async (db) => {
        const claimed = await reservation(db, key);
        if (!claimed) throw new Error('idempotency claim was not created');
        passId = claimed.resource_id;
        expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [passId])).toEqual({
          id: passId,
        });
        expect(
          await first(
            db,
            "SELECT id FROM audit_log WHERE action = 'pass.create' AND target_id = ?",
            [passId],
          ),
        ).not.toBeNull();
        await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          kit.clock.now(),
          actor.sessionId,
        ]);
      },
      () => issue(actor.session.headers, body, key),
    );
    // Sign-out is not revocation of authority: the committed issuance keeps its mail (owner answer 2), even though
    // the signed-out caller can no longer read the result.
    expect(response.status).toBe(403);
    expect(await reservation(kit.env.DB, key)).toMatchObject({ resource_id: passId });
    expect(
      await first(
        kit.env.DB,
        "SELECT actor_type, actor_id FROM audit_log WHERE action = 'pass.create' AND target_id = ?",
        [passId],
      ),
    ).toEqual({ actor_type: 'user', actor_id: actor.user.id });
    expect(
      await first(
        kit.env.DB,
        "SELECT actor_type, actor_id FROM pass_events WHERE kind = 'pass.issued' AND pass_id = ?",
        [passId],
      ),
    ).toEqual({ actor_type: 'user', actor_id: actor.user.id });
    expect(
      await all(kit.env.DB, "SELECT id FROM outbox WHERE kind = 'email' AND pass_id = ?", [passId]),
    ).toHaveLength(1);
    const replacement = await member();
    const replay = await issue(replacement.session.headers, body, key);
    expect(replay.status).toBe(201);
  }, 60_000);

  it.each(['deleted', 'quarantined'] as const)(
    'keeps the reservation when its committed pass is %s before the issuance re-read',
    async (state) => {
      const actor = await member();
      const key = unique();
      const body = createBody(state === 'quarantined' ? 'test' : 'live');
      const headers =
        state === 'quarantined'
          ? { ...actor.session.headers, 'x-passbook-mode': 'test' }
          : actor.session.headers;
      let passId = '';
      const response = await atCommit(
        'pass-read',
        async (db) => {
          const claimed = await reservation(db, key);
          if (!claimed) throw new Error('idempotency claim was not created');
          passId = claimed.resource_id;
          expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [passId])).toEqual({
            id: passId,
          });
          if (state === 'deleted')
            await run(db, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
              kit.clock.now(),
              passId,
            ]);
          else await run(db, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [passId]);
        },
        () => issue(headers, body, key),
      );
      expect(response.status).toBe(404);
      expect(await getPass(kit.env.DB, passId)).toBeNull();
      expect(await first(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [passId])).toEqual({
        id: passId,
      });
      expect(await reservation(kit.env.DB, key)).toMatchObject({ resource_id: passId });
      expect((await issue(headers, body, key)).status).toBe(409);
    },
    60_000,
  );

  it('rolls the pass back with its audit row and lets a replay create it', async () => {
    const actor = await member();
    const key = unique();
    const body = createBody();
    await run(
      kit.env.DB,
      `CREATE TRIGGER tenant_authority_audit_failure
      BEFORE INSERT ON audit_log WHEN NEW.action = 'pass.create' AND NEW.actor_id = '${actor.user.id}'
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`,
    );
    try {
      expect((await issue(actor.session.headers, body, key)).status).toBe(500);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER tenant_authority_audit_failure');
    }
    // The audit joins the pass's grant: a failed audit leaves no pass and no reservation behind.
    expect(await reservation(kit.env.DB, key)).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM passes WHERE external_id = ?', [body.externalId]),
    ).toBeNull();
    const replay = await issue(actor.session.headers, body, key);
    expect(replay.status).toBe(201);
  }, 60_000);
});

describe('direct pass compare-and-swap authority', () => {
  it.each([
    ['session', 'metadata'],
    ['session', 'publish'],
    ['api key', 'metadata'],
    ['api key', 'publish'],
  ] as const)(
    'fences a %s revoked before the %s CAS',
    async (kind, operation) => {
      const pass = await kit.pass();
      const actor = kind === 'session' ? await member() : null;
      const apiKey =
        kind === 'api key'
          ? await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] })
          : null;
      const headers = actor?.session.headers ?? apiKey?.headers;
      if (!headers) throw new Error('credential missing');
      const body =
        operation === 'metadata'
          ? { externalId: `changed-${unique()}` }
          : { input: { memberName: `Changed ${unique()}` } };
      const before = await effects(pass.id);
      const response = await atCommit(
        'cas',
        async (db) => {
          if (actor)
            await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              kit.clock.now(),
              actor.sessionId,
            ]);
          else if (apiKey)
            await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
              kit.clock.now(),
              apiKey.id,
            ]);
        },
        () => patch(headers, pass.id, body),
      );
      expect([403, 409, 412]).toContain(response.status);
      expect(await effects(pass.id)).toEqual(before);
      const retryHeaders = actor
        ? (await makeSession(kit.fx, { userId: actor.user.id })).headers
        : (await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] })).headers;
      expect((await patch(retryHeaders, pass.id, body)).status).toBe(200);
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({ version: 2 });
    },
    60_000,
  );

  // Roles and amr are immutable (0047); the edit is refused mid-request and the publish lands.
  it.each(['roles', 'amr'] as const)(
    'cannot change a valid session %s before a publish CAS',
    async (change) => {
      const actor = await member();
      const pass = await kit.pass();
      const response = await atCommit(
        'cas',
        async (db) => {
          await expect(
            change === 'roles'
              ? run(db, 'UPDATE sessions SET roles = ? WHERE id_hash = ?', [
                  '["user","admin"]',
                  actor.sessionId,
                ])
              : run(db, "UPDATE sessions SET amr = 'magic_link' WHERE id_hash = ?", [
                  actor.sessionId,
                ]),
          ).rejects.toThrow('session authority is immutable');
        },
        () => patch(actor.session.headers, pass.id, { input: { memberName: 'Changed session' } }),
      );
      expect(response.status).toBe(200);
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({ version: 2 });
    },
    60_000,
  );

  it('rejects non-pass key scopes at the pass repository even when a real route checked them', async () => {
    const pass = await kit.pass();
    const { contentHash, scanCode } = pass;
    const stored = await first<{ lookup_hash: string | null }>(
      kit.env.DB,
      'SELECT lookup_hash FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!contentHash || !scanCode || !stored) throw new Error('pass fixture is incomplete');
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const [passJson, removal] = await Promise.all([
      currentPassJson(kit.env.DB, pass.id),
      getPublishRemovalSnapshot(kit.env.DB, pass),
    ]);
    if (!passJson || !removal) throw new Error('pass snapshot is incomplete');
    const lookupInput = kit.template.manifest.scan?.lookup?.input;
    const refs = await credentialReferences(kit.env, pass.orgId, pass.mode, {
      scanCode,
      serial: pass.serial,
      barcodeHash: pass.barcodeHash,
      barcodeMessage: primaryBarcodeMessage(JSON.parse(passJson)),
      lookupHash: stored.lookup_hash,
      lookupValue: lookupInput ? lookupValueOf(pass.personalization, lookupInput) : null,
    });
    const expectedPass = {
      ...pass,
      removalMessage: removal.message,
      removalPriorStatus: removal.priorStatus,
      removalPublishedGeneration: removal.publishedGeneration,
      imageGeneration: removal.imageGeneration,
      credentialKeysetCommitment,
      credentialRefs: [...new Set(refs.map((ref) => ref.ref))],
    };
    const probe = createApp({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(kit.env, kit.clock),
        apiKeys: createApiKeyStore(kit.env, kit.clock),
      },
      clock: kit.clock,
    });
    const cases = [
      ['holder', 'holders:write', 'passes:operate'],
      ['reader', 'passes:read', 'passes:read'],
      ['writer', 'passes:write', 'passes:operate'],
    ] as const;
    for (const [label, scope, capability] of cases) {
      probe.post(`/__test-pass-cas/${label}`, requireTenantSessionOrApiKey(scope), async (c) => {
        const authority = await tenantAuthorityOf(svc(c), authOf(c), pass.orgId, capability);
        const version = await casMeta(svc(c), pass.id, pass.version, {
          personalization: pass.personalization,
          fieldSources: pass.fieldSources,
          externalId: `scope-${label}`,
          templateVersion: pass.templateVersion,
          contentHash,
          barcodeHash: pass.barcodeHash,
          lookupHash: stored.lookup_hash,
          scanCode,
          objectKey: pass.objectKey,
          expectedPass,
          authority,
          clock: kit.clock,
        });
        return c.json({ version });
      });
    }
    const before = await effects(pass.id);
    for (const [label, scope] of cases.slice(0, 2)) {
      const credential = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: [scope] });
      const response = await probe.request(
        `${ORIGIN}/__test-pass-cas/${label}`,
        { method: 'POST', headers: credential.headers },
        kit.env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: null });
      expect(await effects(pass.id)).toEqual(before);
    }
    const writer = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const response = await probe.request(
      `${ORIGIN}/__test-pass-cas/writer`,
      { method: 'POST', headers: writer.headers },
      kit.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 2 });
    expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
      version: 2,
      externalId: 'scope-writer',
    });
  }, 60_000);

  it.each(['session', 'api key'] as const)(
    'uses the current clock when a %s expires during a publish upload',
    async (kind) => {
      const pass = await kit.pass();
      const expiresAt = kit.clock.now() + 1;
      const actor =
        kind === 'session' ? await member(kit.org.id, ['pass_operator'], expiresAt) : null;
      const apiKey =
        kind === 'api key'
          ? await makeTenantTestApiKey(kit.fx, {
              orgId: kit.org.id,
              scopes: ['passes:write'],
              expiresAt,
            })
          : null;
      const headers = actor?.session.headers ?? apiKey?.headers;
      if (!headers) throw new Error('credential missing');
      const before = await effects(pass.id);
      const response = await advanceOnUpload(2, () =>
        atCommit(
          'cas',
          async (db) => {
            const row = actor
              ? await first(db, 'SELECT expires_at FROM sessions WHERE id_hash = ?', [
                  actor.sessionId,
                ])
              : await first(db, 'SELECT expires_at FROM api_keys WHERE id = ?', [apiKey?.id]);
            expect(row).toEqual({ expires_at: expiresAt });
            expect(kit.clock.now()).toBeGreaterThan(expiresAt);
          },
          () => patch(headers, pass.id, { input: { memberName: 'Expired during upload' } }),
        ),
      );
      expect([403, 409, 412]).toContain(response.status);
      expect(await effects(pass.id)).toEqual(before);
    },
    60_000,
  );
});

describe('bulk selection and reissue authority', () => {
  it('derives the tenant from the selection and refuses mixed, foreign and wrong-mode writes', async () => {
    const operator = await member();
    const reader = await member(kit.org.id, ['read_only']);
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const live = await kit.pass();
    const foreign = await kit.pass({ orgId: otherOrg.id });
    const test = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: releases.test.templateId,
      templateVersion: releases.test.version,
      releaseId: releases.test.id,
      releaseGeneration: releases.test.generation,
      input: { memberName: 'Bulk test mode' },
      mode: 'test',
      source: 'manual',
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    const action = (ids: string[]) => ({ action: 'void', ids });
    const foreignFirst = await bulk(
      'bulk',
      operator.session.headers,
      action([foreign.id, live.id]),
    );
    const foreignFirstMissing = await bulk(
      'bulk',
      operator.session.headers,
      action([foreign.id, unique()]),
    );
    expect(foreignFirst.status).toBe(403);
    expect(foreignFirstMissing.status).toBe(403);
    expect(await foreignFirst.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(await foreignFirstMissing.json()).toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await bulk('bulk', operator.session.headers, action([live.id, foreign.id]))).status,
    ).toBe(404);
    expect((await bulk('bulk', key.headers, action([live.id, foreign.id]))).status).toBe(404);
    expect((await bulk('bulk', key.headers, action([test.id, live.id]))).status).toBe(404);
    expect((await bulk('bulk', key.headers, action([live.id, test.id]))).status).toBe(404);
    expect((await bulk('bulk', reader.session.headers, action([live.id]))).status).toBe(403);
    expect(await getPass(kit.env.DB, live.id)).toMatchObject({ status: 'active', version: 1 });
    expect(await getPass(kit.env.DB, foreign.id)).toMatchObject({ status: 'active', version: 1 });
    expect(await getPass(kit.env.DB, test.id)).toMatchObject({ status: 'active', version: 1 });
    const inTestMode = await bulk(
      'bulk',
      { ...operator.session.headers, 'x-passbook-mode': 'test' },
      action([live.id, test.id]),
    );
    expect(inTestMode.status).toBe(200);
    expect(await inTestMode.json()).toEqual({
      done: 1,
      skipped: [{ id: live.id, code: 'MODE_MISMATCH' }],
    });
    expect(await getPass(kit.env.DB, live.id)).toMatchObject({ status: 'active', version: 1 });
    expect(await getPass(kit.env.DB, test.id)).toMatchObject({ status: 'voided', version: 2 });
    const allowed = await bulk('bulk', operator.session.headers, action([live.id]));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ done: 1, skipped: [] });
    expect(await getPass(kit.env.DB, live.id)).toMatchObject({ status: 'voided', version: 2 });
  }, 60_000);

  it('does not mutate any selected pass when membership is revoked before the first bulk CAS', async () => {
    const operator = await member();
    const passes = [await kit.pass(), await kit.pass()];
    const before = await Promise.all(passes.map((pass) => effects(pass.id)));
    const response = await atCommit(
      'cas',
      async (db) => {
        await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          operator.membershipId,
        ]);
      },
      () =>
        bulk('bulk', operator.session.headers, {
          action: 'void',
          ids: passes.map((pass) => pass.id),
        }),
    );
    expect([403, 409, 412]).toContain(response.status);
    expect(await Promise.all(passes.map((pass) => effects(pass.id)))).toEqual(before);
  }, 60_000);

  it('restricts scoped and unscoped reissues and carries the reviewed mode to workflows', async () => {
    const operator = await member();
    const reader = await member(kit.org.id, ['read_only']);
    const foreignOperator = await member(otherOrg.id);
    const adminUser = await makeUser(kit.fx);
    const admin = await makeSession(kit.fx, { userId: adminUser.id, roles: ['admin', 'user'] });
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['passes:write'] });
    const pass = await kit.pass();
    await kit.pass({ mode: 'test' });
    const scoped = { orgId: kit.org.id, templateId: kit.template.id };
    expect((await bulk('bulk-reissue', reader.session.headers, scoped)).status).toBe(403);
    expect((await bulk('bulk-reissue', foreignOperator.session.headers, scoped)).status).toBe(403);
    expect((await bulk('bulk-reissue', key.headers, scoped)).status).toBe(401);
    expect(
      (await bulk('bulk-reissue', operator.session.headers, { templateId: kit.template.id }))
        .status,
    ).toBe(403);
    expect(
      (
        await bulk('bulk-reissue', operator.session.headers, {
          cause: 'resign',
          identityId: pass.identityId,
        })
      ).status,
    ).toBe(403);
    const scopedResult = await bulk(
      'bulk-reissue',
      { ...operator.session.headers, 'x-passbook-mode': 'test' },
      scoped,
    );
    expect(scopedResult.status).toBe(202);
    const { workflowInstanceId } = (await scopedResult.json()) as { workflowInstanceId: string };
    expect(
      kit.workflow.created.find((workflow) => workflow.id === workflowInstanceId),
    ).toMatchObject({
      params: { orgId: kit.org.id, templateId: kit.template.id, mode: 'test' },
    });
    expect(
      await first(
        kit.env.DB,
        `SELECT org_id, mode, template_id, release_id, generation, version
         FROM workflow_release_snapshots WHERE instance_id = ?`,
        [workflowInstanceId],
      ),
    ).toEqual({
      org_id: kit.org.id,
      mode: 'test',
      template_id: kit.template.id,
      release_id: releases.test.id,
      generation: releases.test.generation,
      version: releases.test.version,
    });
    const global = await bulk('bulk-reissue', admin.headers, { templateId: kit.template.id });
    expect(global.status).toBe(202);
    const identity = await bulk('bulk-reissue', admin.headers, {
      cause: 'resign',
      identityId: pass.identityId,
    });
    expect(identity.status).toBe(202);
    await startBulkReissue(kit.ctx, { type: 'system', id: null }, scoped);
    const systemRun = kit.workflow.created.at(-1);
    expect(systemRun?.params).toMatchObject({ orgId: kit.org.id, templateId: kit.template.id });
    expect(systemRun?.params).not.toHaveProperty('mode');
  }, 60_000);

  it('rolls back partial workflow snapshots when an affected scope is unavailable', async () => {
    const other = await makeOrg(kit.fx, { name: 'Unavailable workflow tenant' });
    const ownPass = await kit.pass();
    const otherPass = await kit.pass({ orgId: other.id });
    const query = {
      instanceId: `bulk-${unique()}`,
      orgId: null,
      mode: 'live' as const,
      templateId: kit.template.id,
      targetId: kit.template.id,
      identityId: null,
      version: null,
      now: kit.clock.now(),
    };
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [other.id]);
    try {
      expect(await reserveWorkflowReleases(kit.env.DB, query)).toBe('release_changed');
      for (const table of [
        'workflow_runs',
        'workflow_release_snapshot_sets',
        'workflow_release_snapshots',
      ]) {
        expect(
          await first(kit.env.DB, `SELECT 1 AS present FROM ${table} WHERE instance_id = ?`, [
            query.instanceId,
          ]),
        ).toBeNull();
      }
    } finally {
      await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [other.id]);
    }
    expect(await reserveWorkflowReleases(kit.env.DB, query)).toBe('inserted');
    expect(
      await all(
        kit.env.DB,
        `SELECT org_id, release_id FROM workflow_release_snapshots
         WHERE instance_id = ? AND org_id IN (?, ?)`,
        [query.instanceId, kit.org.id, other.id],
      ),
    ).toEqual(
      expect.arrayContaining([
        { org_id: kit.org.id, release_id: ownPass.releaseId },
        { org_id: other.id, release_id: otherPass.releaseId },
      ]),
    );
  }, 60_000);

  it('rejects a stale reviewed release without leaving a workflow or snapshot marker', async () => {
    const query = {
      instanceId: `bulk-${unique()}`,
      orgId: kit.org.id,
      mode: 'live' as const,
      templateId: kit.template.id,
      targetId: kit.template.id,
      identityId: null,
      version: null,
      now: kit.clock.now(),
      expectedRelease: {
        id: releases.live.id,
        generation: releases.live.generation + 1,
        version: releases.live.version,
      },
    };
    expect(await reserveWorkflowReleases(kit.env.DB, query)).toBe('release_changed');
    expect(
      await first(kit.env.DB, 'SELECT 1 AS present FROM workflow_runs WHERE instance_id = ?', [
        query.instanceId,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 AS present FROM workflow_release_snapshot_sets WHERE instance_id = ?',
        [query.instanceId],
      ),
    ).toBeNull();
    expect(
      await reserveWorkflowReleases(kit.env.DB, {
        ...query,
        expectedRelease: {
          id: releases.live.id,
          generation: releases.live.generation,
          version: releases.live.version,
        },
      }),
    ).toBe('inserted');
  }, 60_000);

  it('does not enqueue a scoped reissue when membership is revoked at workflow insertion', async () => {
    const operator = await member();
    const before = await all(
      kit.env.DB,
      'SELECT instance_id FROM workflow_runs WHERE org_id = ? ORDER BY instance_id',
      [kit.org.id],
    );
    const workflows = kit.workflow.created.length;
    const response = await atCommit(
      'workflow',
      async (db) => {
        await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          kit.clock.now(),
          operator.membershipId,
        ]);
      },
      () =>
        bulk('bulk-reissue', operator.session.headers, {
          orgId: kit.org.id,
          templateId: kit.template.id,
        }),
    );
    expect(response.status).toBe(403);
    expect(kit.workflow.created).toHaveLength(workflows);
    expect(
      await all(
        kit.env.DB,
        'SELECT instance_id FROM workflow_runs WHERE org_id = ? ORDER BY instance_id',
        [kit.org.id],
      ),
    ).toEqual(before);
    const replacement = await member();
    expect(
      (
        await bulk('bulk-reissue', replacement.session.headers, {
          orgId: kit.org.id,
          templateId: kit.template.id,
        })
      ).status,
    ).toBe(202);
  }, 60_000);

  it('does not reserve an unscoped reissue if the admin session is revoked during template resolution', async () => {
    const user = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const sessionId = await hashSessionCookie(session.cookieValue);
    const before = await all(
      kit.env.DB,
      'SELECT instance_id FROM workflow_runs WHERE org_id IS NULL ORDER BY instance_id',
    );
    const workflows = kit.workflow.created.length;
    const resolve = kit.registry.resolve;
    let revoked = false;
    kit.registry.resolve = async (id, version) => {
      const template = await resolve.call(kit.registry, id, version);
      if (!revoked) {
        revoked = true;
        await run(kit.env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          kit.clock.now(),
          sessionId,
        ]);
      }
      return template;
    };
    try {
      const response = await bulk('bulk-reissue', session.headers, {
        templateId: kit.template.id,
        version: kit.template.version,
      });
      expect(response.status).toBe(403);
      expect(revoked).toBe(true);
    } finally {
      kit.registry.resolve = resolve;
    }
    expect(kit.workflow.created).toHaveLength(workflows);
    expect(
      await all(
        kit.env.DB,
        'SELECT instance_id FROM workflow_runs WHERE org_id IS NULL ORDER BY instance_id',
      ),
    ).toEqual(before);
  }, 60_000);

  it.each([
    'revoked',
    'session replaced',
    'user changed',
    'user disabled',
    'role removed',
    'expired',
    'idle expired',
  ] as const)(
    'enforces unscoped admin authority when %s changes at insertion',
    async (change) => {
      const user = await makeUser(kit.fx);
      const expiresAt = kit.clock.now() + 1;
      const session =
        change === 'expired'
          ? await expiringSession(user.id, ['admin', 'user'], expiresAt)
          : await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
      const sessionId = await hashSessionCookie(session.cookieValue);
      // Neither another session for this user nor an active replacement user authorizes this one.
      await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
      const replacement = await makeUser(kit.fx);
      const before = await all(
        kit.env.DB,
        'SELECT instance_id FROM workflow_runs WHERE org_id IS NULL ORDER BY instance_id',
      );
      const workflows = kit.workflow.created.length;
      const attempt = () =>
        atCommit(
          'workflow',
          async (db) => {
            if (change === 'revoked')
              await run(db, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                kit.clock.now(),
                sessionId,
              ]);
            else if (change === 'session replaced')
              await run(db, 'DELETE FROM sessions WHERE id_hash = ?', [sessionId]);
            else if (change === 'user changed')
              await expect(
                run(db, 'UPDATE sessions SET user_id = ? WHERE id_hash = ?', [
                  replacement.id,
                  sessionId,
                ]),
              ).rejects.toThrow('session authority is immutable');
            else if (change === 'user disabled')
              await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
            else if (change === 'role removed')
              await editSessionAuthority(db, 'UPDATE sessions SET roles = ? WHERE id_hash = ?', [
                '["user"]',
                sessionId,
              ]);
            else if (change === 'expired') expect(kit.clock.now()).toBeGreaterThan(expiresAt);
            else
              await run(db, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
                kit.clock.now(),
                sessionId,
              ]);
          },
          () =>
            bulk('bulk-reissue', session.headers, {
              templateId: kit.template.id,
              ...(change === 'expired' ? { version: kit.template.version } : {}),
            }),
        );
      const response = change === 'expired' ? await advanceOnResolve(2, attempt) : await attempt();
      if (change === 'user changed') {
        expect(response.status).toBe(202);
        const { workflowInstanceId } = (await response.json()) as { workflowInstanceId: string };
        expect(kit.workflow.created).toHaveLength(workflows + 1);
        expect(kit.workflow.created.at(-1)).toMatchObject({ id: workflowInstanceId });
        expect(
          await first(kit.env.DB, 'SELECT user_id FROM sessions WHERE id_hash = ?', [sessionId]),
        ).toEqual({ user_id: user.id });
        return;
      }
      expect(response.status).toBe(403);
      expect(kit.workflow.created).toHaveLength(workflows);
      expect(
        await all(
          kit.env.DB,
          'SELECT instance_id FROM workflow_runs WHERE org_id IS NULL ORDER BY instance_id',
        ),
      ).toEqual(before);
    },
    60_000,
  );
});

describe('member photo authority', () => {
  it.each(['put', 'patch', 'delete'] as const)(
    'does not %s a photo after its operator membership is revoked',
    async (operation) => {
      const operator = await member();
      const pass = await kit.pass();
      const png = btoa(String.fromCharCode(...makePng(270, 270)));
      if (operation !== 'put')
        await putMemberPhoto(
          jobCtxOf(kit),
          { type: 'system', id: null },
          pass.id,
          { png, includeInPass: false },
          null,
        );
      await kit.settle();
      const beforePhoto = await memberPhoto(kit.env.DB, pass.orgId, pass.id);
      const before = await effects(pass.id);
      const response = await atCommit(
        'photo',
        async (db) => {
          await run(db, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            kit.clock.now(),
            operator.membershipId,
          ]);
        },
        async () =>
          app.request(
            `${ORIGIN}/api/v1/passes/${pass.id}/member-photo`,
            {
              method: operation.toUpperCase(),
              headers: {
                ...operator.session.headers,
                origin: ORIGIN,
                'content-type': 'application/json',
              },
              ...(operation === 'delete'
                ? {}
                : {
                    body: JSON.stringify(
                      operation === 'put' ? { png, includeInPass: false } : { includeInPass: true },
                    ),
                  }),
            },
            kit.env,
          ),
      );
      expect([403, 409]).toContain(response.status);
      expect(await memberPhoto(kit.env.DB, pass.orgId, pass.id)).toEqual(beforePhoto);
      expect(await effects(pass.id)).toEqual(before);
    },
    60_000,
  );
});

describe('resend audit atomicity', () => {
  it('does not leave an outbox entry or email event if its audit insert fails', async () => {
    const operator = await member();
    const pass = await kit.pass({ holderEmail: 'atomic-resend@example.test' });
    await kit.settle();
    const before = await effects(pass.id);
    await run(
      kit.env.DB,
      `CREATE TRIGGER test_resend_audit_failure
      BEFORE INSERT ON audit_log WHEN NEW.action = 'pass.resend_email' AND NEW.target_id = '${pass.id}'
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`,
    );
    try {
      const response = await app.request(
        `${ORIGIN}/api/v1/passes/${pass.id}/resend-email`,
        {
          method: 'POST',
          headers: {
            ...operator.session.headers,
            origin: ORIGIN,
            'content-type': 'application/json',
          },
          body: '{}',
        },
        kit.env,
      );
      expect(response.status).toBe(500);
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER test_resend_audit_failure');
    }
    expect(await effects(pass.id)).toEqual(before);
  }, 60_000);
});

describe('tenant publish grant (authority-epochs.md F3)', () => {
  it.each(['void', 'transfer'] as const)(
    'refuses with a lineage conflict when the pass is %s between the read and the write',
    async (change) => {
      const operator = await member();
      const pass = await kit.pass();
      const put = kit.env.BUCKET.put.bind(kit.env.BUCKET);
      let raced = false;
      const spy = vi
        .spyOn(kit.env.BUCKET, 'put')
        .mockImplementation(async (key, value, options) => {
          const object = await put(key, value, options);
          if (!raced && key.startsWith(`passes/${pass.id}/`)) {
            raced = true;
            if (change === 'void')
              await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
            else
              await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
                id: kit.fx.ids.id(),
                token: kit.fx.ids.token(),
                now: kit.clock.now(),
              });
          }
          return object;
        });
      try {
        const response = await patch(operator.session.headers, pass.id, {
          input: { memberName: 'Racing edit' },
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'LINEAGE_CHANGED' });
      } finally {
        spy.mockRestore();
      }
      expect(raced).toBe(true);
      // Nothing was written: same version and content, and the losing artifact is gone.
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        version: pass.version,
        personalization: pass.personalization,
        objectKey: pass.objectKey,
      });
      expect(
        (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects.map((o) => o.key),
      ).toEqual([pass.objectKey]);
    },
    60_000,
  );

  it('answers 409 for a concurrent edit and 200 for a replay of an applied one', async () => {
    const operator = await member();
    const pass = await kit.pass();
    const ok = await patch(operator.session.headers, pass.id, {
      input: { memberName: 'Applied once' },
    });
    expect(ok.status).toBe(200);
    // The same PATCH again is already the current state: no new version, and no error.
    const again = await app.request(
      `${ORIGIN}/api/v1/passes/${pass.id}`,
      {
        method: 'PATCH',
        headers: {
          ...operator.session.headers,
          origin: ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input: { memberName: 'Applied once' } }),
      },
      kit.env,
    );
    expect(again.status).toBe(200);
    expect((await getPass(kit.env.DB, pass.id))?.version).toBe(pass.version + 1);
  }, 60_000);
});
