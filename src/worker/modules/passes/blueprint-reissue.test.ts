import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PassJson } from '../../../passkit/types.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { basicPackage, passJson } from '../templates/package/fixtures.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, sourceOf } from '../templates/testing.ts';
import type { ReissueParams } from './bulk-reissue-page.ts';
import { createPassRow } from './create.ts';
import { overrideDeps } from './deps.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { reissueStaleTemplates, STALE_QUIET_MS } from './stale-reissue.ts';

let kit: Kit;
const assets = fakeAssets();
let build = 0;

beforeAll(async () => {
  kit = await setupKit({ approvedReleases: false });
  kit.env.ASSETS = assets;
});

const step = {
  do: async (_name: string, a: unknown, b?: unknown) =>
    ((typeof a === 'function' ? a : b) as () => Promise<unknown>)(),
} as unknown as Parameters<typeof runBulkReissue>[3];

/** The starter before blueprints, and as a blueprint with its new identity. */
const manifest = (blueprint: boolean) =>
  JSON.stringify({
    schema: 1,
    name: blueprint ? 'Balance card' : 'PassBook · Store card',
    ...(blueprint ? { blueprint: true } : {}),
    inputs: { type: 'object', properties: { name: { type: 'string' } } },
    sample: { name: 'Alex' },
    bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
    display: { title: '{{name}}', ...(blueprint ? { icon: 'coins' } : {}) },
  });
const pack = (blueprint: boolean) =>
  basicPackage(
    { 'wallet.template.json': manifest(blueprint) },
    passJson({
      description: blueprint ? 'Balance card' : 'Store card',
      backgroundColor: blueprint ? 'rgb(0,75,65)' : 'rgb(20,20,20)',
      foregroundColor: 'rgb(255,255,255)',
      labelColor: blueprint ? 'rgb(242,208,125)' : 'rgb(200,200,200)',
      generic: {
        primaryFields: [{ key: 'name', label: 'Name', value: '', changeMessage: 'Now %@' }],
      },
    }),
  );

async function sync(fixture: Awaited<ReturnType<typeof bakedFrom>>) {
  for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
  build += 1;
  const source = sourceOf([fixture], `blueprint-reissue-${build}`);
  resetBakedSync();
  const worker = {
    ...kit.env,
    CF_VERSION: {
      id: `blueprint-reissue-${build}`,
      tag: '',
      timestamp: new Date(Date.UTC(2040, 0, 1) + build * 1000).toISOString(),
    },
  };
  await syncBakedTemplates(createServiceContext(worker, { clock: kit.clock }), source);
  overrideDeps(kit.env, { registry: createTemplateRegistry(kit.env, { source, ctx: kit.ctx }) });
}

const issue = async (id: string) => {
  const release = await requireApprovedRelease(kit.ctx, id, kit.org.id, 'live', 'apple');
  return createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: id,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { name: 'Alex Morgan' },
    holderEmail: null,
    source: 'manual',
    mode: 'live',
    actor: { type: 'system', id: null },
    execution: { kind: 'system' },
  });
};

async function issued(objectKey: string): Promise<PassJson> {
  const artifact = await kit.env.BUCKET.get(objectKey);
  if (!artifact) throw new Error('Missing pass artifact');
  const files = unzipSync(new Uint8Array(await artifact.arrayBuffer()));
  return JSON.parse(new TextDecoder().decode(files['pass.json'])) as PassJson;
}

describe('a starter becomes a blueprint', () => {
  it('reissues its demo pass with the new identity and no field change; new passes are refused', async () => {
    const [before, after] = await Promise.all([
      bakedFrom('starter-reissue', pack(false)),
      bakedFrom('starter-reissue', pack(true)),
    ]);
    expect(after.template.version).not.toBe(before.template.version);
    await sync(before);
    const id = before.template.id;
    const demo = await issue(id);
    await kit.settle();
    const old = await issued(demo.objectKey);

    await sync(after);
    await expect(issue(id)).rejects.toMatchObject({ code: 'TEMPLATE_IS_BLUEPRINT' });
    kit.clock.set(kit.clock.now() + STALE_QUIET_MS + 1);
    await reissueStaleTemplates(kit.ctx);
    const jobs = kit.workflow.created
      .filter((w) => (w.params as ReissueParams).templateId === id)
      .map((w) => ({ id: w.id, params: w.params as ReissueParams }));
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    if (!job) throw new Error('Missing the reissue');
    expect(await runBulkReissue(kit.env, job.id, job.params, step)).toEqual({
      changed: 1,
      unchanged: 0,
      failed: 0,
    });
    const pass = await getPass(kit.env.DB, demo.id);
    expect(pass?.templateVersion).toBe(after.template.version);
    const now = await issued(pass?.objectKey ?? '');
    expect(now).toMatchObject({
      backgroundColor: 'rgb(0,75,65)',
      labelColor: 'rgb(242,208,125)',
      description: `${kit.org.name} balance card`,
    });
    // Wallet alerts only for a changed field value with a changeMessage: every field is as before.
    expect(now.generic).toEqual(old.generic);
  });
});
