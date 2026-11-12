import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, expect } from 'vitest';
import { z } from 'zod';
import {
  type FakeAuth,
  fakeAuth,
  makeSession,
  makeUser,
  materializeTemplateAssets,
} from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import { ScanFeedSchema, ScanRecordListSchema } from '../../../shared/contracts/scanners.ts';
import { createApp } from '../../app.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { buildKey as templateBuildKey } from '../templates/package/hash.ts';
import { createScannerStore } from './auth-store.ts';
import {
  insertPrivacyTemplate,
  insertPrivacyTemplateVersion,
  insertSeedScan,
  lastExportAudit,
  type SeedScan,
  setPrivacyPassDetails,
} from './repo-console-privacy-test-fixtures.ts';
import { DAY, grantScanMembership, ORIGIN, type ScanKit, setupScanKit } from './test-kit.ts';

export const PUBLIC = 'Public Guest';
export const HIDDEN = 'hidden-note-sentinel-4821';
export const MANAGER = 'Violet North Balcony';
export const EMAIL = 'private-holder@example.test';
export const EXTERNAL = 'external-private-sentinel-9264';
export const CACHED = 'unsafe-cached-title-sentinel-8317';
export const AFTER = 'raw-after-sentinel-3938';

export let kit: ScanKit;
export let fake: FakeAuth;
export let app: OpenAPIHono<AppBindings>;
export let admin: Record<string, string>;
export let testAdmin: Record<string, string>;
export let adminUserId: string;
export let adminMembershipId: string;
export let adminSessionId: string;
export let templateId: string;
export let initialBuildKey: string;

export type Row = {
  id: string;
  passId: string | null;
  passTitle?: string | null;
  externalId?: string | null;
  before: unknown;
  after: unknown;
};
type Page = { items: Row[]; nextCursor: string | null };

export function setupPrivacyKit() {
  beforeEach(async () => {
    kit = await setupScanKit();
    fake = fakeAuth(ORIGIN);
    fake.bindApiKeys(kit.env, kit.clock);
    const user = await makeUser(kit.fx);
    adminUserId = user.id;
    adminMembershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    adminSessionId = await hashSessionCookie(session.cookieValue);
    admin = { ...session.headers, origin: ORIGIN };
    testAdmin = { ...admin, 'x-passbook-mode': 'test' };
    app = createApp({
      stores: {
        ...fake.stores,
        sessions: createSessionStore(kit.env, kit.clock),
        scanners: createScannerStore(kit.env, kit.clock),
      },
      clock: kit.clock,
    });
    const template = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      manifest: {
        ...kit.template.manifest,
        name: 'Privacy card',
        inputs: {
          type: 'object',
          required: ['memberName'],
          properties: {
            memberName: { type: 'string', minLength: 1 },
            tier: { type: 'string', 'x-scan': 'manager' },
            privateNotes: { type: 'string', 'x-scan': 'hidden' },
          },
        },
        bindings: [
          ...kit.template.manifest.bindings,
          { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
        ],
        scan: {
          actions: [
            { id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' },
            { id: 'manager_only', label: 'Manager entry', kind: 'check_in', minRole: 'manager' },
            { id: 'private_note', label: 'Private note', kind: 'set', input: 'privateNotes' },
          ],
          display: {
            v: 1,
            holder: '{{inputs.memberName}}',
            header: {},
            panels: [
              {
                id: 'p_details',
                rows: [
                  {
                    id: 'r_manager',
                    type: 'field',
                    label: 'Manager area',
                    value: '{{inputs.tier}}',
                    minRole: 'manager',
                  },
                ],
              },
            ],
          },
        },
      },
      passJson: {
        ...kit.template.passJson,
        barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'iso-8859-1' }],
      },
      assets: { 'icon.png': ICON_PNG },
    });
    templateId = template.id;
    initialBuildKey = await templateBuildKey(template);
    await insertPrivacyTemplate(kit, template);
    await insertVersion(template, initialBuildKey);
    for (const mode of ['live', 'test'] as const) {
      await approveAppleRelease(kit, {
        orgId: kit.org.id,
        mode,
        templateId,
        version: template.version,
      });
    }
    // About 0.2 s alone; every test needs its own org, so it cannot move to beforeAll. The default
    // 10 s hook limit fails it when the machine is saturated.
  }, 30_000);
}

export async function insertVersion(template: ResolvedTemplate, buildKey: string) {
  const assets = await materializeTemplateAssets(kit.fx, template, kit.registry);
  await insertPrivacyTemplateVersion(kit, template, assets, buildKey);
}

export async function privatePass() {
  const pass = await kit.scanPass(
    templateId,
    { memberName: PUBLIC, tier: MANAGER, privateNotes: HIDDEN },
    { holderEmail: EMAIL },
  );
  if (!pass.scanCode) throw new Error('The issued pass must have a scan code.');
  await setPrivacyPassDetails(
    kit,
    pass.id,
    EXTERNAL,
    `${CACHED} ${HIDDEN} ${EMAIL} ${pass.scanCode}`,
  );
  return pass;
}

export function expectNoSecrets(value: unknown, pass: Pass, allowManager = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!pass.scanCode) throw new Error('The issued pass must have a scan code.');
  for (const secret of [
    HIDDEN,
    EMAIL,
    EXTERNAL,
    CACHED,
    AFTER,
    pass.scanCode,
    pass.authToken,
    pass.downloadToken,
    ...(!allowManager ? [MANAGER] : []),
  ])
    expect(text).not.toContain(secret);
}

export async function seedScan(options: SeedScan) {
  const id = kit.fx.ids.id();
  const at = kit.clock.advance(1000);
  await insertSeedScan(kit, templateId, options, id, at);
  return { id, at };
}

export const get = (path: string, headers = admin) =>
  Promise.resolve(app.request(`${ORIGIN}/api/v1/scans${path}`, { headers }, kit.env));

export async function expectInvalidCursor(path: string, headers = admin) {
  const response = await get(path, headers);
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'INVALID_CURSOR' });
}

export async function page(path: string, headers = admin): Promise<Page> {
  const response = await get(path, headers);
  expect(response.status).toBe(200);
  const data: Page = await response.json();
  z.union([ScanRecordListSchema, ScanFeedSchema]).parse(data);
  return data;
}

export const exportPath = (extra = '') =>
  `/export?orgId=${kit.org.id}&from=${kit.clock.now() - DAY}&to=${kit.clock.now() + DAY}${extra}`;

export async function lastExportCount() {
  const audit = await lastExportAudit(kit);
  expect(audit?.org_id).toBe(kit.org.id);
  return z.object({ rows: z.number().int() }).parse(JSON.parse(audit?.detail ?? '{}')).rows;
}
