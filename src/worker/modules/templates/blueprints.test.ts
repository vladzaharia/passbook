import { beforeAll, describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { all, first } from '../../platform/db.ts';
import { type BlueprintKit, blueprintKit } from './blueprint-test-fixtures.ts';
import { validateManifest } from './package/manifest.ts';
import { extractArchive } from './package/unzip.ts';
import { generatedSource } from './sync.ts';

const STORE = 'baked:starter-store-card';
const MISSING_ORG = '01900000-0000-7000-8000-000000000000';

interface Item {
  id: string;
  name: string;
  blueprint: boolean;
  origin: string;
  orgId: string | null;
  activeVersion: string | null;
  icon: string | null;
  fromBlueprint: { id: string; name: string } | null;
}
interface Detail extends Item {
  versions: { version: string; active: boolean }[];
  manifest: Record<string, unknown>;
}

let kit: BlueprintKit;
const items = async (query: string, headers = kit.admin) =>
  ((await (await kit.call(query, {}, headers)).json()) as { items: Item[] }).items;
const draftOf = async (id: string) => {
  const base = (await (await kit.call(`/${id}`)).json()) as Item;
  const v = (await (await kit.call(`/${id}/versions/${base.activeVersion}`)).json()) as {
    passJson: Record<string, unknown>;
    manifest: Record<string, unknown>;
    assets: { name: string; sha1: string }[];
  };
  return {
    passJson: v.passJson,
    manifest: v.manifest,
    assets: v.assets.map((a) => ({ name: a.name, sha1: a.sha1 })),
  };
};

beforeAll(async () => {
  kit = await blueprintKit();
}, 60_000);

describe('the blueprint flag', () => {
  it('comes from the manifest, on the starters only, and the sync writes it', async () => {
    const blueprints = generatedSource.templates.filter((t) => t.blueprint).map((t) => t.id);
    expect(blueprints.length).toBeGreaterThanOrEqual(6);
    expect(blueprints.every((id) => id.startsWith('baked:starter-'))).toBe(true);
    const listed = await items('?blueprint=true&limit=200');
    expect(listed.map((i) => i.id).sort()).toEqual([...blueprints].sort());
    expect(listed.every((i) => i.blueprint && i.orgId === null)).toBe(true);
    const rows = await all<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM templates WHERE blueprint = 1 ORDER BY id',
    );
    expect(rows.map((r) => r.id)).toEqual([...blueprints].sort());
  });

  it('keeps Henry’s templates real, and lists templates without blueprints by default', async () => {
    expect((await items('?limit=200')).some((i) => i.blueprint)).toBe(false);
    const henrys = await items(`?orgId=${kit.henrys.id}&limit=200`);
    expect(henrys.some((i) => i.blueprint)).toBe(false);
    expect(henrys.map((i) => i.id)).toEqual(
      expect.arrayContaining(['baked:henrys-blue', 'baked:henrys-copper']),
    );
    expect(await (await kit.call('/baked:henrys-copper')).json()).toMatchObject({
      blueprint: false,
      fromBlueprint: null,
    });
    expect(await (await kit.call(`/${STORE}`)).json()).toMatchObject({ blueprint: true });
  });

  it('is refused in an uploaded manifest, and display.icon must be curated', () => {
    const manifest = {
      schema: 1,
      name: 'X',
      inputs: { type: 'object' },
      sample: {},
      bindings: [],
      display: { title: 'x', icon: 'coins' },
    } as unknown as TemplateManifest;
    const pass = { generic: { primaryFields: [] } } as never;
    const errors = (m: unknown, uploaded: boolean) =>
      validateManifest(m as TemplateManifest, pass, { uploaded })
        .filter((i) => i.severity === 'error')
        .map((i) => i.code);
    expect(errors(manifest, true)).toEqual([]);
    expect(errors({ ...manifest, blueprint: true }, true)).toContain('MANIFEST_BLUEPRINT');
    expect(errors({ ...manifest, blueprint: true }, false)).toEqual([]);
    expect(errors({ ...manifest, display: { title: 'x', icon: 'rocket' } }, true)).toContain(
      'MANIFEST_ICON',
    );
  });
});

describe('use a blueprint', () => {
  it('makes the first version of a template in the org, as a candidate', async () => {
    const res = await kit.post(`/${STORE}/use`, { orgId: kit.org.id, name: 'Gym Card' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Detail;
    expect(body).toMatchObject({
      blueprint: false,
      origin: 'uploaded',
      orgId: kit.org.id,
      name: 'Gym Card',
      activeVersion: null,
      fromBlueprint: { id: STORE },
    });
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]?.active).toBe(false);
    expect('blueprint' in body.manifest).toBe(false);
    expect(body.manifest.name).toBe('Gym Card');
    const audit = await first<{ detail: string }>(
      kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'template.use_blueprint' AND target_id = ?",
      [body.id],
    );
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ sourceId: STORE });
  });

  it('lists the new template for its org only, never as a blueprint', async () => {
    const mine = await items(`?orgId=${kit.org.id}`);
    expect(mine.find((i) => i.name === 'Gym Card')).toMatchObject({
      blueprint: false,
      fromBlueprint: { id: STORE },
    });
    expect((await items('?blueprint=true&limit=200')).some((i) => i.orgId !== null)).toBe(false);
    expect((await items(`?orgId=${kit.other.id}`)).some((i) => i.fromBlueprint)).toBe(false);
  });

  it('refuses a taken name, an unknown org, a template and an unknown id', async () => {
    const taken = await kit.post(`/${STORE}/use`, { orgId: kit.org.id, name: 'Gym Card' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'TEMPLATE_EXISTS' });
    expect((await kit.post(`/${STORE}/use`, { orgId: MISSING_ORG, name: 'A B' })).status).toBe(404);
    const gym = (await items(`?orgId=${kit.org.id}`)).find((i) => i.name === 'Gym Card');
    const template = await kit.post(`/${gym?.id}/use`, { orgId: kit.org.id, name: 'Copy' });
    expect(template.status).toBe(422);
    expect(await template.json()).toMatchObject({ code: 'TEMPLATE_NOT_BLUEPRINT' });
    const henrys = await kit.post('/baked:henrys-blue/use', { orgId: kit.henrys.id, name: 'Copy' });
    expect(await henrys.json()).toMatchObject({ code: 'TEMPLATE_NOT_BLUEPRINT' });
    expect((await kit.post('/baked:nope/use', { orgId: kit.org.id, name: 'Copy' })).status).toBe(
      404,
    );
  });

  it('needs a template author in the destination org', async () => {
    const reader = await kit.member(kit.org.id, ['read_only']);
    const author = await kit.member(kit.org.id, ['template_author']);
    const body = { orgId: kit.org.id, name: 'Author Card' };
    expect((await kit.post(`/${STORE}/use`, body, reader.headers)).status).toBe(403);
    expect(
      (await kit.post(`/${STORE}/use`, { ...body, orgId: kit.other.id }, author.headers)).status,
    ).toBe(404);
    expect((await kit.post(`/${STORE}/use`, body, author.headers)).status).toBe(201);
  });

  it('saves the designer draft as the first version, without the flag', async () => {
    const draft = await draftOf(STORE);
    // The designer sends the blueprint's own manifest, flag included.
    expect(draft.manifest.blueprint).toBe(true);
    const res = await kit.post(`/${STORE}/use`, {
      orgId: kit.org.id,
      name: 'Draft Card',
      version: { ...draft, passJson: { ...draft.passJson, description: 'Gym balance card' } },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as Detail;
    expect(body.versions).toHaveLength(1);
    expect(body.manifest).toMatchObject({ name: 'Draft Card' });
    expect('blueprint' in body.manifest).toBe(false);
    expect(body).toMatchObject({ blueprint: false, fromBlueprint: { id: STORE } });
    const row = await first<{ source_blueprint: string; blueprint: number }>(
      kit.env.DB,
      'SELECT source_blueprint, blueprint FROM templates WHERE id = ?',
      [body.id],
    );
    expect(row).toEqual({ source_blueprint: STORE, blueprint: 0 });
  });

  it('checks a draft for the org without saving anything', async () => {
    const draft = await draftOf(STORE);
    const res = await kit.post(`/${STORE}/use/check`, {
      orgId: kit.org.id,
      name: 'Checked Card',
      version: draft,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      saved: false,
      report: { ok: true },
      passJson: expect.objectContaining({ description: expect.any(String) }),
    });
    const broken = await kit.post(`/${STORE}/use/check`, {
      orgId: kit.org.id,
      name: 'Checked Card',
      version: { ...draft, manifest: { ...draft.manifest, display: {} } },
    });
    expect(await broken.json()).toMatchObject({ saved: false, report: { ok: false } });
    expect((await items(`?orgId=${kit.org.id}&q=Checked`)).length).toBe(0);
    // A blueprint itself stays read-only, draft or not.
    const save = await kit.post(`/${STORE}/versions`, { ...draft, dryRun: true });
    expect(await save.json()).toMatchObject({ code: 'TEMPLATE_BAKED' });
  });
});

describe('blueprints stay platform-wide', () => {
  it('refuses an org assignment', async () => {
    const patch = (orgId: string | null) =>
      kit.call(`/${STORE}`, {
        method: 'PATCH',
        body: JSON.stringify({ orgId }),
        headers: { 'content-type': 'application/json' },
      });
    const refused = await patch(kit.org.id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'TEMPLATE_IS_BLUEPRINT' });
    expect((await patch(null)).status).toBe(200);
    expect(
      (
        await first<{ org_id: string | null }>(
          kit.env.DB,
          'SELECT org_id FROM templates WHERE id = ?',
          [STORE],
        )
      )?.org_id,
    ).toBeNull();
  });

  it('exports a package without the flag', async () => {
    const res = await kit.call(`/${STORE}/package`);
    expect(res.status).toBe(200);
    const files = extractArchive(new Uint8Array(await res.arrayBuffer())).files;
    const manifest = JSON.parse(
      new TextDecoder().decode(files.get('wallet.template.json')),
    ) as Record<string, unknown>;
    expect(manifest.name).toEqual(expect.any(String));
    expect('blueprint' in manifest).toBe(false);
  });
});

describe('pickers', () => {
  it('offer only templates that issue: no blueprint, Henry’s included', async () => {
    const eligible = async (orgId: string) => {
      const res = await kit.call(`/eligible?orgId=${orgId}&mode=live&provider=apple&limit=200`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: { templateId: string }[] }).items.map(
        (i) => i.templateId,
      );
    };
    const henrys = await eligible(kit.henrys.id);
    expect(henrys).toEqual(expect.arrayContaining(['baked:henrys-blue', 'baked:henrys-copper']));
    expect(henrys.some((id) => id.startsWith('baked:starter-'))).toBe(false);
    expect((await eligible(kit.org.id)).some((id) => id.startsWith('baked:starter-'))).toBe(false);
  });
});
