// A production-shaped database at schema 0024, written with raw SQL as the pre-cutover Worker left it.
import { applyD1Migrations } from 'cloudflare:test';
import { env as bindings } from 'cloudflare:workers';
import type { BakedTemplate } from '../../src/worker/modules/templates/baked-types.ts';
import { basicPackage, makePng } from '../../src/worker/modules/templates/package/fixtures.ts';
import { bakedR2Key } from '../../src/worker/modules/templates/sync.ts';
import {
  type BakedFixture,
  bakedFrom,
  fakeAssets,
} from '../../src/worker/modules/templates/testing.ts';
import { sha256Hex } from '../../src/worker/platform/ids.ts';

/** Three days before the test run, so scanner expiry and session windows behave like production. */
export const AT = Date.now() - 3 * 86_400_000;
/** A scan from a minute before the cutover, inside the undo window. */
const RECENT = Date.now() - 60_000;
export const OWNER = 'owner@example.com';
export const SHAPES = [
  'baked-unassigned',
  'baked-assigned',
  'baked-assigned-empty',
  'uploaded-active',
  'uploaded-archived',
  'uploaded-empty',
] as const;
export type Shape = (typeof SHAPES)[number];

export interface LegacyPass {
  id: string;
  shape: Shape;
  orgId: string;
  serial: string;
  authToken: string;
  downloadToken: string;
  email: string | null;
  scanId: string | null;
  /** The text of the pass's barcode, as the holder's phone shows it. */
  barcode: string;
}
export interface LegacyScanner {
  id: string;
  headers: Record<string, string>;
}
export interface Legacy {
  scanners: Record<string, LegacyScanner>;
  /** Set when a second baked sync shipped new starter content. */
  bumpedVersion?: string;
  db: D1Database;
  passes: LegacyPass[];
  templateIds: Record<Shape, string>;
  baked: BakedFixture[];
  assets: ReturnType<typeof fakeAssets>;
}

type Migration = { name: string; queries: string[] };
const number = (m: Migration) => Number.parseInt(m.name.slice(0, 4), 10);

/** An empty D1 migrated up to `upTo` only (the isolated keyset databases are never pre-migrated). */
export async function legacyDatabase(slot: number, upTo = 24): Promise<D1Database> {
  const db = (bindings as unknown as Record<string, D1Database | undefined>)[
    `KEYSET_TEST_DB_${slot}`
  ];
  if (!db) throw new Error(`No isolated D1 binding for slot ${slot}`);
  const migrations = (bindings as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS;
  await applyD1Migrations(
    db,
    migrations.filter((m) => number(m) <= upTo),
  );
  return db;
}

/** Applies 0025 and later, in order. */
export async function migrateForward(db: D1Database): Promise<void> {
  await applyD1Migrations(
    db,
    (bindings as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS,
  );
}

const q = (v: string | number | null) =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replaceAll("'", "''")}'`;

export const SCAN = { actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }] };

async function bakedPair(): Promise<BakedFixture[]> {
  const built = await bakedFixtures();
  for (const f of built) f.template.manifest = { ...f.template.manifest, scan: SCAN } as never;
  return built;
}

async function bakedFixtures(): Promise<BakedFixture[]> {
  return [
    await bakedFrom('starter', basicPackage(), { name: 'Starter' }),
    await bakedFrom('acme-card', basicPackage({ 'logo.png': makePng(100, 40) }), {
      name: 'Acme Card',
      org: { slug: 'org-a', name: 'Org A' },
    }),
    await bakedFrom('acme-spare', basicPackage({ 'logo.png': makePng(90, 40) }), {
      name: 'Acme Spare',
      org: { slug: 'org-a', name: 'Org A' },
    }),
  ];
}

/** What the baseline sync stored: r2 sources, no build key, org from the manifest or a later PATCH. */
const r2Assets = (t: BakedTemplate) =>
  t.assets.map((a) => ({
    ...a,
    source: { kind: 'r2', key: bakedR2Key(t.slug, t.version, a.name) },
  }));

export async function seedLegacy(db: D1Database, bucket: R2Bucket): Promise<Legacy> {
  const baked = await bakedPair();
  const assets = fakeAssets();
  for (const f of baked) for (const [k, v] of f.files) assets.files.set(k, v);
  const [starter, acme, spare] = baked.map((f) => f.template) as [
    BakedTemplate,
    BakedTemplate,
    BakedTemplate,
  ];
  const stmts: string[] = [];
  const add = (sql: string) => stmts.push(sql);

  add(`INSERT INTO users (id, name, primary_email, status, created_at, last_roles) VALUES
    ('u-owner', 'Owner', ${q(OWNER)}, 'active', ${AT}, '["admin"]'),
    ('u-admin2', 'Second admin', 'admin2@example.com', 'active', ${AT}, '["admin"]'),
    ('u-holder', 'Holder', 'holder@example.com', 'active', ${AT}, '["user"]')`);
  add(`INSERT INTO orgs (id, slug, name, status, branding, created_at, updated_at) VALUES
    ('org-a', 'org-a', 'Org A', 'active', '{}', ${AT}, ${AT}),
    ('org-b', 'org-b', 'Org B', 'active', '{}', ${AT}, ${AT}),
    ('org-gone', 'org-gone', 'Gone', 'deleted', '{}', ${AT}, ${AT})`);
  add(`INSERT INTO signing_identities (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix,
      is_default, created_at) VALUES ('platform', NULL, 'Platform', 'pass.im.plrs.wallet', '48H7CLBV8Y', 'env',
      'PLATFORM', 1, ${AT})`);
  add(`INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at,
      expires_at) VALUES ('s-hash-1', 'u-owner', 'oidc', '["admin","user"]', 'csrf', ${AT}, ${AT}, ${AT + 9e8}, ${AT + 9e9})`);
  add(`INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_by, created_at, mode)
    VALUES ('key-1', 'org-a', 'Integration', 'wlk_abcd1234', ${q('k'.repeat(64))}, '["passes:write"]', 'u-owner', ${AT}, 'live')`);
  // The baseline sync's marker: the new sync adopts it instead of treating the build as superseded.
  add(
    `INSERT INTO settings (scope, key, value, updated_at) VALUES ('system', 'templates.baked_hash', '"baseline-hash"', ${AT})`,
  );
  add(`INSERT INTO magic_links (token_hash, email, purpose, user_id, created_at, expires_at)
    VALUES ('m-hash-1', 'holder@example.com', 'sign_in', 'u-holder', ${AT}, ${AT + 9e8})`);

  const templateIds = {
    'baked-unassigned': starter.id,
    'baked-assigned': acme.id,
    'baked-assigned-empty': spare.id,
    'uploaded-active': 'up-active',
    'uploaded-archived': 'up-archived',
    'uploaded-empty': 'up-empty',
  } as const satisfies Record<Shape, string>;
  const bakedRow = (t: BakedTemplate, orgId: string | null) => {
    add(`INSERT INTO templates (id, org_id, slug, name, description, origin, active_version, status, styles,
      created_at, updated_at) VALUES (${q(t.id)}, ${q(orgId)}, ${q(t.slug)}, ${q(t.name)}, NULL, 'baked',
      ${q(t.version)}, 'active', ${q(JSON.stringify(t.styles))}, ${AT}, ${AT})`);
    add(versionRow(t.id, t.version, t.manifest, t.passJson, r2Assets(t), t.report));
  };
  const versionRow = (id: string, v: string, m: unknown, p: unknown, a: unknown, r: unknown) =>
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_at)
      VALUES (${q(id)}, ${q(v)}, ${q(JSON.stringify(m))}, ${q(JSON.stringify(p))}, ${q(JSON.stringify(a))},
      ${q(JSON.stringify(r))}, ${AT})`;
  bakedRow(starter, null);
  bakedRow(acme, 'org-a');
  bakedRow(spare, 'org-a');
  // Uploaded templates reuse the starter's package content with r2 sources under their own prefix.
  const uploaded: [string, string, string][] = [
    ['up-active', 'org-a', 'active'],
    ['up-archived', 'org-a', 'archived'],
    ['up-empty', 'org-b', 'active'],
  ];
  for (const [id, org, status] of uploaded) {
    add(`INSERT INTO templates (id, org_id, slug, name, origin, active_version, status, styles, created_at, updated_at)
      VALUES (${q(id)}, ${q(org)}, ${q(id)}, ${q(id)}, 'uploaded', 'v2', ${q(status)}, '[]', ${AT}, ${AT})`);
    const upAssets = starter.assets.map((a) => ({
      ...a,
      source: { kind: 'r2', key: `templates/${org}/${id}/${a.name}` },
    }));
    for (const a of starter.assets) {
      const bytes = baked[0]?.files.get(`/templates/starter/${starter.version}/${a.name}`);
      if (bytes) await bucket.put(`templates/${org}/${id}/${a.name}`, bytes);
    }
    for (const v of ['v1', 'v2'])
      add(versionRow(id, v, starter.manifest, starter.passJson, upAssets, starter.report));
  }

  const passes: LegacyPass[] = [];
  const pass = async (
    shape: Shape,
    org: string,
    n: number,
    version: string,
    email: string | null,
  ) => {
    const id = `pass-${shape}-${n}`;
    const p: LegacyPass = {
      id,
      shape,
      orgId: org,
      serial: `serial-${shape}-${n}`,
      authToken: `auth-${shape}-${n}`,
      downloadToken: `dl-${shape}-${n}`,
      email,
      scanId: null,
      barcode: `BC-${shape}-${n}`,
    };
    const templateId = templateIds[shape];
    const tv = shape.startsWith('baked')
      ? (baked.find((b) => b.template.id === templateId)?.template.version ?? version)
      : version;
    // The snapshot the old Worker stored for Wallet: the built pass.json with the identity and the barcode.
    const wallet = {
      ...starter.passJson,
      serialNumber: p.serial,
      passTypeIdentifier: 'pass.im.plrs.wallet',
      teamIdentifier: '48H7CLBV8Y',
      barcodes: [
        { format: 'PKBarcodeFormatQR', message: p.barcode, messageEncoding: 'iso-8859-1' },
      ],
    };
    add(`INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
      web_service_url, personalization, display_title, holder_email, owner_user_id, status, version, object_key,
      modified_at, created_at, mode, pending_pass_json, barcode_hash) VALUES (${q(id)}, ${q(org)}, 'platform', ${q(p.serial)},
      ${q(templateId)}, ${q(tv)}, ${q(p.authToken)}, ${q(p.downloadToken)}, 'https://wallet.plrs.im/v1',
      '{}', ${q(`Pass ${n}`)}, ${q(email)}, ${n === 1 && email ? "'u-holder'" : 'NULL'}, 'active', 1,
      ${q(`passes/${id}/1.pkpass`)}, ${AT}, ${AT}, 'live', ${q(JSON.stringify(wallet))}, ${q(await sha256Hex(p.barcode))})`);
    passes.push(p);
    return p;
  };
  const withPasses: [Shape, string][] = [
    ['baked-unassigned', 'org-a'],
    ['baked-assigned', 'org-a'],
    ['uploaded-active', 'org-a'],
    ['uploaded-archived', 'org-a'],
  ];
  const scanners: Record<string, LegacyScanner> = {};
  for (const [shape, org] of withPasses) {
    const sid = `sc-${shape}`;
    const token = `wls_door${Object.keys(scanners).length}xxx_${'t'.repeat(43)}`;
    const settings = {
      flow: 'auto',
      defaultActionId: null,
      roleWithoutSignIn: 'door',
      staffSignIn: false,
      letInAgain: 'anyone',
      reader: 'none',
      lookup: true,
      offline: false,
      dailyAmount: null,
      checkIn: { mode: 'in_out' },
      direction: 'both',
    };
    add(`INSERT INTO scanners (id, org_id, mode, kind, device_role, name, settings, time_zone, token_prefix, token_hash,
      csrf_secret, paired_at, expires_at, last_seen_at, created_at, updated_at) VALUES (${q(sid)}, ${q(org)}, 'live',
      'device', 'scan', ${q(`Door ${shape}`)}, ${q(JSON.stringify(settings))}, 'UTC', ${q(token.split('_')[1] ?? '')},
      ${q(await sha256Hex(token))}, 'csrf-${shape}', ${AT}, ${AT + 9e9}, ${AT}, ${AT}, ${AT})`);
    add(
      `INSERT INTO scanner_templates (scanner_id, template_id) VALUES (${q(sid)}, ${q(templateIds[shape])})`,
    );
    scanners[shape] = {
      id: sid,
      headers: {
        cookie: `__Host-wallet_scan=${token}`,
        'x-csrf-token': `csrf-${shape}`,
        origin: 'https://wallet.test',
        'sec-fetch-site': 'same-origin',
      },
    };
    const first = await pass(shape, org, 1, 'v1', 'holder@example.com');
    await pass(shape, org, 2, 'v2', null);
    // Never touched after the cutover: scanned by its pre-cutover barcode before any republish.
    await pass(shape, org, 5, 'v2', null);
    // One device with a push token per first pass, and a pre-cutover email and push still queued.
    add(
      `INSERT OR IGNORE INTO devices (device_id, identity_id, push_token, updated_at) VALUES ('dev-${shape}', 'platform', 'tok-${shape}', ${AT})`,
    );
    add(
      `INSERT INTO registrations (device_id, identity_id, pass_id, created_at, push_token) VALUES ('dev-${shape}', 'platform', ${q(first.id)}, ${AT}, 'tok-${shape}')`,
    );
    add(`INSERT INTO outbox (id, org_id, kind, pass_id, payload, state, created_at) VALUES
      ('mail-${shape}', ${q(org)}, 'email', ${q(first.id)}, '{"to":"holder@example.com","attach":false}', 'pending', ${AT}),
      ('sent-${shape}', ${q(org)}, 'email', ${q(first.id)}, '{"to":"holder@example.com","attach":false}', 'sent', ${AT}),
      ('push-${shape}', ${q(org)}, 'push', ${q(first.id)}, '{}', 'pending', ${AT})`);
    // A pre-cutover check-in on the second pass: scan, presence, gate and ledger rows as the old Worker wrote them.
    const scanned = await pass(shape, org, 3, 'v2', null);
    scanned.scanId = `scan-${shape}`;
    add(`INSERT INTO scans (id, org_id, mode, pass_id, template_id, scanner_id, actor_type, actor_id, actor_key, idempotency_key,
      request_hash, method, state, outcome, action_id, action_kind, direction, pass_version, at) VALUES
      (${q(scanned.scanId)}, ${q(org)}, 'live', ${q(scanned.id)}, ${q(templateIds[shape])}, ${q(sid)}, 'scanner', ${q(sid)}, ${q(`s:${sid}`)},
      ${q(`idem-${shape}`)}, 'h', 'manual', 'done', 'ok', 'enter', 'check_in', 'in', 1, ${RECENT})`);
    add(`INSERT INTO scan_presence (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at, last_scan_id)
      VALUES (${q(scanned.id)}, ${q(org)}, '', 'in', 1, ${RECENT}, ${RECENT}, ${RECENT}, ${q(scanned.scanId)})`);
    add(`INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
      VALUES (${q(scanned.id)}, 'enter', '', ${q(org)}, 'live', ${q(templateIds[shape])}, 'check_in', 'in', 1, ${RECENT}, ${RECENT}, ${q(scanned.scanId)})`);
    add(`INSERT INTO pass_events (id, org_id, pass_id, mode, kind, actor_type, actor_id, data, at)
      VALUES (${q(`ev-${shape}`)}, ${q(org)}, ${q(scanned.id)}, 'live', 'scan.ok', 'user', 'u-owner', '{}', ${RECENT})`);
  }
  // A pass in the second org on the shared starter (unassigned baked templates serve every org).
  await pass('baked-unassigned', 'org-b', 4, starter.version, 'other@example.com');
  for (const s of stmts) await db.prepare(s).run();
  return { db, scanners, passes, templateIds, baked, assets };
}

/** Row counts of every table that holds 0024 data, and the pass credentials, for a before/after comparison. */
export async function dataFingerprint(db: D1Database, tables: string[]) {
  const counts: Record<string, number> = {};
  for (const t of tables)
    counts[t] = (await db.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? 0;
  const creds = await db
    .prepare('SELECT id, serial, auth_token, download_token FROM passes ORDER BY id')
    .all();
  return { counts, creds: creds.results };
}
