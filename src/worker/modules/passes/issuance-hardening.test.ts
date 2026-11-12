import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { createPassIdempotent, createPassRow } from './create.ts';
import { servePassFile } from './file.ts';
import { setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

const actor = { type: 'system', id: null } as const;

describe('serial of a personalizable pass (P1-5)', () => {
  it('ignores a caller-chosen serial when the template personalizes', async () => {
    const kit = await setupKit();
    const live = kit.liveRelease;
    if (!live) throw new Error('Missing approved release');
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
            requiredPersonalizationFields: ['PKPassPersonalizationFieldName'],
          }),
        ),
      },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    const release = await approveAppleRelease(kit, {
      templateId: template.id,
      version: template.version,
    });
    // The build refuses personalization.json unless the signing identity is NFC-entitled.
    await run(kit.env.DB, 'UPDATE signing_identities SET nfc_enabled = 1 WHERE 1 = 1');
    const create = (templateId: string, version: string, releaseId: string, generation: number) =>
      createPassRow(jobCtxOf(kit), {
        orgId: kit.org.id,
        templateId,
        templateVersion: version,
        releaseId,
        releaseGeneration: generation,
        input: { memberName: 'Alex Morgan' },
        serial: 'chosen-by-caller',
        source: 'manual',
        mode: 'live',
        execution: { kind: 'system' },
        actor,
      });
    const personalized = await create(template.id, release.version, release.id, release.generation);
    expect(personalized.serial).not.toBe('chosen-by-caller');
    // A template without personalization keeps the caller's serial.
    const plain = await create(kit.template.id, live.version, live.id, live.generation);
    expect(plain.serial).toBe('chosen-by-caller');
  }, 120_000);
});

describe('pass file HEAD', () => {
  it('cancels the object body instead of leaking the R2 stream', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const object = await kit.env.BUCKET.get(pass.objectKey);
    if (!object) throw new Error('Missing pass object');
    let cancelled = false;
    const body = object.body;
    const original = body.cancel.bind(body);
    body.cancel = async (reason?: unknown) => {
      cancelled = true;
      return original(reason);
    };
    const bucket = {
      get: async () => ({ size: object.size, body }),
    } as unknown as R2Bucket;
    const response = await servePassFile(
      bucket,
      pass,
      new Request('https://wallet.test/p', { method: 'HEAD' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(object.size));
    expect(cancelled).toBe(true);
  });
});

describe('idempotent create with a server-resolved release', () => {
  it('replays the pass after a release approval changed the head the server picked', async () => {
    const kit = await setupKit();
    const live = kit.liveRelease;
    if (!live) throw new Error('Missing approved release');
    const params = (release: { version: string; id: string; generation: number }) => ({
      orgId: kit.org.id,
      templateId: kit.template.id,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { memberName: 'Retry' },
      externalId: 'retry-after-approval',
      source: 'manual' as const,
      mode: 'live' as const,
      execution: { kind: 'system' as const },
      actor,
    });
    const first_ = await createPassIdempotent(jobCtxOf(kit), params(live), 'retry-key', {
      serverResolvedRelease: true,
    });
    const newer = await approveAppleRelease(kit);
    const retry = await createPassIdempotent(jobCtxOf(kit), params(newer), 'retry-key', {
      serverResolvedRelease: true,
    });
    expect(retry.id).toBe(first_.id);
    expect(
      await first<{ n: number }>(
        kit.env.DB,
        "SELECT count(*) AS n FROM passes WHERE external_id = 'retry-after-approval'",
      ),
    ).toEqual({ n: 1 });
    expect((await getPass(kit.env.DB, first_.id))?.releaseId).toBe(live.id);
    // A caller that pinned its release is held to it: the same key with another pin is a different request.
    await expect(
      createPassIdempotent(jobCtxOf(kit), params(newer), 'pinned-key'),
    ).resolves.toBeDefined();
    await expect(
      createPassIdempotent(jobCtxOf(kit), params(live), 'pinned-key'),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  }, 120_000);
});
