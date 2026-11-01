import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
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
import { ensurePlatformIdentity } from '../identities/repo.ts';
import { basicPackage, zipOf } from '../templates/package/fixtures.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, importZip, sourceOf } from '../templates/testing.ts';
import { putPassAsset } from './asset-service.ts';
import { createPassRow } from './create.ts';
import { overrideDeps } from './deps.ts';
import { getPass } from './repo.ts';
import { updatePass } from './service.ts';
import { expectValidZip, ICON_PNG } from './test-kit.ts';

/** No fake registry: templates come from D1/R2 (uploaded) and the ASSETS binding (baked). */
let env: AppEnv;
let clock: ManualClock;
let ctx: ServiceContext;
let orgId: string;
const assets = fakeAssets();
const actor = { type: 'system', id: null } as const;

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  env = await makeEnv({ ASSETS: assets });
  ctx = createServiceContext(env, { clock });
  overrideDeps(env, { apns: createFakeApns(), mailer: createFakeMailer() });
  await ensurePlatformIdentity(env, clock.now());
  orgId = (await makeOrg(fixtures(env, clock), { name: 'E2E Gym' })).id;
});

async function checkStored(passId: string) {
  const pass = await getPass(env.DB, passId);
  const object = await env.BUCKET.get(pass?.objectKey ?? '');
  const bytes = new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0));
  const names = expectValidZip(bytes);
  const files = unzipSync(bytes);
  expect(names).toEqual(
    expect.arrayContaining(['pass.json', 'manifest.json', 'signature', 'icon.png']),
  );
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
    const pass = await createPassRow(ctx, {
      orgId,
      templateId: imported.result?.templateId ?? '',
      input: {},
      source: 'manual',
      actor,
    });
    await checkStored(pass.id);
    await putPassAsset(ctx, actor, pass.id, 'icon.png', ICON_PNG, null);
    const republished = await checkStored(pass.id);
    expect(republished?.version).toBe(2);
  });

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
    const pass = await createPassRow(ctx, {
      orgId,
      templateId: imported.result?.templateId ?? '',
      input: { name: 'Alex', expirationDate: '2030-01-01T00:00:00Z' },
      source: 'manual',
      actor,
    });
    const passJsonOf = async (id: string) => {
      const row = await getPass(env.DB, id);
      const object = await env.BUCKET.get(row?.objectKey ?? '');
      const files = unzipSync(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0)));
      return JSON.parse(new TextDecoder().decode(files['pass.json'])) as Record<string, unknown>;
    };
    expect((await passJsonOf(pass.id)).expirationDate).toBe('2030-01-01T00:00:00Z');

    await updatePass(ctx, actor, pass.id, { input: { expirationDate: null } }, { scope: null });
    const after = await passJsonOf(pass.id);
    expect(after).not.toHaveProperty('expirationDate');
    expect(after.description).toBeDefined();
  });

  it('builds a pass from a baked template served by the ASSETS binding', async () => {
    const baked = await bakedFrom('starter-e2e', basicPackage(), { name: 'Starter E2E' });
    for (const [path, bytes] of baked.files) assets.files.set(path, bytes);
    const source = sourceOf([baked], 'e2e');
    await syncBakedTemplates(ctx, source);
    overrideDeps(env, { registry: createTemplateRegistry(env, { source, ctx }) });
    const pass = await createPassRow(ctx, {
      orgId,
      templateId: 'baked:starter-e2e',
      input: {},
      source: 'manual',
      actor,
    });
    await checkStored(pass.id);
  });
});
