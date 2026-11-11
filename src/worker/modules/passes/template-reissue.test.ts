import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { first } from '../../platform/db.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { basicPackage, passJson } from '../templates/package/fixtures.ts';
import { olderLivePasses } from '../templates/repo-stale.ts';
import { resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, sourceOf } from '../templates/testing.ts';
import { createPassRow } from './create.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo.ts';
import { reissueStalePasses, STALE_QUIET_MS } from './stale-reissue.ts';
import { type Kit, setupKit, TINY_PNG } from './test-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const admin = { type: 'user', id: 'admin-1' } as const;
type Fn = () => Promise<unknown>;
const call = (a: unknown, b: unknown) => ((typeof a === 'function' ? a : b) as Fn)();
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => call(a, b),
} as unknown as Parameters<typeof runBulkReissue>[3];

const SLOT = [{ key: 'pass-service', label: 'Pass service', value: '' }];
let seq = 0;

/** Registers a version with the registry the builder reads and with D1 the cron reads. */
async function addVersion(
  id: string,
  version: string,
  options: { backFields?: object[]; manifest?: TemplateManifest } = {},
) {
  const base = kit.template;
  const pass = structuredClone(base.passJson) as PassJson;
  pass.generic = { ...pass.generic, backFields: options.backFields ?? [] } as PassJson['generic'];
  const resolved = kit.registry.add({
    id,
    version,
    orgId: null,
    manifest: options.manifest ?? base.manifest,
    passJson: pass,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, resolved);
  return resolved;
}

/** What publishing does to D1: the active version moves and the row is touched. */
async function activate(id: string, version: string) {
  await kit.env.DB.prepare('UPDATE templates SET active_version = ?, updated_at = ? WHERE id = ?')
    .bind(version, kit.clock.now(), id)
    .run();
}

const newTemplate = async (backFields: object[] = []) => {
  const id = `tpl-reissue-${seq++}`;
  await addVersion(id, 'v1', { backFields });
  return id;
};

const passOn = async (templateId: string) =>
  createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId,
    templateVersion: (await kit.registry.resolve(templateId)).version,
    input: { memberName: 'Alex Morgan' },
    holderEmail: null,
    source: 'manual',
    mode: 'live',
    actor: { type: 'system', id: null },
  });

const cron = async (advance = STALE_QUIET_MS + 1) => {
  kit.clock.set(kit.clock.now() + advance);
  await reissueStalePasses(kit.ctx);
};
const started = (templateId: string) =>
  kit.workflow.created.filter(
    (w) => (w.params as { templateId?: string }).templateId === templateId,
  );
const run = async (w: { id: string; params: unknown } | undefined) =>
  runBulkReissue(kit.env, w?.id ?? '', w?.params as Parameters<typeof runBulkReissue>[2], step);
const reissuedVersion = async (id: string) =>
  (
    await first<{ v: string | null }>(
      kit.env.DB,
      'SELECT reissued_version AS v FROM templates WHERE id = ?',
      [id],
    )
  )?.v;
const lastPassJson = async (passId: string) =>
  JSON.parse(
    (
      await first<{ pass_json: string }>(
        kit.env.DB,
        'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
        [passId],
      )
    )?.pass_json ?? '{}',
  );

describe('template reissue', () => {
  it('rebuilds live passes on the new version with its back fields; voided passes stay', async () => {
    const id = await newTemplate();
    const live = await passOn(id);
    const voided = await passOn(id);
    await publishPass(kit.ctx, {
      passId: voided.id,
      cause: 'admin',
      actor: admin,
      mutate: () => ({ status: 'voided' }),
    });
    await kit.settle();
    await cron();
    expect(started(id)).toHaveLength(0);
    expect(await reissuedVersion(id)).toBe('v1');

    await addVersion(id, 'v2', { backFields: SLOT });
    await activate(id, 'v2');
    await cron(STALE_QUIET_MS / 2);
    expect(started(id)).toHaveLength(0);
    await cron();
    await cron();
    const [workflow] = started(id);
    expect(started(id)).toHaveLength(1);
    expect(workflow?.params).toMatchObject({
      templateId: id,
      version: 'v2',
      cause: 'template_upgrade',
    });

    kit.queue.sent.length = 0;
    expect(await run(workflow)).toEqual({ changed: 1, unchanged: 0, failed: 0 });
    await kit.settle();
    expect((await getPass(kit.env.DB, live.id))?.templateVersion).toBe('v2');
    expect((await getPass(kit.env.DB, voided.id))?.templateVersion).toBe('v1');
    const back = (await lastPassJson(live.id)).generic.backFields as {
      key: string;
      value: string;
    }[];
    expect(back.find((f) => f.key === 'pass-service')?.value).toContain('support@passbook.mobile');
    expect((await olderLivePasses(kit.env.DB, id)).older).toBe(0);
  });

  it('turns a burst of versions into one reissue to the latest', async () => {
    const id = await newTemplate();
    await passOn(id);
    await cron();
    for (const v of ['v2', 'v3', 'v4']) {
      await addVersion(id, v);
      await activate(id, v);
      kit.clock.set(kit.clock.now() + 20_000);
    }
    await cron(0);
    expect(started(id)).toHaveLength(0);
    await cron();
    await cron();
    expect(started(id)).toHaveLength(1);
    expect(started(id)[0]?.params).toMatchObject({ version: 'v4' });
  });

  it('starts nothing when every pass is current, and again after a rollback', async () => {
    const id = await newTemplate();
    await passOn(id);
    await addVersion(id, 'v2');
    await activate(id, 'v2');
    await cron();
    await run(started(id)[0]);
    await cron();
    expect(started(id)).toHaveLength(1);

    await activate(id, 'v1');
    await cron();
    expect(started(id)).toHaveLength(2);
    expect(started(id)[1]?.params).toMatchObject({ version: 'v1' });
  });

  it('keeps a pass on its version when the new one no longer fits, and says so', async () => {
    const id = await newTemplate();
    const pass = await passOn(id);
    const inputs = kit.template.manifest.inputs as {
      required: string[];
      properties: Record<string, unknown>;
    };
    await addVersion(id, 'v2', {
      manifest: {
        ...kit.template.manifest,
        inputs: {
          ...inputs,
          type: 'object',
          required: [...inputs.required, 'tier'],
          properties: { ...inputs.properties, tier: { type: 'string', minLength: 1 } },
        },
      } as TemplateManifest,
    });
    await activate(id, 'v2');
    await cron();
    expect(await run(started(id)[0])).toMatchObject({ changed: 0, failed: 1 });
    expect((await getPass(kit.env.DB, pass.id))?.templateVersion).toBe('v1');
    expect(await olderLivePasses(kit.env.DB, id)).toEqual({ older: 1, settled: true });
    await cron();
    expect(started(id)).toHaveLength(1);
  });

  it('follows a baked template that changed in a deploy', async () => {
    resetBakedSync();
    const pack = (back: object[]) =>
      basicPackage(
        {},
        passJson({
          generic: {
            primaryFields: [{ key: 'name', label: 'Name', value: 'Alex Morgan' }],
            backFields: back,
          },
        }),
      );
    const v1 = await bakedFrom('deploy-card', pack([]));
    const v2 = await bakedFrom('deploy-card', pack(SLOT));
    expect(v2.template.version).not.toBe(v1.template.version);
    const id = v1.template.id;

    await syncBakedTemplates(kit.ctx, sourceOf([v1], 'build-1'));
    const register = (t: typeof v1.template) =>
      kit.registry.add({
        id,
        version: t.version,
        orgId: null,
        origin: 'baked',
        manifest: { ...kit.template.manifest },
        passJson: t.passJson as PassJson,
        assets: { 'icon.png': TINY_PNG },
      });
    register(v1.template);
    const pass = await passOn(id);
    await cron();
    expect(started(id)).toHaveLength(0);

    register(v2.template);
    resetBakedSync();
    await syncBakedTemplates(kit.ctx, sourceOf([v2], 'build-2'));
    await cron();
    const [workflow] = started(id);
    expect(workflow?.params).toMatchObject({ version: v2.template.version });
    expect(await run(workflow)).toMatchObject({ changed: 1, failed: 0 });
    expect((await getPass(kit.env.DB, pass.id))?.templateVersion).toBe(v2.template.version);
    const back = (await lastPassJson(pass.id)).generic.backFields as {
      key: string;
      value: string;
    }[];
    expect(back.find((f) => f.key === 'pass-service')?.value).toBe(
      `PassBook · support@passbook.mobile\n${kit.env.PUBLIC_BASE_URL}`,
    );
  });
});
