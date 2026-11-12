import * as asn1 from 'asn1js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, persistTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { devicePrincipal } from './repo-credential.ts';

const ORIGIN = 'https://wallet.test';
const TYPE = 'pass.im.plrs.wallet';
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  // Publishing revalidates the keyset, and only an empty reference store may initialize it.
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  app = createApp({ stores: fakeAuth(ORIGIN).stores });
});

const call = (path: string, init: RequestInit = {}, env: AppEnv = kit.env) =>
  app.request(`${ORIGIN}/wallet/v1${path}`, init, env);
const token = (c: string) => c.repeat(64);
const authHeader = (pass: Pass) => ({ authorization: `ApplePass ${pass.authToken}` });

describe('personalize', () => {
  const body = (extra: object = {}) =>
    JSON.stringify({
      personalizationToken: 'tok-123',
      requiredPersonalizationInfo: {
        fullName: 'Sam Lee',
        emailAddress: 'sam.lee@example.com',
        ...extra,
      },
      ...{},
    });
  const post = (pass: Pass, payload = body(), headers: Record<string, string> = {}) =>
    call(`/passes/${TYPE}/${pass.serial}/personalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: payload,
    });

  async function personalizable(mode: 'live' | 'test' = 'live'): Promise<Pass> {
    const icon = new Uint8Array(
      await new Response(await kit.registry.openAsset(kit.template, 'icon.png')).arrayBuffer(),
    );
    const template = kit.registry.add({
      id: `personalizable-${kit.ctx.ids.token(8)}`,
      orgId: kit.template.orgId,
      version: kit.template.version,
      manifest: kit.template.manifest,
      passJson: kit.template.passJson,
      assets: {
        'icon.png': icon,
        'personalizationLogo.png': icon,
        'personalization.json': new TextEncoder().encode(
          JSON.stringify({
            description: 'Join',
            requiredPersonalizationFields: [
              'PKPassPersonalizationFieldName',
              'PKPassPersonalizationFieldEmailAddress',
            ],
          }),
        ),
      },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    const release = await approveAppleRelease(kit, {
      templateId: template.id,
      version: template.version,
      mode,
    });
    // The build refuses personalization.json unless the signing identity is NFC-entitled.
    await run(kit.env.DB, 'UPDATE signing_identities SET nfc_enabled = 1 WHERE 1 = 1');
    const pass = await createPassRow(jobCtxOf(kit), {
      orgId: kit.org.id,
      templateId: template.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Alex Morgan' },
      holderEmail: null,
      source: 'manual',
      mode,
      execution: { kind: 'system' },
      actor: { type: 'system', id: null },
    });
    await run(kit.env.DB, 'UPDATE signing_identities SET nfc_enabled = 1 WHERE id = ?', [
      pass.identityId,
    ]);
    return pass;
  }

  afterEach(() => run(kit.env.DB, 'UPDATE signing_identities SET nfc_enabled = 0 WHERE 1 = 1'));

  it('is 404 without NFC or a personalizing template, and needs no ApplePass header', async () => {
    const pass = await kit.pass();
    expect((await post(pass)).status).toBe(404);
    await run(kit.env.DB, 'UPDATE signing_identities SET nfc_enabled = 1 WHERE id = ?', [
      pass.identityId,
    ]);
    expect((await post(pass)).status).toBe(404);
    const unknown = await call(`/passes/${TYPE}/nope/personalize`, {
      method: 'POST',
      body: body(),
    });
    expect(unknown.status).toBe(404);
  });

  it('does not personalize a quarantined test pass', async () => {
    const blocked = await personalizable('test');
    const normal = await personalizable();
    await run(kit.env.DB, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [blocked.id]);
    const denied = await post(blocked);
    const unknown = await call(`/passes/${TYPE}/nope/personalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body(),
    });
    expect(denied.status).toBe(404);
    // Only the per-request id may differ between the two problem documents.
    const withoutRequestId = async (response: Response) => ({
      ...(await response.json<Record<string, unknown>>()),
      requestId: undefined,
    });
    expect(await withoutRequestId(denied)).toEqual(await withoutRequestId(unknown));
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_personalizations WHERE pass_id = ?', [
        blocked.id,
      ]),
    ).toBeNull();
    expect((await post(normal)).status).toBe(200);
  });

  it('stores the info encrypted, republishes the pass and returns a CMS signature of the token', async () => {
    const pass = await personalizable();
    const res = await post(pass);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const signature = new Uint8Array(await res.arrayBuffer());
    expect(signature[0]).toBe(0x30);
    expect(asn1.fromBER(signature.buffer).offset).not.toBe(-1);

    const row = await first<{ ciphertext: ArrayBuffer; published_at: number | null }>(
      kit.env.DB,
      'SELECT ciphertext, published_at FROM pass_personalizations WHERE pass_id = ?',
      [pass.id],
    );
    expect(row?.published_at).not.toBeNull();
    expect(
      new TextDecoder('latin1').decode(Uint8Array.from(row?.ciphertext as unknown as number[])),
    ).not.toContain('sam.lee');
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.version).toBe(pass.version + 1);
    expect(after?.templateVersion).toBe(pass.templateVersion);
    expect(after?.releaseId).toBe(pass.releaseId);
    const object = await kit.env.BUCKET.get(after?.objectKey ?? '');
    const bytes = new TextDecoder('latin1').decode(await object?.arrayBuffer());
    expect(bytes).not.toContain('personalization.json');
    // Later publishes (admin edit, upgrade, reissue) must keep personalization.json out.
    await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      force: true,
    });
    const later = await getPass(kit.env.DB, pass.id);
    expect(later?.version).toBe(pass.version + 2);
    const laterObject = await kit.env.BUCKET.get(later?.objectKey ?? '');
    expect(new TextDecoder('latin1').decode(await laterObject?.arrayBuffer())).not.toContain(
      'personalization.json',
    );
    const audit = await all<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'pass.personalized' AND target_id = ?",
      [pass.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).not.toContain('sam.lee');
  });

  it('republishes under the device grant: a request context needs no job grant, a wrong credential is refused', async () => {
    const pass = await personalizable();
    const republish = (authToken: string) =>
      publishPass(kit.ctx, {
        passId: pass.id,
        cause: 'user_refresh',
        actor: { type: 'system', id: null },
        holder: devicePrincipal({ ...pass, authToken }),
        force: true,
      });
    await expect(republish('0'.repeat(64))).rejects.toMatchObject({ status: 409 });
    expect((await getPass(kit.env.DB, pass.id))?.version).toBe(pass.version);
    await expect(republish(pass.authToken)).resolves.toMatchObject({ changed: true });
    expect((await getPass(kit.env.DB, pass.id))?.version).toBe(pass.version + 1);
    await expect(
      publishPass(kit.ctx, {
        passId: pass.id,
        cause: 'user_refresh',
        actor: { type: 'system', id: null },
        force: true,
      }),
    ).rejects.toMatchObject({ code: 'GRANT_NOT_JOB' });
  });

  it('answers a retry with the same token without republishing, and refuses another token', async () => {
    const pass = await personalizable();
    expect((await post(pass)).status).toBe(200);
    const version = (await getPass(kit.env.DB, pass.id))?.version;
    expect((await post(pass)).status).toBe(200);
    expect((await getPass(kit.env.DB, pass.id))?.version).toBe(version);
    const other = await post(
      pass,
      JSON.stringify({
        personalizationToken: 'other',
        requiredPersonalizationInfo: { fullName: 'X', emailAddress: 'x@example.com' },
      }),
    );
    expect(other.status).toBe(409);
  });

  it('rejects missing required fields and malformed bodies', async () => {
    const pass = await personalizable();
    const missing = await post(
      pass,
      JSON.stringify({
        personalizationToken: 't',
        requiredPersonalizationInfo: { fullName: 'Only Name' },
      }),
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { code: string }).code).toBe('PERSONALIZATION_INCOMPLETE');
    expect((await post(pass, '{}')).status).toBe(400);
    expect((await post(pass, 'nope')).status).toBe(400);
    const stored = await first(
      kit.env.DB,
      'SELECT 1 FROM pass_personalizations WHERE pass_id = ?',
      [pass.id],
    );
    expect(stored).toBeNull();
  });

  const withToken = (tok: string) =>
    JSON.stringify({
      personalizationToken: tok,
      requiredPersonalizationInfo: { fullName: 'Sam Lee', emailAddress: 'sam.lee@example.com' },
    });
  const hex40 = 'a'.repeat(40);

  it('refuses tokens shaped like JSON, before any signing', async () => {
    const pass = await personalizable();
    const oracle = JSON.stringify({ 'pass.json': hex40, 'icon.png': hex40 });
    for (const tok of [oracle, 'has space', 'q"uote', '[1]', 'a\\b', 'a\u0085b', 'a\nb']) {
      const res = await post(pass, withToken(tok));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PERSONALIZATION_INVALID');
    }
    const stored = await first(
      kit.env.DB,
      'SELECT 1 FROM pass_personalizations WHERE pass_id = ?',
      [pass.id],
    );
    expect(stored).toBeNull();
  });

  it('is unavailable for deleted and voided passes', async () => {
    const pass = await personalizable();
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [pass.id]);
    const gone = await post(pass);
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe('PERSONALIZATION_UNAVAILABLE');
    await run(kit.env.DB, "UPDATE passes SET deleted_at = NULL, status = 'voided' WHERE id = ?", [
      pass.id,
    ]);
    const voided = await post(pass);
    expect(voided.status).toBe(404);
    expect(((await voided.json()) as { code: string }).code).toBe('PERSONALIZATION_UNAVAILABLE');
    await run(kit.env.DB, "UPDATE passes SET status = 'active' WHERE id = ?", [pass.id]);
  });

  it('signs an opaque base64url token over exactly those bytes', async () => {
    const pass = await personalizable();
    const tok = 'Zm9vYmFyLXRva2VuXzEyMw';
    const res = await post(pass, withToken(tok));
    expect(res.status).toBe(200);
    const sig = new Uint8Array(await res.arrayBuffer());
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tok)),
    );
    const hay = Array.from(sig).join(',');
    expect(hay).toContain(Array.from(digest).join(','));
    const other = await post(pass, withToken('different'));
    expect(other.status).toBe(409);
  });

  it('is unavailable for a suspended org', async () => {
    const pass = await personalizable();
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [pass.orgId]);
    expect((await post(pass)).status).toBe(404);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [pass.orgId]);
  });
});

describe('suspended orgs', () => {
  it('stop the web service: registration, serials and the pass itself', async () => {
    const pass = await kit.pass();
    const register = () =>
      call(`/devices/sus-1/registrations/${TYPE}/${pass.serial}`, {
        method: 'POST',
        headers: { ...authHeader(pass), 'content-type': 'application/json' },
        body: JSON.stringify({ pushToken: token('a') }),
      });
    expect((await register()).status).toBe(201);
    const serials = () => call(`/devices/sus-1/registrations/${TYPE}`);
    const latest = () => call(`/passes/${TYPE}/${pass.serial}`, { headers: authHeader(pass) });
    expect((await serials()).status).toBe(200);
    const ok = await latest();
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();

    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [pass.orgId]);
    expect((await register()).status).toBe(401);
    expect((await serials()).status).toBe(204);
    expect((await latest()).status).toBe(401);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [pass.orgId]);
    expect((await serials()).status).toBe(200);
  });
});

describe('push tokens', () => {
  it('accepts any even-length hex token of plausible size', async () => {
    const pass = await kit.pass();
    for (const [i, len] of [32, 100, 200].entries()) {
      const res = await call(`/devices/len-${i}/registrations/${TYPE}/${pass.serial}`, {
        method: 'POST',
        headers: { ...authHeader(pass), 'content-type': 'application/json' },
        body: JSON.stringify({ pushToken: 'ab'.repeat(len / 2) }),
      });
      expect(res.status).toBe(201);
    }
  });
});

describe('device logs per IP', () => {
  it('limits one IP without blocking others', async () => {
    await run(kit.env.DB, "DELETE FROM counters WHERE key LIKE 'apple.log%'");
    const post = (ip: string) =>
      call('/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ logs: Array.from({ length: 100 }, (_, i) => `l${i}`) }),
      });
    for (let i = 0; i < 3; i++) expect((await post('1.1.1.1')).status).toBe(200);
    const over = await post('1.1.1.1');
    expect(over.status).toBe(429);
    expect(((await over.json()) as { code: string }).code).toBe('LOG_BUDGET');
    expect((await post('2.2.2.2')).status).toBe(200);
  });
});

describe('RL_APPLE_IP', () => {
  it('answers 429 once the per-IP limit is spent, keyed by IP', async () => {
    const limiter = fakeLimiter(1);
    const env = { ...kit.env, RL_APPLE_IP: limiter } as unknown as AppEnv;
    const get = (ip: string) =>
      call(`/devices/rl/registrations/${TYPE}`, { headers: { 'cf-connecting-ip': ip } }, env);
    expect((await get('1.1.1.1')).status).toBe(204);
    const limited = await get('1.1.1.1');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect((await get('2.2.2.2')).status).toBe(204);
    expect([...limiter.calls.keys()]).toEqual(['RL_APPLE_IP:1.1.1.1', 'RL_APPLE_IP:2.2.2.2']);
  });
});
