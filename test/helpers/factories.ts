import { InMemoryTemplateRegistry } from '../../src/passkit/template/in-memory-registry.ts';
import type { ResolvedTemplate } from '../../src/passkit/template/registry.ts';
import type { PassJson, TemplateManifest } from '../../src/passkit/types.ts';
import { ensurePlatformIdentity } from '../../src/worker/modules/identities/repo.ts';
import { PLATFORM_IDENTITY_ID } from '../../src/worker/modules/identities/resolver.ts';
import { ManualClock } from '../../src/worker/platform/clock.ts';
import { run } from '../../src/worker/platform/db.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';
import { createIds, type Ids, sha256Hex } from '../../src/worker/platform/ids.ts';

/** Clock and ids shared by factories. Ids are UUIDv7 so tests do not collide across a file. */
export interface Fixtures {
  env: AppEnv;
  clock: ManualClock;
  ids: Ids;
}

export function fixtures(env: AppEnv, clock = new ManualClock(), ids = createIds(clock)): Fixtures {
  return { env, clock, ids };
}

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
}

export async function makeOrg(f: Fixtures, overrides: Partial<OrgRow> = {}): Promise<OrgRow> {
  const id = overrides.id ?? f.ids.id();
  const row = {
    id,
    slug: overrides.slug ?? `org-${id.slice(-6)}`,
    name: overrides.name ?? 'Test Org',
  };
  const now = f.clock.now();
  await run(
    f.env.DB,
    'INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [row.id, row.slug, row.name, now, now],
  );
  return row;
}

export interface UserRow {
  id: string;
  primaryEmail: string;
}

export async function makeUser(
  f: Fixtures,
  overrides: Partial<UserRow> & { verified?: boolean } = {},
): Promise<UserRow> {
  const id = overrides.id ?? f.ids.id();
  const primaryEmail = overrides.primaryEmail ?? `${id}@example.com`;
  const now = f.clock.now();
  await run(f.env.DB, 'INSERT INTO users (id, primary_email, created_at) VALUES (?, ?, ?)', [
    id,
    primaryEmail,
    now,
  ]);
  if (overrides.verified !== false) {
    await run(
      f.env.DB,
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'admin', ?)",
      [primaryEmail, id, now],
    );
  }
  return { id, primaryEmail };
}

export interface TestTemplate {
  resolved: ResolvedTemplate;
  registry: InMemoryTemplateRegistry;
}

const ICON = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 255, 255, 63, 0, 5, 254, 2,
  254, 167, 53, 129, 132, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

/** In-memory generic template with a `memberName` input bound to a primary field. */
export function makeTemplate(
  overrides: { id?: string; orgId?: string | null; version?: string } = {},
): TestTemplate {
  const manifest: TemplateManifest = {
    schema: 1,
    name: 'Test template',
    inputs: {
      type: 'object',
      required: ['memberName'],
      properties: { memberName: { type: 'string', minLength: 1 } },
    },
    sample: { memberName: 'Alex Morgan' },
    bindings: [{ to: { field: 'name' }, value: '{{memberName}}' }],
    display: { title: '{{memberName}}' },
  };
  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: 'placeholder',
    teamIdentifier: 'placeholder',
    serialNumber: 'placeholder',
    organizationName: 'placeholder',
    description: 'Test pass',
    generic: { primaryFields: [{ key: 'name', label: 'Member', value: '' }] },
  } as PassJson;
  const registry = new InMemoryTemplateRegistry();
  const resolved = registry.add({
    id: overrides.id ?? 'tpl-test',
    orgId: overrides.orgId ?? null,
    version: overrides.version ?? 'v1',
    manifest,
    passJson,
    assets: { 'icon.png': ICON },
  });
  return { resolved, registry };
}

/** Writes the template and its version to D1 so passes can reference it. */
export async function persistTemplate(f: Fixtures, template: ResolvedTemplate): Promise<void> {
  const now = f.clock.now();
  await run(
    f.env.DB,
    `INSERT OR IGNORE INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      template.id,
      template.orgId,
      template.id,
      template.manifest.name,
      template.origin,
      template.version,
      now,
      now,
    ],
  );
  await run(
    f.env.DB,
    `INSERT OR IGNORE INTO template_versions (template_id, version, manifest, pass_json, assets, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`,
    [
      template.id,
      template.version,
      JSON.stringify(template.manifest),
      JSON.stringify(template.passJson),
      now,
    ],
  );
}

export interface PassRow {
  id: string;
  orgId: string;
  serial: string;
  authToken: string;
  downloadToken: string;
  objectKey: string;
}

/** Inserts a pass through SQL (the passes repo replaces this once it exists). */
export async function makePass(
  f: Fixtures,
  options: {
    orgId: string;
    template: ResolvedTemplate;
    holderEmail?: string;
    personalization?: object;
  },
): Promise<PassRow> {
  await ensurePlatformIdentity(f.env, f.clock.now());
  await persistTemplate(f, options.template);
  const id = f.ids.id();
  const row: PassRow = {
    id,
    orgId: options.orgId,
    serial: f.ids.token(16),
    authToken: f.ids.token(),
    downloadToken: f.ids.token(),
    objectKey: `passes/${id}/v1-${f.ids.token(4)}.pkpass`,
  };
  await f.env.BUCKET.put(row.objectKey, new Uint8Array([1, 2, 3]));
  const now = f.clock.now();
  await run(
    f.env.DB,
    `INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
       web_service_url, personalization, holder_email, object_key, modified_at, created_at, pending_cause)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create')`,
    [
      row.id,
      row.orgId,
      PLATFORM_IDENTITY_ID,
      row.serial,
      options.template.id,
      options.template.version,
      row.authToken,
      row.downloadToken,
      `${f.env.PUBLIC_BASE_URL}/wallet`,
      JSON.stringify(options.personalization ?? { memberName: 'Alex Morgan' }),
      options.holderEmail ?? null,
      row.objectKey,
      now,
      now,
    ],
  );
  return row;
}

export interface SessionFixture {
  userId: string;
  cookieValue: string;
  csrf: string;
  headers: Record<string, string>;
}

/** Inserts a real session row (hash of the cookie value) for tests that run the real auth store. */
export async function makeSession(
  f: Fixtures,
  options: { userId: string; roles?: ('admin' | 'user')[]; amr?: 'oidc' | 'magic_link' },
): Promise<SessionFixture> {
  const cookieValue = f.ids.token();
  const csrf = f.ids.token();
  const now = f.clock.now();
  const roles = options.roles ?? ['user'];
  await run(
    f.env.DB,
    `INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      await sha256Hex(cookieValue),
      options.userId,
      options.amr ?? 'oidc',
      JSON.stringify(roles),
      csrf,
      now,
      now,
      now + 3600_000,
      now + 12 * 3600_000,
    ],
  );
  return {
    userId: options.userId,
    cookieValue,
    csrf,
    headers: {
      cookie: `__Host-wallet_sid=${cookieValue}`,
      'x-csrf-token': csrf,
      'sec-fetch-site': 'same-origin',
    },
  };
}

export interface ApiKeyFixture {
  id: string;
  secret: string;
  headers: Record<string, string>;
}

/** Inserts an API key row. Format wlt_<prefix>_<secret>; only the SHA-256 is stored. */
export async function makeApiKey(
  f: Fixtures,
  options: { orgId?: string | null; scopes?: string[]; name?: string } = {},
): Promise<ApiKeyFixture> {
  const id = f.ids.id();
  const prefix = f.ids.token(6);
  const secret = `wlt_${prefix}_${f.ids.token()}`;
  await run(
    f.env.DB,
    'INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      options.orgId ?? null,
      options.name ?? 'Test key',
      prefix,
      await sha256Hex(secret),
      JSON.stringify(options.scopes ?? ['passes:read', 'passes:write']),
      f.clock.now(),
    ],
  );
  return { id, secret, headers: { authorization: `Bearer ${secret}` } };
}
