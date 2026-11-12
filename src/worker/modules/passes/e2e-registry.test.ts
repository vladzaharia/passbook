import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFakeApns,
  createFakeMailer,
  fixtures,
  makeEnv,
  makeOrg,
} from '../../../../test/helpers/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { basicPackage, zipOf } from '../templates/package/fixtures.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { generatedSource, resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, importZip, sourceOf } from '../templates/testing.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { putPassAsset } from './asset-service.ts';
import { createPassRow } from './create.ts';
import { overrideDeps } from './deps.ts';
import { expectValidZip, ICON_PNG } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { updatePass } from './service.ts';

/** No fake registry: templates come from D1/R2 (uploaded) and the ASSETS binding (baked). */
let env: AppEnv;
let clock: ManualClock;
let ctx: ServiceContext;
let orgId: string;
const assets = fakeAssets();
const actor = { type: 'system', id: null } as const;
const previousSource = { ...generatedSource };

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  const baked = await bakedFrom('starter-e2e', basicPackage(), { name: 'Starter E2E' });
  for (const [path, bytes] of baked.files) assets.files.set(path, bytes);
  Object.assign(generatedSource, sourceOf([baked], 'e2e-registry'));
  resetBakedSync();
  env = await makeEnv({
    ASSETS: assets,
    CF_VERSION: { id: 'registry-base', tag: '', timestamp: new Date(clock.now()).toISOString() },
  });
  ctx = createServiceContext(env, { clock });
  overrideDeps(env, { apns: createFakeApns(), mailer: createFakeMailer() });
  await ensurePlatformIdentity(env, clock.now());
  orgId = (await makeOrg(fixtures(env, clock), { name: 'E2E Gym' })).id;
}, 60_000);
afterAll(() => {
  Object.assign(generatedSource, previousSource);
  resetBakedSync();
});

async function checkStored(passId: string) {
  const pass = await getPass(env.DB, passId);
  const object = await env.BUCKET.get(pass?.objectKey ?? '');
  const bytes = new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0));
  const names = expectValidZip(bytes);
  const files = unzipSync(bytes);
  expect(names).toEqual(expect.arrayContaining(['pass.json', 'manifest.json', 'signature']));
  // Signed packages carry @2x and @3x; @1x only when nothing larger exists.
  expect(names.some((n) => /^icon(@[23]x)?\.png$/.test(n))).toBe(true);
  if (names.includes('icon@2x.png')) expect(names).not.toContain('icon.png');
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Record<
    string,
    string
  >;
  for (const [name, hash] of Object.entries(manifest))
    expect(hash, name).toBe(await sha1Hex(files[name] as Uint8Array));
  return pass;
}

describe('registry to pkpass', () => {
  it('builds a pass from an uploaded template stored in D1 and R2', async () => {
    const imported = await importZip(env, clock, {
      orgId,
      zip: zipOf(basicPackage()),
      name: 'Uploaded E2E',
    });
    if (!imported.result) throw new Error('Template import failed');
    const release = await approveAppleRelease(
      { ctx, fx: fixtures(env, clock) },
      {
        orgId,
        templateId: imported.result.templateId,
        version: imported.result.version,
      },
    );
    const pass = await createPassRow(jobCtxOf({ ctx }), {
      orgId,
      templateId: imported.result.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: {},
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor,
    });
    expect(pass.releaseId).toBe(release.id);
    await checkStored(pass.id);
    await putPassAsset(jobCtxOf({ ctx }), actor, pass.id, 'icon.png', ICON_PNG, null);
    const republished = await checkStored(pass.id);
    expect(republished?.version).toBe(2);
  }, 60_000);

  it('drops expirationDate from the signed pass.json once the input is cleared', async () => {
    const manifest = {
      schema: 1,
      name: 'Expiry E2E',
      inputs: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', 'x-label': 'Name' },
          expirationDate: {
            type: 'string',
            format: 'date-time',
            'x-label': 'Expires',
            'x-noneLabel': 'Never expires',
          },
        },
      },
      sample: { name: 'Alex' },
      bindings: [
        { to: { field: 'name' }, value: '{{name}}' },
        { to: { pointer: '/expirationDate' }, value: '{{expirationDate}}', omitIfEmpty: true },
      ],
      display: { title: '{{name}}' },
    };
    const imported = await importZip(env, clock, {
      orgId,
      zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest) })),
      name: 'Expiry E2E',
    });
    if (!imported.result) throw new Error('Template import failed');
    const release = await approveAppleRelease(
      { ctx, fx: fixtures(env, clock) },
      {
        orgId,
        templateId: imported.result.templateId,
        version: imported.result.version,
      },
    );
    const pass = await createPassRow(jobCtxOf({ ctx }), {
      orgId,
      templateId: imported.result.templateId,
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: { name: 'Alex', expirationDate: '2030-01-01T00:00:00Z' },
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor,
    });
    expect(pass.releaseId).toBe(release.id);
    const passJsonOf = async (id: string) => {
      const row = await getPass(env.DB, id);
      const object = await env.BUCKET.get(row?.objectKey ?? '');
      const files = unzipSync(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0)));
      return JSON.parse(new TextDecoder().decode(files['pass.json'])) as Record<string, unknown>;
    };
    expect((await passJsonOf(pass.id)).expirationDate).toBe('2030-01-01T00:00:00Z');

    await updatePass(
      jobCtxOf({ ctx }),
      actor,
      pass.id,
      { input: { expirationDate: null } },
      { scope: null },
    );
    const after = await passJsonOf(pass.id);
    expect(after).not.toHaveProperty('expirationDate');
    expect(after.description).toBeDefined();
  }, 60_000);

  it('builds a pass from a baked template served by the ASSETS binding', async () => {
    await syncBakedTemplates(ctx);
    overrideDeps(env, { registry: createTemplateRegistry(env, { ctx }) });
    const release = await requireApprovedRelease(ctx, 'baked:starter-e2e', orgId, 'live', 'apple');
    const pass = await createPassRow(jobCtxOf({ ctx }), {
      orgId,
      templateId: 'baked:starter-e2e',
      templateVersion: release.version,
      releaseId: release.id,
      releaseGeneration: release.generation,
      input: {},
      source: 'manual',
      mode: 'live',
      execution: { kind: 'system' },
      actor,
    });
    expect(pass.releaseId).toBe(release.id);
    await checkStored(pass.id);
  }, 60_000);
});
