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
import { handleIdentityCheck } from './jobs.ts';
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

beforeAll(async () => {
  base = await makeEnv();
  app = createApp({ stores: fake.stores });
});
beforeEach(() => clearIdentityKeyCache());

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
    const set = (await (
      await call('PATCH', `/${dto.id}`, { apnsBinding: 'APNS_ACME' })
    ).json()) as Dto;
    expect(set).toMatchObject({ apnsBinding: 'APNS_ACME', apnsAvailable: false });
    expect((await createIdentityResolver(appEnv).byId(dto.id)).apnsBinding).toBeNull();
    appEnv = { ...appEnv, APNS_ACME: {} as Fetcher } as AppEnv;
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
    const list = (await (await call('GET', '')).json()) as { items: Dto[] };
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

  it('ignores unknown ids in the job', async () => {
    const ctx = createServiceContext(appEnv);
    await expect(
      handleIdentityCheck({ kind: 'identity.check', identityId: 'gone' }, ctx),
    ).resolves.toBeUndefined();
  });
});
