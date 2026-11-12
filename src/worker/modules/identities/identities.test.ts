import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { buildManifest, signManifest } from '../../../passkit/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { checkIdentityById, runDailyIdentityChecks } from './check.ts';
import { clearIdentityKeyCache } from './db-resolver.ts';
import { LEGACY_P12, P12_PASSWORD } from './p12-fixtures.ts';
import { ensurePlatformIdentity } from './repo.ts';
import { createIdentityResolver } from './resolver.ts';

const fake = fakeAuth();
let n = 0;
async function acme(overrides: { now?: Date; days?: number } = {}) {
  n += 1;
  return createFixtureIdentity(
    { passTypeIdentifier: `pass.com.acme.t${n}`, teamIdentifier: 'ACME123456' },
    overrides,
  );
}
type Fixture = Awaited<ReturnType<typeof acme>>;

let base: AppEnv;
let appEnv: AppEnv;
let app: ReturnType<typeof createApp>;

/** Env whose WWDR stand-in is the fixture's CA. */
// The shared test KEK decodes to 35 bytes; use a valid 32-byte one here.
const KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

async function envFor(f: Fixture, extra: Partial<AppEnv> = {}) {
  return makeEnv({ SIGNER_PLATFORM_INTERMEDIATE: f.intermediate, KEK_V1, ...extra });
}
const call = (method: string, path: string, body?: unknown, headers = fake.admin(), e = appEnv) =>
  app.request(
    `/api/v1/identities${path}`,
    {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
    e,
  );
const pem = (f: Fixture, label = 'Acme') => ({
  label,
  certificatePem: f.certificate,
  privateKeyPem: f.privateKey,
});
type Dto = Record<string, unknown> & { id: string };
const upload = async (f: Fixture, extra: Record<string, unknown> = {}) => {
  appEnv = await envFor(f);
  return call('POST', '', { ...pem(f), ...extra });
};

async function identityRevision(id: string) {
  const row = await first<{ revision: number }>(
    env.DB,
    'SELECT revision FROM signing_identities WHERE id = ?',
    [id],
  );
  if (!row) throw new Error(`Missing identity ${id}`);
  return row.revision;
}

beforeAll(async () => {
  base = await makeEnv();
  app = createApp({ stores: fake.stores });
});
beforeEach(() => clearIdentityKeyCache());

describe('identity rotation', () => {
  it('swaps cert and key for the same pass type ID, drops the old credential and audits', async () => {
    const f = await acme();
    const dto = (await (await upload(f)).json()) as Dto;
    const beforeRevision = await identityRevision(dto.id);
    const before = await first<{ credential_id: string }>(
      env.DB,
      'SELECT credential_id FROM signing_identities WHERE id = ?',
      [dto.id],
    );
    const renewed = await createFixtureIdentity(f.identity, { days: 5 });
    appEnv = await envFor(renewed);
    const res = await call('POST', `/${dto.id}/rotate`, {
      certificatePem: renewed.certificate,
      privateKeyPem: renewed.privateKey,
    });
    expect(res.status).toBe(200);
    const next = (await res.json()) as Dto;
    expect(next.certSha256).not.toBe(dto.certSha256);
    expect(next.daysRemaining).toBe(4);
    expect(next).not.toHaveProperty('revision');
    const rotatedRevision = await identityRevision(dto.id);
    expect(rotatedRevision).toBeGreaterThan(beforeRevision);
    expect(
      await first(env.DB, 'SELECT 1 AS x FROM credentials WHERE id = ?', [before?.credential_id]),
    ).toBeNull();
    const row = await first<{ rotated_at: number | null }>(
      env.DB,
      'SELECT c.rotated_at FROM credentials c JOIN signing_identities s ON s.credential_id = c.id WHERE s.id = ?',
      [dto.id],
    );
    expect(row?.rotated_at).toBeGreaterThan(0);
    const audit = await first(
      env.DB,
      "SELECT 1 AS x FROM audit_log WHERE action = 'identity.rotate' AND target_id = ?",
      [dto.id],
    );
    expect(audit).not.toBeNull();
    const resolved = await createIdentityResolver(appEnv).byId(dto.id);
    expect(resolved.material.privateKey).toContain(renewed.privateKey.slice(0, 40));

    appEnv = await envFor(f);
    const restored = await call('POST', `/${dto.id}/rotate`, {
      certificatePem: f.certificate,
      privateKeyPem: f.privateKey,
    });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as Dto).certSha256).toBe(dto.certSha256);
    expect(await identityRevision(dto.id)).toBeGreaterThan(rotatedRevision);
  });

  it('refuses another pass type ID and the platform identity', async () => {
    const f = await acme();
    const dto = (await (await upload(f)).json()) as Dto;
    const other = await acme();
    appEnv = await envFor(other);
    const wrong = await call('POST', `/${dto.id}/rotate`, {
      certificatePem: other.certificate,
      privateKeyPem: other.privateKey,
    });
    expect(wrong.status).toBe(422);
    expect(((await wrong.json()) as { code: string }).code).toBe('IDENTITY_MISMATCH');
    const platform = await call('POST', '/platform/rotate', {
      certificatePem: other.certificate,
      privateKeyPem: other.privateKey,
    });
    expect([404, 409]).toContain(platform.status);
  });
});

describe('identity authority revision', () => {
  it('starts positive and stays unchanged for no-op and non-authority updates', async () => {
    const f = await acme();
    const response = await upload(f);
    expect(response.status).toBe(201);
    const dto = (await response.json()) as Dto;
    expect(dto).not.toHaveProperty('revision');
    const initial = await identityRevision(dto.id);
    expect(Number.isInteger(initial)).toBe(true);
    expect(initial).toBeGreaterThan(0);
    for (const invalid of [0, -1, 1.5, null]) {
      await expect(
        run(env.DB, 'UPDATE signing_identities SET revision = ? WHERE id = ?', [invalid, dto.id]),
      ).rejects.toThrow();
    }
    expect(await identityRevision(dto.id)).toBe(initial);

    const unchanged = await call('PATCH', `/${dto.id}`, {
      label: 'Acme',
      nfcEnabled: false,
      apnsBinding: null,
      isDefault: false,
    });
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()) as Dto).not.toHaveProperty('revision');
    expect(await identityRevision(dto.id)).toBe(initial);

    const renamed = await call('PATCH', `/${dto.id}`, { label: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(await identityRevision(dto.id)).toBe(initial);
    await run(env.DB, "UPDATE signing_identities SET apns_health = 'healthy' WHERE id = ?", [
      dto.id,
    ]);
    expect(await identityRevision(dto.id)).toBe(initial);

    const fetched = await call('GET', `/${dto.id}`);
    expect(fetched.status).toBe(200);
    expect((await fetched.json()) as Dto).not.toHaveProperty('revision');
    const listed = await call('GET', '?limit=200');
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: Dto[] };
    const item = page.items.find((identity) => identity.id === dto.id);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('revision');
  });

  it('advances for each authority change, including A to B to A, but not a repeated patch', async () => {
    const response = await upload(await acme());
    expect(response.status).toBe(201);
    const dto = (await response.json()) as Dto;
    let previous = await identityRevision(dto.id);
    const patches = [
      { nfcEnabled: true },
      { nfcEnabled: false },
      { apnsBinding: 'APNS_ACME' },
      { apnsBinding: null },
      { isDefault: true },
      { isDefault: false },
    ];
    for (const patch of patches) {
      const changed = await call('PATCH', `/${dto.id}`, patch);
      expect(changed.status).toBe(200);
      expect((await changed.json()) as Dto).toMatchObject(patch);
      const next = await identityRevision(dto.id);
      expect(next).toBeGreaterThan(previous);

      const repeated = await call('PATCH', `/${dto.id}`, patch);
      expect(repeated.status).toBe(200);
      expect(await identityRevision(dto.id)).toBe(next);
      previous = next;
    }
  });

  it('increments both identities when the default moves and uses a global sequence', async () => {
    const aResponse = await upload(await acme());
    expect(aResponse.status).toBe(201);
    const a = (await aResponse.json()) as Dto;
    const aInitial = await identityRevision(a.id);
    const bResponse = await upload(await acme());
    expect(bResponse.status).toBe(201);
    const b = (await bResponse.json()) as Dto;
    const bInitial = await identityRevision(b.id);
    expect(bInitial).toBeGreaterThan(aInitial);

    expect((await call('PATCH', `/${a.id}`, { isDefault: true })).status).toBe(200);
    const aDefault = await identityRevision(a.id);
    expect(aDefault).toBeGreaterThan(bInitial);
    expect((await call('PATCH', `/${b.id}`, { isDefault: true })).status).toBe(200);
    const aCleared = await identityRevision(a.id);
    const bDefault = await identityRevision(b.id);
    expect(aCleared).toBeGreaterThan(aDefault);
    expect(bDefault).toBeGreaterThan(aCleared);
  });

  it('advances for each persisted authority field and its restoration', async () => {
    const f = await acme();
    const response = await upload(f);
    expect(response.status).toBe(201);
    const dto = (await response.json()) as Dto;
    const otherResponse = await upload(await acme());
    expect(otherResponse.status).toBe(201);
    const other = (await otherResponse.json()) as Dto;
    const org = await makeOrg(fixtures(base));
    const row = await first<{
      org_id: string | null;
      pass_type_identifier: string;
      team_identifier: string;
      credential_id: string;
      cert_pem: string;
      cert_sha256: string;
      not_before: number;
      not_after: number;
      env_material_sha256: string | null;
    }>(
      env.DB,
      `SELECT org_id, pass_type_identifier, team_identifier, credential_id, cert_pem,
              cert_sha256, not_before, not_after, env_material_sha256
       FROM signing_identities WHERE id = ?`,
      [dto.id],
    );
    const otherRow = await first<{ credential_id: string }>(
      env.DB,
      'SELECT credential_id FROM signing_identities WHERE id = ?',
      [other.id],
    );
    if (!row || !otherRow) throw new Error('Missing identity fixture');

    let previous = await identityRevision(dto.id);
    const changes: Array<[string, string | number | null, string | number | null]> = [
      ['org_id', org.id, row.org_id],
      ['pass_type_identifier', `${row.pass_type_identifier}.changed`, row.pass_type_identifier],
      ['team_identifier', `${row.team_identifier}X`, row.team_identifier],
      ['credential_id', otherRow.credential_id, row.credential_id],
      ['cert_pem', `${row.cert_pem}\n`, row.cert_pem],
      ['cert_sha256', `${row.cert_sha256}00`, row.cert_sha256],
      ['not_before', row.not_before + 1, row.not_before],
      ['not_after', row.not_after + 1, row.not_after],
      ['env_material_sha256', 'changed-material', row.env_material_sha256],
    ];
    for (const [column, changed, original] of changes) {
      await run(env.DB, `UPDATE signing_identities SET ${column} = ? WHERE id = ?`, [
        changed,
        dto.id,
      ]);
      const next = await identityRevision(dto.id);
      expect(next, `${column} changed`).toBeGreaterThan(previous);
      await run(env.DB, `UPDATE signing_identities SET ${column} = ? WHERE id = ?`, [
        changed,
        dto.id,
      ]);
      expect(await identityRevision(dto.id), `${column} unchanged`).toBe(next);
      await run(env.DB, `UPDATE signing_identities SET ${column} = ? WHERE id = ?`, [
        original,
        dto.id,
      ]);
      previous = await identityRevision(dto.id);
      expect(previous, `${column} restored`).toBeGreaterThan(next);
    }

    // A DB identity can carry a prefix, allowing source and prefix to be tested independently.
    for (const [column, value] of [
      ['env_prefix', 'REVISION_TEST'],
      ['source', 'env'],
      ['source', 'db'],
      ['env_prefix', null],
    ] as const) {
      await run(env.DB, `UPDATE signing_identities SET ${column} = ? WHERE id = ?`, [
        value,
        dto.id,
      ]);
      const next = await identityRevision(dto.id);
      expect(next, `${column} changed`).toBeGreaterThan(previous);
      await run(env.DB, `UPDATE signing_identities SET ${column} = ? WHERE id = ?`, [
        value,
        dto.id,
      ]);
      expect(await identityRevision(dto.id), `${column} unchanged`).toBe(next);
      previous = next;
    }
    await run(env.DB, 'UPDATE signing_identities SET id = id WHERE id = ?', [dto.id]);
    expect(await identityRevision(dto.id)).toBe(previous);
    const movedId = `${dto.id}-changed`;
    await run(env.DB, 'UPDATE signing_identities SET id = ? WHERE id = ?', [movedId, dto.id]);
    const moved = await identityRevision(movedId);
    expect(moved).toBeGreaterThan(previous);
    await run(env.DB, 'UPDATE signing_identities SET id = ? WHERE id = ?', [dto.id, movedId]);
    expect(await identityRevision(dto.id)).toBeGreaterThan(moved);
  });

  it('advances only the linked identity for in-place credential material changes', async () => {
    const response = await upload(await acme());
    expect(response.status).toBe(201);
    const dto = (await response.json()) as Dto;
    const otherResponse = await upload(await acme());
    expect(otherResponse.status).toBe(201);
    const other = (await otherResponse.json()) as Dto;
    const org = await makeOrg(fixtures(base));
    const row = await first<{ credential_id: string }>(
      env.DB,
      'SELECT credential_id FROM signing_identities WHERE id = ?',
      [dto.id],
    );
    if (!row) throw new Error('Missing identity fixture');

    let previous = await identityRevision(dto.id);
    const otherRevision = await identityRevision(other.id);
    await run(env.DB, 'UPDATE credentials SET rotated_at = ? WHERE id = ?', [1, row.credential_id]);
    expect(await identityRevision(dto.id)).toBe(previous);
    const changes: Array<[string, string | number | Uint8Array]> = [
      ['org_id', org.id],
      ['kind', 'webhook'],
      ['kek_version', 2],
      ['iv', new Uint8Array([0])],
      ['wrapped_dek', new Uint8Array([0])],
      ['ciphertext', new Uint8Array([0])],
      ['fingerprint', 'changed-fingerprint'],
    ];
    for (const [column, value] of changes) {
      await run(env.DB, `UPDATE credentials SET ${column} = ? WHERE id = ?`, [
        value,
        row.credential_id,
      ]);
      const next = await identityRevision(dto.id);
      expect(next, `${column} changed`).toBeGreaterThan(previous);
      await run(env.DB, `UPDATE credentials SET ${column} = ? WHERE id = ?`, [
        value,
        row.credential_id,
      ]);
      expect(await identityRevision(dto.id), `${column} unchanged`).toBe(next);
      previous = next;
    }
    for (const value of [new Uint8Array([1]), new Uint8Array([0])]) {
      await run(env.DB, 'UPDATE credentials SET ciphertext = ? WHERE id = ?', [
        value,
        row.credential_id,
      ]);
      const next = await identityRevision(dto.id);
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
    expect(await identityRevision(other.id)).toBe(otherRevision);
  });

  it('does not reuse a revision when the same identity is deleted and recreated', async () => {
    const f = await acme();
    const response = await upload(f);
    expect(response.status).toBe(201);
    const dto = (await response.json()) as Dto;
    const row = await first<{
      credential_id: string;
      cert_pem: string;
      cert_sha256: string;
      not_before: number;
      not_after: number;
      created_at: number;
    }>(
      env.DB,
      `SELECT credential_id, cert_pem, cert_sha256, not_before, not_after, created_at
       FROM signing_identities WHERE id = ?`,
      [dto.id],
    );
    if (!row) throw new Error('Missing identity fixture');
    const before = await identityRevision(dto.id);

    // The API creates its own IDs and removes credentials; retain the credential to
    // recreate the same ID and authority through D1.
    await run(env.DB, 'DELETE FROM signing_identities WHERE id = ?', [dto.id]);
    expect(
      await first(env.DB, 'SELECT id FROM signing_identities WHERE id = ?', [dto.id]),
    ).toBeNull();
    await run(
      env.DB,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id,
          cert_pem, cert_sha256, not_before, not_after, nfc_enabled, is_default, created_at)
       VALUES (?, NULL, 'Acme', ?, ?, 'db', ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        dto.id,
        f.identity.passTypeIdentifier,
        f.identity.teamIdentifier,
        row.credential_id,
        row.cert_pem,
        row.cert_sha256,
        row.not_before,
        row.not_after,
        row.created_at,
      ],
    );
    const recreated = await identityRevision(dto.id);
    expect(recreated).toBeGreaterThan(before);

    expect((await call('DELETE', `/${dto.id}`)).status).toBe(200);
    const uploadedAgain = await upload(f);
    expect(uploadedAgain.status).toBe(201);
    const replacement = (await uploadedAgain.json()) as Dto;
    expect(replacement.id).not.toBe(dto.id);
    expect(await identityRevision(replacement.id)).toBeGreaterThan(recreated);
  });
});

describe('identity upload', () => {
  it('stores the key encrypted, keeps it out of responses and audit, and lists details', async () => {
    const f = await acme();
    const res = await upload(f, { nfcEnabled: true });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('PRIVATE KEY');
    const dto = JSON.parse(text) as Dto;
    expect(dto).toMatchObject({
      source: 'db',
      passTypeIdentifier: f.identity.passTypeIdentifier,
      teamIdentifier: 'ACME123456',
      nfcEnabled: true,
      isDefault: false,
      apnsBinding: null,
      apnsAvailable: false,
      apnsHealth: 'unknown',
      daysRemaining: 1,
    });
    expect(dto.certSubject).toContain(`UID=${f.identity.passTypeIdentifier}`);
    expect(dto.certSerial).toMatch(/^[0-9a-f]+$/);

    const row = await first<{
      ciphertext: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
      fingerprint: string;
    }>(
      env.DB,
      'SELECT c.ciphertext, c.wrapped_dek, c.fingerprint FROM credentials c JOIN signing_identities s ON s.credential_id = c.id WHERE s.id = ?',
      [dto.id],
    );
    const stored = new TextDecoder('latin1').decode(
      new Uint8Array(row?.ciphertext as unknown as ArrayBuffer),
    );
    const body = f.privateKey.replace(/-----[^-]+-----|\s/g, '');
    expect(stored).not.toContain(body.slice(0, 40));
    expect(row?.fingerprint).toBe(dto.certSha256);
    const cert = await first<{ cert_pem: string }>(
      env.DB,
      'SELECT cert_pem FROM signing_identities WHERE id = ?',
      [dto.id],
    );
    expect(cert?.cert_pem).toContain('BEGIN CERTIFICATE');

    const audit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE action = 'identity.upload' AND target_id = ?",
      [dto.id],
    );
    expect(audit?.detail).not.toContain('PRIVATE');
    expect(JSON.parse(audit?.detail ?? '{}').passTypeIdentifier).toBe(
      f.identity.passTypeIdentifier,
    );
  });

  it('rejects bad material with a specific code', async () => {
    const f = await acme();
    const other = await acme();
    const expectCode = async (res: Response, status: number, code: string) => {
      expect(res.status).toBe(status);
      expect(((await res.json()) as { code: string }).code).toBe(code);
    };
    appEnv = await envFor(f);
    await expectCode(
      await call('POST', '', { ...pem(f), privateKeyPem: other.privateKey }),
      422,
      'KEY_MISMATCH',
    );
    await expectCode(await call('POST', '', { ...pem(other) }), 422, 'CERT_CHAIN_INVALID');
    await expectCode(
      await call('POST', '', { ...pem(f), certificatePem: 'nope' }),
      422,
      'CERT_MISSING',
    );
    await expectCode(
      await call('POST', '', { label: 'x', certificatePem: f.certificate }),
      422,
      'IDENTITY_INPUT',
    );
    await expectCode(
      await call('POST', '', {
        ...pem(f),
        privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nAA==\n-----END RSA PRIVATE KEY-----',
      }),
      422,
      'KEY_FORMAT',
    );
    await expectCode(
      await call('POST', '', {
        ...pem(f),
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
      }),
      422,
      'KEY_INVALID',
    );
    await expectCode(
      await call('POST', '', { ...pem(f), pkcs12Base64: 'AAAA' }),
      422,
      'IDENTITY_INPUT',
    );
    await expectCode(await call('POST', '', { ...pem(f), orgId: 'missing' }), 404, 'ORG_NOT_FOUND');
    expect(
      await all(env.DB, 'SELECT 1 FROM signing_identities WHERE pass_type_identifier = ?', [
        f.identity.passTypeIdentifier,
      ]),
    ).toHaveLength(0);
  });

  it('rejects expired and not-yet-valid certificates', async () => {
    const expired = await acme({ now: new Date(Date.now() - 10 * 86_400_000) });
    appEnv = await envFor(expired);
    const res = await call('POST', '', pem(expired));
    expect(((await res.json()) as { code: string }).code).toBe('CERT_EXPIRED');
    const future = await acme({ now: new Date(Date.now() + 5 * 86_400_000) });
    appEnv = await envFor(future);
    expect(((await (await call('POST', '', pem(future))).json()) as { code: string }).code).toBe(
      'CERT_NOT_YET_VALID',
    );
  });

  it('points a legacy 3DES PKCS#12 at npm run credentials', async () => {
    const res = await call('POST', '', {
      label: 'x',
      pkcs12Base64: LEGACY_P12,
      pkcs12Password: P12_PASSWORD,
    });
    const body = (await res.json()) as { code: string; detail: string };
    expect(res.status).toBe(422);
    expect(body.code).toBe('P12_LEGACY');
    expect(body.detail).toContain('npm run credentials');
  });

  it('rejects a duplicate pass type id and a non-admin', async () => {
    const f = await acme();
    expect((await upload(f)).status).toBe(201);
    const dup = await call('POST', '', pem(f, 'again'));
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { code: string }).code).toBe('IDENTITY_EXISTS');
    expect((await call('POST', '', pem(f), fake.user())).status).toBe(403);
    expect((await call('GET', '', undefined, fake.user())).status).toBe(403);
  });
});

describe('db identity resolver', () => {
  it('decrypts the key and signs a pass with it', async () => {
    const f = await acme();
    const dto = (await (await upload(f)).json()) as Dto;
    const resolved = await createIdentityResolver(appEnv).byId(dto.id);
    expect(resolved).toMatchObject({ orgId: null, apnsBinding: null });
    const { bytes } = await buildManifestBytes();
    const signature = await signManifest(bytes, resolved.material, {
      expectedIdentity: {
        passTypeIdentifier: f.identity.passTypeIdentifier,
        teamIdentifier: f.identity.teamIdentifier,
      },
    });
    expect(signature.byteLength).toBeGreaterThan(500);
  });

  it('fails clearly when the credential cannot be decrypted', async () => {
    const f = await acme();
    const dto = (await (await upload(f)).json()) as Dto;
    await run(
      env.DB,
      'UPDATE credentials SET ciphertext = zeroblob(64) WHERE id = (SELECT credential_id FROM signing_identities WHERE id = ?)',
      [dto.id],
    );
    // Upload already checked the identity, which cached the readable key.
    clearIdentityKeyCache();
    await expect(createIdentityResolver(appEnv).byId(dto.id)).rejects.toMatchObject({
      code: 'IDENTITY_KEY_UNREADABLE',
    });
    const ctx = createServiceContext(appEnv);
    expect(await checkIdentityById(ctx, dto.id)).toMatchObject({
      ok: false,
      code: 'IDENTITY_KEY_UNREADABLE',
    });
  });

  it('scopes identities to their org', async () => {
    const f = await acme();
    const fx = fixtures(base);
    const a = await makeOrg(fx);
    const b = await makeOrg(fx);
    const dto = (await (await upload(f, { orgId: a.id })).json()) as Dto;
    const resolver = createIdentityResolver(appEnv);
    expect((await resolver.forOrg(a.id, dto.id)).id).toBe(dto.id);
    await expect(resolver.forOrg(b.id, dto.id)).rejects.toMatchObject({
      code: 'IDENTITY_NOT_FOUND',
    });
    // Storage lasts for the whole file; an earlier case may have left a global default.
    await run(env.DB, 'UPDATE signing_identities SET is_default = 0 WHERE is_default = 1');
    expect((await resolver.forOrg(b.id)).id).toBe('platform');

    await run(env.DB, 'UPDATE orgs SET default_identity_id = ? WHERE id = ?', [dto.id, a.id]);
    expect((await resolver.forOrg(a.id)).id).toBe(dto.id);
    await run(env.DB, 'UPDATE orgs SET default_identity_id = ? WHERE id = ?', [dto.id, b.id]);
    await expect(resolver.forOrg(b.id)).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('reports the apns binding only when the deployment has it', async () => {
    const f = await acme();
    const dto = (await (await upload(f)).json()) as Dto;
    expect((await call('PATCH', `/${dto.id}`, { apnsBinding: 'lower' })).status).toBe(422);
    for (const apnsBinding of ['DB', 'ASSETS', 'KEK_V1', 'APNS'])
      expect((await call('PATCH', `/${dto.id}`, { apnsBinding })).status).toBe(422);
    const set = (await (
      await call('PATCH', `/${dto.id}`, { apnsBinding: 'APNS_ACME' })
    ).json()) as Dto;
    expect(set).toMatchObject({ apnsBinding: 'APNS_ACME', apnsAvailable: false });
    expect((await createIdentityResolver(appEnv).byId(dto.id)).apnsBinding).toBeNull();
    appEnv = { ...appEnv, APNS_ACME: {} as Fetcher } as AppEnv;
    expect((await createIdentityResolver(appEnv).byId(dto.id)).apnsBinding).toBeNull();
    appEnv = { ...appEnv, APNS_ACME: { fetch: async () => new Response() } } as unknown as AppEnv;
    expect((await createIdentityResolver(appEnv).byId(dto.id)).apnsBinding).toBe('APNS_ACME');
    expect(((await (await call('GET', `/${dto.id}`)).json()) as Dto).apnsAvailable).toBe(true);
  });
});

const buildManifestBytes = () => buildManifest({ 'pass.json': new TextEncoder().encode('{}') });

describe('identity update and delete', () => {
  it('updates label, nfc and the single default; protects the platform identity', async () => {
    const f = await acme();
    const g = await acme();
    const a = (await (await upload(f)).json()) as Dto;
    const b = (await (await upload(g)).json()) as Dto;
    await call('PATCH', `/${a.id}`, { isDefault: true, label: 'Renamed', nfcEnabled: true });
    await call('PATCH', `/${b.id}`, { isDefault: true });
    const list = (await (await call('GET', '?limit=200')).json()) as { items: Dto[] };
    expect(list.items.filter((i) => i.isDefault).map((i) => i.id)).toEqual([b.id]);
    expect(list.items.find((i) => i.id === a.id)).toMatchObject({
      label: 'Renamed',
      nfcEnabled: true,
    });

    const resolver = createIdentityResolver(appEnv);
    expect((await resolver.forOrg('any-org')).id).toBe(b.id);

    await ensurePlatformIdentity(base, 1);
    expect((await call('DELETE', '/platform')).status).toBe(409);
    expect((await call('PATCH', '/platform', { apnsBinding: 'APNS' })).status).toBe(422);
    expect((await call('PATCH', '/missing', { label: 'x' })).status).toBe(404);
  });

  it('deletes the identity and its credential unless passes use it', async () => {
    const f = await acme();
    const dto = (await (await upload(f)).json()) as Dto;
    const cred = await first<{ credential_id: string }>(
      env.DB,
      'SELECT credential_id FROM signing_identities WHERE id = ?',
      [dto.id],
    );
    expect((await call('DELETE', `/${dto.id}`)).status).toBe(200);
    expect(
      await first(env.DB, 'SELECT 1 FROM credentials WHERE id = ?', [cred?.credential_id]),
    ).toBeNull();
    expect((await call('GET', `/${dto.id}`)).status).toBe(404);
    expect((await call('DELETE', `/${dto.id}`)).status).toBe(404);
  });
});

describe('identity list', () => {
  it('pages oldest first by cursor', async () => {
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push(((await (await upload(await acme())).json()) as Dto).id);
    type Page = { items: Dto[]; nextCursor: string | null };
    const whole = (await (await call('GET', '?limit=200')).json()) as Page;
    expect(whole.nextCursor).toBeNull();
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await call('GET', `?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
      ).json()) as Page;
      expect(page.items.length).toBeLessThanOrEqual(2);
      paged.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(whole.items.map((i) => i.id));
    expect(paged.slice(-3)).toEqual(made);
  });
});

describe('identity checks', () => {
  it('daily run audits identities inside the 30 day window and records check results', async () => {
    const f = await acme();
    const dto = (await (await upload(f)).json()) as Dto;
    const ctx = createServiceContext(appEnv, { clock: new ManualClock(Date.now()) });
    await run(env.DB, "DELETE FROM audit_log WHERE action LIKE 'identity.exp%'");
    await runDailyIdentityChecks(ctx);
    const rows = await all<{ action: string; target_id: string }>(
      env.DB,
      "SELECT action, target_id FROM audit_log WHERE action LIKE 'identity.exp%'",
    );
    expect(rows.map((r) => r.target_id)).toContain(dto.id);
    const check = await first<{ value: string }>(
      env.DB,
      "SELECT value FROM settings WHERE scope = 'system' AND key = ?",
      [`identity_check.${dto.id}`],
    );
    expect(JSON.parse(check?.value ?? '{}')).toMatchObject({ ok: true });
  });
});
