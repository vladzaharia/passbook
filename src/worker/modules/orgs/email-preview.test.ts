import { beforeAll, describe, expect, it } from 'vitest';
import {
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { updateSettings } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { PREVIEW_STARTER_ID, previewTemplate } from './preview-art.ts';

const fake = fakeAuth();
let appEnv: AppEnv;
const app = createApp({ stores: fake.stores });
const ORIGIN = 'http://localhost';
const get = (path: string, headers: Record<string, string> = fake.admin()) =>
  app.request(`${ORIGIN}${path}`, { headers }, appEnv);
const preview = async (orgId: string, query = '') =>
  (await get(`/api/v1/orgs/${orgId}/email-preview${query}`)).text();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const imgSrc = (html: string, name: string) =>
  new RegExp(`<img src="([^"]*/${name.replace('.', '\\.')}[^"]*)"`).exec(html)?.[1];

beforeAll(async () => {
  appEnv = await makeEnv();
});

describe('email preview art', () => {
  it("shows the starter's icon and logo when the org has no template, through admin routes", async () => {
    const org = await makeOrg(fixtures(appEnv), { name: 'Bare Climbing' });
    const html = await preview(org.id);
    const starter = `${ORIGIN}/api/v1/templates/${encodeURIComponent(PREVIEW_STARTER_ID)}/versions/`;
    expect(imgSrc(html, 'icon@3x.png')).toMatch(
      new RegExp(`^${starter}[^/]+/assets/icon@3x\\.png$`),
    );
    expect(imgSrc(html, 'logo@3x.png')).toMatch(
      new RegExp(`^${starter}[^/]+/assets/logo@3x\\.png$`),
    );
    // The starter sets logoText: the org's name stands beside its symbol logo.
    expect(html).toMatch(/font-weight:600;color:[^"]*">Bare Climbing<\/td>/);
    // No holder's capability URL: only the sample's.
    expect(html.match(/\/p\/[^"/]+/g)?.every((p) => p.startsWith('/p/sample'))).toBe(true);
    const asset = new URL(imgSrc(html, 'icon@3x.png') ?? '').pathname;
    expect((await get(asset, {})).status).toBe(401);
  });

  it("uses the org's upload for its slot and the template's for the other", async () => {
    const org = await makeOrg(fixtures(appEnv));
    const upload = await app.request(
      `${ORIGIN}/api/v1/orgs/${org.id}/branding/icon`,
      {
        method: 'PUT',
        headers: { ...fake.admin(), 'content-type': 'application/json' },
        body: JSON.stringify({ x3: b64(makePng(114, 114)) }),
      },
      appEnv,
    );
    expect(upload.status).toBe(200);
    const html = await preview(org.id);
    const icon = imgSrc(html, 'icon/3x') ?? '';
    expect(icon).toMatch(
      new RegExp(`^${ORIGIN}/api/v1/orgs/${org.id}/branding/icon/3x\\?v=[0-9a-f]{64}$`),
    );
    expect((await get(new URL(icon).pathname)).headers.get('content-type')).toBe('image/png');
    expect(imgSrc(html, 'logo@3x.png')).toContain('/api/v1/templates/');
  });

  it("picks the template most of the org's live passes use, else its first own one", async () => {
    const f = fixtures(appEnv);
    const ctx = createServiceContext(appEnv);
    const org = await makeOrg(f);
    expect((await previewTemplate(ctx, org.id)).id).toBe(PREVIEW_STARTER_ID);
    const first = makeTemplate({ id: `first-${org.id}`, orgId: org.id }).resolved;
    await persistTemplate(f, first);
    f.clock.advance(1000);
    await persistTemplate(f, makeTemplate({ id: `later-${org.id}`, orgId: org.id }).resolved);
    expect((await previewTemplate(ctx, org.id)).id).toBe(first.id);
    // A platform template counts once the org's passes use it; deleted passes do not.
    const shared = makeTemplate({ id: `shared-${org.id}`, orgId: null }).resolved;
    await makePass(f, { orgId: org.id, template: shared });
    await makePass(f, { orgId: org.id, template: shared });
    await makePass(f, { orgId: org.id, template: first });
    expect((await previewTemplate(ctx, org.id)).id).toBe(shared.id);
    // Other orgs' passes do not count.
    const other = await makeOrg(f);
    const elsewhere = makeTemplate({ id: `elsewhere-${org.id}`, orgId: null }).resolved;
    for (let i = 0; i < 3; i++) await makePass(f, { orgId: other.id, template: elsewhere });
    expect((await previewTemplate(ctx, org.id)).id).toBe(shared.id);
    await run(appEnv.DB, 'UPDATE passes SET deleted_at = 1 WHERE template_id = ?', [shared.id]);
    expect((await previewTemplate(ctx, org.id)).id).toBe(first.id);
  });
});

describe('email preview drafts', () => {
  it('follows unsaved support contacts and the buddy; empty clears one, as Save would', async () => {
    const org = await makeOrg(fixtures(appEnv));
    const ctx = createServiceContext(appEnv);
    await updateSettings(
      ctx,
      { type: 'user', id: 'admin' },
      {
        scope: `org:${org.id}`,
        values: { 'support.email': 'saved@gym.test', 'support.url': 'https://gym.test/saved' },
      },
    );
    const saved = await preview(org.id);
    expect(saved).toContain('saved@gym.test');
    expect(saved).toContain('https://gym.test/saved');
    expect(saved).not.toContain('/email/buddy-');
    const draft = await preview(
      org.id,
      `?buddy=1&supportEmail=${encodeURIComponent('draft@gym.test')}&supportUrl=`,
    );
    expect(draft).toContain('mailto:draft@gym.test');
    expect(draft).not.toContain('saved@gym.test');
    expect(draft).not.toContain('https://gym.test/saved');
    expect(draft).toContain('/email/buddy-m-happy-light-top-2x.png');
  });

  it('refuses values Save would refuse', async () => {
    const org = await makeOrg(fixtures(appEnv));
    for (const query of ['?supportEmail=nope', '?supportUrl=http%3A%2F%2Fgym.test', '?buddy=2'])
      expect((await get(`/api/v1/orgs/${org.id}/email-preview${query}`)).status).toBe(422);
  });
});
