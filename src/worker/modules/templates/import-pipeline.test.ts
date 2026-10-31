import { beforeAll, describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { cleanupStage } from './import-pipeline.ts';
import { basicPackage, makePng, passJson, zipOf } from './package/fixtures.ts';
import { getImport, getVersion } from './repo.ts';
import { syncBakedTemplates } from './sync.ts';
import { bakedFrom, fakeAssets, importZip, sourceOf } from './testing.ts';

let env: AppEnv;
let clock: ManualClock;
let orgId: string;
let userId: string;

const assets = fakeAssets();

beforeAll(async () => {
  env = await makeEnv({ ASSETS: assets });
  clock = new ManualClock(Date.now());
  const f = fixtures(env, clock);
  orgId = (await makeOrg(f)).id;
  userId = (await makeUser(f)).id;
});

const run = (files: Map<string, Uint8Array> | Uint8Array, name?: string, createdBy = userId) =>
  importZip(env, clock, {
    orgId,
    zip: files instanceof Uint8Array ? files : zipOf(files),
    name,
    createdBy,
  });

async function rejected(zip: Uint8Array | Map<string, Uint8Array>, name?: string) {
  const r = await run(zip, name);
  expect(r.result).toBeNull();
  const row = await getImport(env.DB, r.p.uploadId);
  const run_ = await first<{ status: string; error_code: string }>(
    env.DB,
    'SELECT status, error_code FROM workflow_runs WHERE instance_id = ?',
    [r.p.uploadId],
  );
  expect(run_?.status).toBe('errored');
  return { stages: r.stages, row, codes: row?.report?.issues.map((i) => i.code) ?? [] };
}

describe('TemplateImport pipeline', () => {
  it('imports a package: R2 objects, rows, report and status', async () => {
    const r = await run(
      basicPackage({
        'wallet.template.json': JSON.stringify({
          schema: 1,
          name: 'Gym Card',
          description: 'Member card',
          inputs: { type: 'object', properties: { name: { type: 'string' } } },
          sample: { name: 'Alex' },
          bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
          display: { title: '{{name}}' },
        }),
        'tooling.json': '{"x":1}',
      }),
    );
    expect(r.stages).toEqual(['extract', 'analyze', 'dry-run', 'persist']);
    const { templateId, version } = r.result ?? { templateId: '', version: '' };

    const row = await first<Record<string, unknown>>(
      env.DB,
      'SELECT * FROM templates WHERE id = ?',
      [templateId],
    );
    expect(row).toMatchObject({
      org_id: orgId,
      slug: 'gym-card',
      name: 'Gym Card',
      origin: 'uploaded',
      active_version: version,
      status: 'active',
      created_by: userId,
    });
    expect(JSON.parse(row?.styles as string)).toEqual(['generic']);

    const v = await getVersion(env.DB, templateId, version);
    expect(v?.report.ok).toBe(true);
    expect(v?.assets.map((a) => a.name)).toEqual(['icon.png', 'icon@2x.png']);
    expect(v?.assets[0]?.source).toEqual({
      kind: 'r2',
      key: `templates/${orgId}/${templateId}/${version}/icon.png`,
    });
    for (const a of v?.assets ?? []) {
      const key = a.source.kind === 'r2' ? a.source.key : '';
      expect((await env.BUCKET.head(key))?.size).toBe(a.size);
    }
    expect(
      await env.BUCKET.head(`templates/${orgId}/${templateId}/${version}/tooling.json`),
    ).not.toBeNull();
    expect(
      await env.BUCKET.head(`templates/${orgId}/${templateId}/${version}/pass.json`),
    ).toBeNull();

    const status = await getImport(env.DB, r.p.uploadId);
    expect(status).toMatchObject({ step: 'done', templateId, version, workflowStatus: 'complete' });

    await cleanupStage(r.ctx, r.p);
    expect(await env.BUCKET.head(r.p.objectKey)).toBeNull();
    expect((await env.BUCKET.list({ prefix: `uploads/${r.p.uploadId}/` })).objects).toEqual([]);
  });

  it('re-uploading the same slug adds a version and activates it; identical content is idempotent', async () => {
    const first1 = await run(basicPackage(), 'Reupload');
    const id = first1.result?.templateId ?? '';
    const second = await run(basicPackage({ 'logo.png': makePng(120, 40) }), 'Reupload');
    expect(second.result?.templateId).toBe(id);
    expect(second.result?.version).not.toBe(first1.result?.version);
    const again = await run(basicPackage({ 'logo.png': makePng(120, 40) }), 'Reupload');
    expect(again.result).toEqual(second.result);

    const versions = await all<{ version: string }>(
      env.DB,
      'SELECT version FROM template_versions WHERE template_id = ?',
      [id],
    );
    expect(versions).toHaveLength(2);
    const t = await first<{ active_version: string }>(
      env.DB,
      'SELECT active_version FROM templates WHERE id = ?',
      [id],
    );
    expect(t?.active_version).toBe(second.result?.version);
  });

  it('derives manifest name from the name parameter', async () => {
    const r = await run(basicPackage(), 'Named Upload');
    const v = await getVersion(env.DB, r.result?.templateId ?? '', r.result?.version ?? '');
    expect(v?.manifest.name).toBe('Named Upload');
  });

  it('keeps warnings in the stored report', async () => {
    const r = await run(basicPackage({ 'strip.png': makePng(375, 144) }), 'Warns');
    const v = await getVersion(env.DB, r.result?.templateId ?? '', r.result?.version ?? '');
    expect(v?.report.ok).toBe(true);
    expect(v?.report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['SLOT_UNUSED', 'MANIFEST_GENERATED']),
    );
  });

  describe('rejects hostile or broken archives', () => {
    it('not a zip', async () => {
      const r = await rejected(new TextEncoder().encode('MZ definitely not a zip'));
      expect(r.codes).toEqual(['NOT_A_ZIP']);
      expect(r.stages).toEqual(['extract']);
      expect(r.row?.error).toBe('NOT_A_ZIP');
    });

    it('path traversal', async () => {
      const zip = zipOf({ '../pass.json': new TextEncoder().encode('{}') });
      expect((await rejected(zip)).codes).toEqual(['PATH_TRAVERSAL']);
    });

    it('zip bomb', async () => {
      const zip = zipOf({ 'icon.png': new Uint8Array(4 * 1024 * 1024) });
      expect((await rejected(zip)).codes).toEqual(['COMPRESSION_RATIO']);
    });

    it('oversized entry', async () => {
      const zip = zipOf({ 'icon.png': new Uint8Array(6 * 1024 * 1024) });
      expect((await rejected(zip)).codes).toEqual(['ENTRY_TOO_LARGE']);
    });

    it('bad PNG', async () => {
      const r = await rejected(basicPackage({ 'icon@2x.png': 'GIF89a not png' }));
      expect(r.codes).toContain('IMAGE_INVALID');
      expect(r.stages).toEqual(['extract', 'analyze']);
    });

    it('wrong image dimensions', async () => {
      const r = await rejected(basicPackage({ 'icon.png': makePng(40, 40) }));
      expect(r.codes).toContain('IMAGE_SIZE');
      expect(r.row?.report?.issues.find((i) => i.code === 'IMAGE_SIZE')?.path).toBe('icon.png');
    });

    it('bad pass.json', async () => {
      expect((await rejected(basicPackage({ 'pass.json': '{broken' }))).codes).toContain(
        'PASS_JSON_INVALID',
      );
    });

    it('a file name outside the allowlist', async () => {
      expect((await rejected(basicPackage({ 'payload.exe': 'MZ' }))).codes).toContain(
        'NAME_NOT_ALLOWED',
      );
    });

    it('a pass that cannot be built: duplicate field keys fail the dry run', async () => {
      const pass = passJson({
        generic: {
          primaryFields: [{ key: 'dup', value: 'a' }],
          backFields: [{ key: 'dup', value: 'b' }],
        },
      });
      const r = await rejected(basicPackage({}, pass));
      expect(r.codes).toContain('DUPLICATE_FIELD_KEY');
      expect(r.stages).toEqual(['extract', 'analyze', 'dry-run']);
    });

    it('nfc in pass.json without an NFC identity', async () => {
      const pass = passJson({ nfc: { message: 'x', encryptionPublicKey: 'abc' } });
      expect((await rejected(basicPackage({}, pass))).codes).toContain('NFC_NOT_ENTITLED');
    });

    it('a restricted-schema violation in an uploaded manifest', async () => {
      const manifest = JSON.stringify({
        schema: 1,
        name: 'X',
        inputs: { type: 'object', properties: { a: { type: 'string', pattern: '(a+)+$' } } },
        sample: {},
        bindings: [],
        display: { title: 'x' },
      });
      expect((await rejected(basicPackage({ 'wallet.template.json': manifest }))).codes).toContain(
        'SCHEMA_PATTERN',
      );
    });

    it('a missing upload object', async () => {
      const r = await run(basicPackage());
      await env.BUCKET.delete(r.p.objectKey);
      const { extractStage } = await import('./import-pipeline.ts');
      const again = await extractStage(r.ctx, r.p);
      expect(again.ok).toBe(false);
    });

    it('does not create rows or objects for rejected imports', async () => {
      const before = await first<{ n: number }>(
        env.DB,
        'SELECT COUNT(*) AS n FROM template_versions',
      );
      await rejected(basicPackage({ 'icon.png': makePng(1, 1) }), 'Rejected One');
      const after = await first<{ n: number }>(
        env.DB,
        'SELECT COUNT(*) AS n FROM template_versions',
      );
      expect(after?.n).toBe(before?.n);
      expect(
        await first(env.DB, "SELECT id FROM templates WHERE slug = 'rejected-one'"),
      ).toBeNull();
    });
  });

  it('refuses a name that belongs to a baked template in the same org', async () => {
    const f = fixtures(env, clock);
    const org = await makeOrg(f);
    const baked = await bakedFrom('taken', basicPackage(), {
      name: 'Taken',
      org: { slug: org.slug, name: org.name },
    });
    for (const [k, v] of baked.files) assets.files.set(k, v);
    await syncBakedTemplates(
      createServiceContext(env, { clock }),
      sourceOf([baked], 'pipeline-hash'),
    );
    const r = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Taken',
    });
    expect(r.result).toBeNull();
    const row = await getImport(env.DB, r.p.uploadId);
    expect(row?.error).toBe('TEMPLATE_BAKED');
    expect(row?.workflowStatus).toBe('errored');
  });
});
