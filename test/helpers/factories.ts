import { InMemoryTemplateRegistry } from '../../src/passkit/template/in-memory-registry.ts';
import type { ResolvedTemplate } from '../../src/passkit/template/registry.ts';
import type { PassJson, TemplateManifest } from '../../src/passkit/types.ts';
import { ensurePlatformIdentity } from '../../src/worker/modules/identities/repo.ts';
import { PLATFORM_IDENTITY_ID } from '../../src/worker/modules/identities/resolver.ts';
import { hashPin } from '../../src/worker/modules/scan/staff-pin.ts';
import { putVersionAsset } from '../../src/worker/modules/templates/asset-storage.ts';
import { canonicalJson, crc32, sha1Hex } from '../../src/worker/modules/templates/package/hash.ts';
import { r2Key } from '../../src/worker/modules/templates/registry.ts';
import { ManualClock } from '../../src/worker/platform/clock.ts';
import { first, run } from '../../src/worker/platform/db.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';
import { ConflictError } from '../../src/worker/platform/errors.ts';
import { createIds, type Ids, sha256Hex } from '../../src/worker/platform/ids.ts';
import { createServiceContext } from '../../src/worker/platform/service-context.ts';

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
  // D1 storage lasts for the whole file, so a fixed id (like 'admin-1') is created once.
  if (overrides.id) {
    const existing = await first<{ primary_email: string }>(
      f.env.DB,
      'SELECT primary_email FROM users WHERE id = ?',
      [id],
    );
    if (existing) return { id, primaryEmail: existing.primary_email };
  }
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

/** Prepare R2 metadata for a first insert without rewriting an occupied or retired key. */
export async function materializeTemplateAssets(
  f: Fixtures,
  template: ResolvedTemplate,
  registry: InMemoryTemplateRegistry,
  db: D1Database = f.env.DB,
): Promise<ResolvedTemplate['assets']> {
  const identity = await first<{ present: number; retired: number }>(
    db,
    `SELECT EXISTS(SELECT 1 FROM template_versions WHERE template_id = ? AND version = ?) AS present,
            EXISTS(SELECT 1 FROM template_version_tombstones WHERE template_id = ? AND version = ?) AS retired`,
    [template.id, template.version, template.id, template.version],
  );
  if (!identity) throw new Error('Could not check fixture template version identity.');
  if (identity.retired)
    throw new ConflictError(
      `Fixture ${template.id}@${template.version} has been retired.`,
      'TEMPLATE_VERSION_CONFLICT',
    );
  const objects: { key: string; bytes: Uint8Array }[] = [];
  const assets = await Promise.all(
    template.assets.map(async (asset) => {
      if (asset.source.kind !== 'inline') return asset;
      const bytes = new Uint8Array(
        await new Response(await registry.openAsset(template, asset.name)).arrayBuffer(),
      );
      const key = r2Key(template.orgId, template.id, template.version, asset.name);
      objects.push({ key, bytes });
      return {
        ...asset,
        size: bytes.length,
        sha1: await sha1Hex(bytes),
        crc32: crc32(bytes),
        source: { kind: 'r2' as const, key },
      };
    }),
  );
  if (!identity.present && objects.length > 0) {
    const ctx = createServiceContext(f.env, { clock: f.clock });
    await Promise.all(objects.map(({ key, bytes }) => putVersionAsset(ctx, key, bytes)));
  }
  return assets;
}

/** Writes an immutable fixture version; omitted assets and build key are unspecified on reuse. */
export async function persistTemplate(
  f: Fixtures,
  template: ResolvedTemplate,
  options?: {
    assets?: ResolvedTemplate['assets'];
    registry?: InMemoryTemplateRegistry;
    buildKey?: string | null;
    db?: D1Database;
  },
): Promise<void> {
  if (options?.registry && options.assets !== undefined)
    throw new Error('Provide either fixture assets or a registry, not both.');
  const db = options?.db ?? f.env.DB;
  const now = f.clock.now();
  await run(
    db,
    `INSERT OR IGNORE INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM template_version_tombstones WHERE template_id = ? AND version = ?
     )`,
    [
      template.id,
      template.orgId,
      template.id,
      template.manifest.name,
      template.origin,
      template.version,
      now,
      now,
      template.id,
      template.version,
    ],
  );
  const assets = options?.registry
    ? await materializeTemplateAssets(f, template, options.registry, db)
    : options?.assets;
  const inserted = await run(
    db,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, created_at, build_key)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM template_versions WHERE template_id = ? AND version = ?
     ) AND NOT EXISTS (
       SELECT 1 FROM template_version_tombstones WHERE template_id = ? AND version = ?
     )`,
    [
      template.id,
      template.version,
      JSON.stringify(template.manifest),
      JSON.stringify(template.passJson),
      assets === undefined ? '[]' : JSON.stringify(assets),
      now,
      options?.buildKey ?? null,
      template.id,
      template.version,
      template.id,
      template.version,
    ],
  );
  if (inserted.changes === 0) {
    const existing = await first<{
      manifest: string;
      pass_json: string;
      assets: string;
      build_key: string | null;
    }>(
      db,
      `SELECT manifest, pass_json, assets, build_key FROM template_versions
       WHERE template_id = ? AND version = ?`,
      [template.id, template.version],
    );
    if (
      !existing ||
      canonicalJson(JSON.parse(existing.manifest)) !== canonicalJson(template.manifest) ||
      canonicalJson(JSON.parse(existing.pass_json)) !== canonicalJson(template.passJson) ||
      (assets !== undefined &&
        canonicalJson(JSON.parse(existing.assets)) !== canonicalJson(assets)) ||
      (options?.buildKey !== undefined && existing.build_key !== options.buildKey)
    )
      throw new ConflictError(
        `Persisted fixture ${template.id}@${template.version} differs or has been retired.`,
        'TEMPLATE_VERSION_CONFLICT',
      );
  }
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
    registry?: InMemoryTemplateRegistry;
    mode?: 'live' | 'test';
    ownerUserId?: string | null;
    identityId?: string;
    serial?: string;
    authToken?: string;
    scanCode?: string | null;
    holderEmail?: string | null;
    personalization?: object;
    /** False when the template version is already stored (a synced baked one) and must not be compared. */
    persist?: boolean;
  },
): Promise<PassRow> {
  await ensurePlatformIdentity(f.env, f.clock.now());
  if (options.persist !== false)
    await persistTemplate(
      f,
      options.template,
      options.registry ? { registry: options.registry } : undefined,
    );
  const id = f.ids.id();
  const row: PassRow = {
    id,
    orgId: options.orgId,
    serial: options.serial ?? f.ids.token(16),
    authToken: options.authToken ?? f.ids.token(),
    downloadToken: f.ids.token(),
    objectKey: `passes/${id}/v1-${f.ids.token(4)}.pkpass`,
  };
  await f.env.BUCKET.put(row.objectKey, new Uint8Array([1, 2, 3]));
  const now = f.clock.now();
  await run(
    f.env.DB,
    `INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
       web_service_url, personalization, holder_email, owner_user_id, mode, scan_code,
       object_key, modified_at, created_at, pending_cause)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create')`,
    [
      row.id,
      row.orgId,
      options.identityId ?? PLATFORM_IDENTITY_ID,
      row.serial,
      options.template.id,
      options.template.version,
      row.authToken,
      row.downloadToken,
      `${f.env.PUBLIC_BASE_URL}/wallet`,
      JSON.stringify(options.personalization ?? { memberName: 'Alex Morgan' }),
      options.holderEmail ?? null,
      options.ownerUserId ?? null,
      options.mode ?? 'live',
      options.scanCode ?? null,
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
  options: {
    userId: string;
    roles?: ('admin' | 'user')[];
    amr?: 'oidc' | 'magic_link' | 'breakglass';
  },
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
  options: { orgId?: string | null; scopes?: string[]; name?: string; mode?: 'live' | 'test' } = {},
): Promise<ApiKeyFixture> {
  const id = f.ids.id();
  const prefix = f.ids.token(6);
  const secret = `wlt_${prefix}_${f.ids.token()}`;
  await run(
    f.env.DB,
    'INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      options.orgId ?? null,
      options.name ?? 'Test key',
      prefix,
      await sha256Hex(secret),
      JSON.stringify(options.scopes ?? ['passes:read', 'passes:write']),
      options.mode ?? 'live',
      f.clock.now(),
    ],
  );
  return { id, secret, headers: { authorization: `Bearer ${secret}` } };
}

export interface StaffFixture {
  id: string;
  name: string;
  role: 'door' | 'desk' | 'manager';
  pin: string;
}

/** A scan_staff row with a real HMAC PIN hash. */
export async function makeScanStaff(
  f: Fixtures,
  options: {
    orgId: string;
    name?: string;
    role?: 'door' | 'desk' | 'manager';
    pin?: string;
    disabled?: boolean;
  },
): Promise<StaffFixture> {
  const id = f.ids.id();
  const pin = options.pin ?? '123456';
  const now = f.clock.now();
  const name = options.name ?? `Staff ${id.slice(-6)}`;
  const role = options.role ?? 'door';
  await run(
    f.env.DB,
    `INSERT INTO scan_staff (id, org_id, name, role, pin_hash, pin_set_at, disabled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      options.orgId,
      name,
      role,
      await hashPin(f.env, id, pin),
      now,
      options.disabled ? now : null,
      now,
      now,
    ],
  );
  return { id, name, role, pin };
}

export interface EventFixture {
  id: string;
}

export async function makeScanEvent(
  f: Fixtures,
  options: {
    orgId: string;
    mode?: 'live' | 'test';
    templateIds?: string[];
    opensAt?: number;
    closesAt?: number;
  },
): Promise<EventFixture> {
  const id = f.ids.id();
  const now = f.clock.now();
  await run(
    f.env.DB,
    `INSERT INTO scan_events (id, org_id, mode, name, opens_at, closes_at, time_zone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'UTC', ?, ?)`,
    [
      id,
      options.orgId,
      options.mode ?? 'live',
      'Event',
      options.opensAt ?? now - 3600_000,
      options.closesAt ?? now + 3600_000,
      now,
      now,
    ],
  );
  for (const templateId of options.templateIds ?? [])
    await run(f.env.DB, 'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)', [
      id,
      templateId,
    ]);
  return { id };
}

export interface ScannerFixture {
  id: string;
  token: string;
  headers: Record<string, string>;
}

const DEFAULT_SCANNER_SETTINGS = {
  flow: 'auto',
  defaultActionId: null,
  roleWithoutSignIn: 'door',
  staffSignIn: false,
  letInAgain: 'anyone',
  reader: 'none',
  lookup: true,
  offline: false,
  dailyAmount: null,
};

/**
 * A paired scanner row with a real token. Device: cookie headers with the CSRF secret.
 * Terminal: bearer headers. Accepts an event or templates.
 */
export async function makeScanner(
  f: Fixtures,
  options: {
    orgId: string;
    mode?: 'live' | 'test';
    kind?: 'device' | 'terminal' | 'display';
    deviceRole?: 'scan' | 'customer' | 'monitor';
    eventId?: string | null;
    templateIds?: string[];
    settings?: Record<string, unknown>;
    staffId?: string;
    staffSince?: number;
    staffSeenAt?: number;
    revoked?: boolean;
    expiresAt?: number | null;
    lastSeenAt?: number | null;
    origin?: string;
  },
): Promise<ScannerFixture> {
  const id = f.ids.id();
  const now = f.clock.now();
  const kind = options.kind ?? 'device';
  const prefix = f.ids
    .token(24)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8);
  const token = `wls_${prefix}_${f.ids.token(32)}`;
  const csrf = kind === 'terminal' ? null : f.ids.token();
  const deviceRole = options.deviceRole ?? (kind === 'display' ? 'customer' : 'scan');
  await run(
    f.env.DB,
    `INSERT INTO scanners (id, org_id, mode, kind, device_role, name, event_id, settings, time_zone, token_prefix, token_hash,
       csrf_secret, paired_at, expires_at, last_seen_at, staff_id, staff_since, staff_seen_at, created_at, updated_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UTC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      options.orgId,
      options.mode ?? 'live',
      kind,
      deviceRole,
      `Scanner ${id.slice(-6)}`,
      options.eventId ?? null,
      JSON.stringify({ ...DEFAULT_SCANNER_SETTINGS, ...options.settings }),
      prefix,
      await sha256Hex(token),
      csrf,
      now,
      options.expiresAt === undefined ? now + 180 * 86_400_000 : options.expiresAt,
      options.lastSeenAt === undefined ? now : options.lastSeenAt,
      options.staffId ?? null,
      options.staffId ? (options.staffSince ?? now) : null,
      options.staffId ? (options.staffSeenAt ?? now) : null,
      now,
      now,
      options.revoked ? now : null,
    ],
  );
  for (const templateId of options.templateIds ?? [])
    await run(f.env.DB, 'INSERT INTO scanner_templates (scanner_id, template_id) VALUES (?, ?)', [
      id,
      templateId,
    ]);
  const headers: Record<string, string> =
    kind === 'terminal'
      ? { authorization: `Bearer ${token}` }
      : {
          cookie: `__Host-wallet_scan=${token}`,
          'x-csrf-token': csrf ?? '',
          origin: options.origin ?? 'https://wallet.test',
          'sec-fetch-site': 'same-origin',
        };
  return { id, token, headers };
}
