import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { WORKBENCH_ROUTES } from '../../../shared/contracts/workbench.ts';
import { all } from '../../platform/db.ts';
import { basicPackage, passJson, zipOf } from '../templates/package/fixtures.ts';
import { importZip } from '../templates/testing.ts';
import { BROWSER, workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const manifest = {
  schema: 1,
  name: 'Design Token',
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
};

async function templateIn(orgId: string, userId: string) {
  const imported = await importZip(t.kit.env, t.kit.clock, {
    orgId,
    createdBy: userId,
    name: manifest.name,
    zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest) }, passJson())),
  });
  if (!imported.result) throw new Error('Import failed');
  return imported.result;
}

/** The saved version as the designer sends it back: both documents and its files by hash. */
async function body(token: string, templateId: string, version: string, orgId: string) {
  const res = await t.call(
    'GET',
    `/templates/${templateId}/versions/${version}?orgId=${orgId}`,
    t.asClient(token),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  const v = (await res.json()) as {
    passJson: object;
    manifest: object;
    assets: { name: string; sha1: string }[];
  };
  return {
    orgId,
    passJson: v.passJson,
    manifest: { ...v.manifest, sample: { name: 'Casey' } },
    assets: v.assets.map((a) => ({ name: a.name, sha1: a.sha1 })),
  };
}

const versions = (templateId: string) =>
  all<{ version: string }>(
    t.kit.env.DB,
    'SELECT version FROM template_versions WHERE template_id = ?',
    [templateId],
  );

describe('Design on the member token: save, dry run and the designer reads', () => {
  it('saves a version and its dry run in its own org, and never touches a release', async () => {
    const m = await t.member();
    const { templateId, version } = await templateIn(m.orgId, m.user.id);
    const { token } = await t.wbMint(m.browser, m.orgId);
    const doc = await body(token, templateId, version, m.orgId);
    const before = (await versions(templateId)).length;

    const dry = await t.call('POST', `/templates/${templateId}/versions`, t.asClient(token), {
      ...doc,
      dryRun: true,
    });
    expect(dry.status, await dry.clone().text()).toBe(200);
    expect(((await dry.json()) as { saved: boolean }).saved).toBe(false);
    expect((await versions(templateId)).length).toBe(before);

    const saved = await t.call('POST', `/templates/${templateId}/versions`, t.asClient(token), doc);
    expect(saved.status, await saved.clone().text()).toBeLessThan(300);
    expect((await versions(templateId)).length).toBe(before + 1);
    const releases = await all(
      t.kit.env.DB,
      'SELECT mode FROM template_releases WHERE template_id = ?',
      [templateId],
    );
    expect(releases).toEqual([]);
  });

  it("is not found for a template of another org, and the session's cookie is not consulted", async () => {
    const mine = await t.member();
    const other = await t.member();
    const theirs = await templateIn(other.orgId, other.user.id);
    const { token } = await t.wbMint(mine.browser, mine.orgId);
    const doc = await body(
      (await t.wbMint(other.browser, other.orgId)).token,
      theirs.templateId,
      theirs.version,
      other.orgId,
    );
    const res = await t.call(
      'POST',
      `/templates/${theirs.templateId}/versions`,
      t.asClient(token),
      {
        ...doc,
        dryRun: true,
      },
    );
    expect([403, 404]).toContain(res.status);
    expect((await versions(theirs.templateId)).length).toBe(1);
    const named = await t.call(
      'POST',
      `/templates/${theirs.templateId}/versions`,
      t.asClient(token),
      {
        ...doc,
        orgId: mine.orgId,
        dryRun: true,
      },
    );
    expect([403, 404]).toContain(named.status);
  });

  it('refuses a read-only member', async () => {
    const admin = await t.member();
    const { templateId, version } = await templateIn(admin.orgId, admin.user.id);
    const reader = await makeUser(t.kit.f);
    await t.join(reader.id, admin.orgId, ['read_only']);
    const session = await makeSession(t.kit.f, { userId: reader.id, roles: ['user', 'console'] });
    const { token } = await t.wbMint({ ...session.headers, ...BROWSER }, admin.orgId);
    const doc = await body(token, templateId, version, admin.orgId);
    for (const extra of [{}, { dryRun: true }]) {
      const res = await t.call('POST', `/templates/${templateId}/versions`, t.asClient(token), {
        ...doc,
        ...extra,
      });
      expect(res.status).toBe(403);
    }
    expect((await versions(templateId)).length).toBe(1);
  });

  it('a Live release stays refused beside a save', async () => {
    const m = await t.member();
    const { templateId, version } = await templateIn(m.orgId, m.user.id);
    const { token } = await t.wbMint(m.browser, m.orgId);
    await expectProblem(
      await t.call('POST', `/templates/${templateId}/release`, t.asClient(token), {
        version,
        modes: ['live'],
      }),
      403,
      'WORKBENCH_TEST_ONLY',
    );
  });

  it('keeps the channel policy writes and the template lifecycle out', async () => {
    const m = await t.member();
    const { templateId } = await templateIn(m.orgId, m.user.id);
    const { token } = await t.wbMint(m.browser, m.orgId);
    for (const [method, path] of [
      ['PUT', `/templates/${templateId}/channels`],
      ['POST', `/templates/${templateId}/channels/reset-passes`],
      ['POST', `/templates/${templateId}/archive`],
    ] as const)
      expect([401, 403]).toContain(
        (await t.call(method, path, t.asClient(token), { orgId: m.orgId })).status,
      );
  });

  it("lists its own templates and the blueprints, and not another org's", async () => {
    const m = await t.member();
    const { templateId } = await templateIn(m.orgId, m.user.id);
    const { token } = await t.wbMint(m.browser, m.orgId);
    const own = await t.call('GET', `/templates?orgId=${m.orgId}&limit=200`, t.asClient(token));
    expect(own.status, await own.clone().text()).toBe(200);
    const ids = ((await own.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toContain(templateId);
    const blueprints = await t.call(
      'GET',
      `/templates?orgId=${m.orgId}&blueprint=true&limit=200`,
      t.asClient(token),
    );
    expect(blueprints.status, await blueprints.clone().text()).toBe(200);
    const other = await t.member();
    const foreign = await t.call('GET', `/templates?orgId=${other.orgId}`, t.asClient(token));
    expect([403, 404]).toContain(foreign.status);
    // Same user, member of the second org too: only the token's org pin refuses it.
    await t.join(m.user.id, other.orgId, ['org_admin']);
    await templateIn(other.orgId, m.user.id);
    const pinned = await t.call('GET', `/templates?orgId=${other.orgId}`, t.asClient(token));
    expect(pinned.status).toBe(404);
  });

  it('keeps every template and blueprint write out of the allowlist', () => {
    const writes = WORKBENCH_ROUTES.filter(
      (r) => /\/api\/v1\/templates(\/|$)/.test(r) && !r.startsWith('GET '),
    );
    expect(writes.sort()).toEqual([
      'POST /api/v1/templates/:id/preview',
      'POST /api/v1/templates/:id/release',
      'POST /api/v1/templates/:id/versions',
    ]);
  });

  it('refuses a template create, a blueprint use and a template delete', async () => {
    const m = await t.member();
    const { templateId } = await templateIn(m.orgId, m.user.id);
    const { token } = await t.wbMint(m.browser, m.orgId);
    for (const [method, path] of [
      ['POST', '/templates'],
      ['POST', '/templates/baked:starter-x/use'],
      ['PATCH', `/templates/${templateId}`],
      ['DELETE', `/templates/${templateId}`],
    ] as const)
      expect([401, 403], `${method} ${path}`).toContain(
        (await t.call(method, path, t.asClient(token), { orgId: m.orgId })).status,
      );
  });

  it('reads the channel policy of its own template', async () => {
    const m = await t.member();
    const { templateId } = await templateIn(m.orgId, m.user.id);
    const { token } = await t.wbMint(m.browser, m.orgId);
    const res = await t.call(
      'GET',
      `/templates/${templateId}/channels?orgId=${m.orgId}`,
      t.asClient(token),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const other = await t.member();
    const foreign = await t.call(
      'GET',
      `/templates/${templateId}/channels?orgId=${other.orgId}`,
      t.asClient(token),
    );
    expect(foreign.status).toBe(404);
  });

  it('reads only the website and the time zone of its own org settings', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    const res = await t.call('GET', `/settings?scope=org:${m.orgId}`, t.asClient(token));
    expect(res.status, await res.clone().text()).toBe(200);
    const { items } = (await res.json()) as { items: { key: string }[] };
    expect(items.every((i) => ['org.website', 'org.timeZone'].includes(i.key))).toBe(true);
    const other = await t.member();
    expect(
      (await t.call('GET', `/settings?scope=org:${other.orgId}`, t.asClient(token))).status,
    ).toBe(404);
    for (const scope of ['platform'])
      expect([403, 404]).toContain(
        (await t.call('GET', `/settings?scope=${scope}`, t.asClient(token))).status,
      );
  });

  it('keeps the settings write and a plain key out', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    const res = await t.call('PUT', '/settings', t.asClient(token), {
      scope: `org:${m.orgId}`,
      values: {},
    });
    expect([401, 403]).toContain(res.status);
  });

  it('reads the brand of its own org without the Apple identity, wallet accounts or checks', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    const res = await t.call('GET', `/orgs/${m.orgId}/pass-setup`, t.asClient(token));
    expect(res.status, await res.clone().text()).toBe(200);
    const view = (await res.json()) as {
      brand: object;
      apple: { identity: unknown; run: unknown };
      templates: unknown[];
      checks: unknown[];
      channels: Record<string, { account?: unknown }>;
    };
    expect(view.brand).toBeTruthy();
    expect(view.apple.identity).toBeNull();
    expect(view.apple.run).toBeNull();
    expect(view.templates).toEqual([]);
    expect(view.checks).toEqual([]);
    for (const channel of Object.values(view.channels)) expect(channel.account).toBeUndefined();
    const other = await t.member();
    expect((await t.call('GET', `/orgs/${other.orgId}/pass-setup`, t.asClient(token))).status).toBe(
      404,
    );
  });
});
