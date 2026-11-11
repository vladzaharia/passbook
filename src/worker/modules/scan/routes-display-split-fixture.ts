import { expect } from 'vitest';
import {
  type FakeAuth,
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
  type PassRow,
  persistTemplate,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { clearPreviewAudit } from './repo-routes-display-test-fixtures.ts';
import {
  display,
  EMAIL,
  ENCODED_SECRET,
  ESCAPED_SECRET,
  ORIGIN,
  PHONE,
  SECRET,
  seedPreviewRoutePasses,
} from './routes-display-split-seed-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

export interface PreviewRouteFixture {
  env: AppEnv;
  f: Fixtures;
  clock: ManualClock;
  fake: FakeAuth;
  userId: string;
  plainSession: SessionFixture;
  orgId: string;
  otherOrgId: string;
  template: ResolvedTemplate;
  templateId: string;
  otherTemplateId: string;
  wrongTemplateId: string;
  liveScanCode: string;
  live: PassRow;
  sandbox: PassRow;
  foreign: PassRow;
  admin(mode?: Mode): Record<string, string>;
  query(over?: Record<string, string>): Record<string, string> & {
    orgId: string;
    mode: string;
    templateId: string;
    passId: string;
    role: string;
  };
  preview(params: Record<string, string>, headers?: Record<string, string>): Promise<Response>;
}

export const noStore = (response: Response) =>
  expect(response.headers.get('cache-control')).toContain('no-store');

export async function createPreviewRouteFixture(): Promise<PreviewRouteFixture> {
  const clock = new ManualClock(Date.UTC(2026, 10, 5, 18));
  const env = await makeEnv();
  const f = fixtures(env, clock);
  const fake = fakeAuth(ORIGIN);
  const app = createApp({
    stores: { ...fake.stores, sessions: createSessionStore(env, clock) },
    clock,
  });
  await clearPreviewAudit(env.DB);
  const userId = (await makeUser(f)).id;
  const orgId = (await makeOrg(f)).id;
  const otherOrgId = (await makeOrg(f)).id;
  const adminSession = await makeSession(f, { userId, roles: ['admin', 'user'] });
  const plain = await makeUser(f);
  const plainSession = await makeSession(f, { userId: plain.id });
  await grantScanMembership(f, orgId, userId);
  await grantScanMembership(f, orgId, plain.id, ['integration_admin']);
  const templateFixture = makeTemplate({ id: f.ids.id(), orgId });
  const template = templateFixture.resolved;
  const templateId = template.id;
  template.manifest.inputs = {
    type: 'object',
    properties: {
      memberName: { type: 'string' },
      seat: { type: 'string' },
      tier: { type: 'string', 'x-scan': 'desk' },
      lounge: { type: 'string', 'x-scan': 'manager' },
      canVisit: { type: 'boolean' },
      profile: {
        type: 'object',
        properties: {
          publicLabel: { type: 'string' },
          managerHint: { type: 'string', 'x-scan': 'manager' },
          insideNote: { type: 'string', 'x-scan': 'hidden' },
          contactEmail: { type: 'string', format: 'email', 'x-scan': 'door' },
        },
      },
      privateNotes: { type: 'string', 'x-scan': 'hidden' },
      locked: { type: 'boolean', 'x-scan': 'hidden' },
      secretCount: { type: 'integer' },
      wifiPassword: { type: 'string' },
      contact: { type: 'string', format: 'email', 'x-scan': 'manager' },
      callback: { type: 'string', 'x-widget': 'tel', 'x-scan': 'door' },
      website: { type: 'string', format: 'uri', 'x-scan': 'door' },
      ticketNumber: { type: 'string' },
      unfinished: { type: 'string' },
    },
  };
  template.manifest.bindings = [
    { to: { field: 'name' }, value: '{{memberName}}' },
    { to: { field: 'seat' }, value: '{{seat}}' },
    { to: { field: 'tier' }, value: '{{tier}}' },
    { to: { field: 'lounge' }, value: '{{lounge}}' },
    { to: { field: 'nested_manager' }, value: '{{profile.managerHint}}' },
    { to: { field: 'nested_note' }, value: '{{profile.insideNote}}' },
    { to: { field: 'notes' }, value: '{{privateNotes}}' },
    { to: { field: 'locked' }, value: '{{locked}}' },
    { to: { field: 'count' }, value: '{{secretCount}}' },
    { to: { field: ['secret_a', 'secret_b'] }, value: '{{wifiPassword}}' },
    { to: { field: 'secret_html' }, value: '{{wifiPassword|html}}' },
    { to: { field: 'contact' }, value: '{{contact}}' },
    { to: { field: 'phone' }, value: '{{callback}}' },
    { to: { field: 'site' }, value: '{{website}}' },
    { to: { field: 'scan_ref' }, value: '{{pass.scanCode}}' },
    { to: { barcode: 0, prop: 'message' }, value: '{{ticketNumber}}' },
  ];
  template.manifest.display = {
    title: '{{memberName}}: {{wifiPassword}} / {{wifiPassword}}',
    subtitle: 'Note: {{privateNotes}}',
  };
  template.manifest.lookups = {
    directory: {
      public: { label: 'Atrium access' },
      [EMAIL]: { label: 'Contact key' },
      [PHONE]: { label: 'Phone key' },
      [SECRET]: { label: 'Secret key' },
      [ESCAPED_SECRET]: { label: 'Escaped key' },
      [ENCODED_SECRET]: { label: 'Encoded key' },
    },
  };
  template.manifest.scan = {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    display,
  };
  await persistTemplate(f, template, { registry: templateFixture.registry });
  const releaseFixture = {
    ctx: createServiceContext(env, { clock }),
    fx: f,
    org: { id: orgId },
    template,
    registry: templateFixture.registry,
  };
  await approveAppleRelease(releaseFixture, { mode: 'live' });
  await approveAppleRelease(releaseFixture, { mode: 'test' });

  const { live, sandbox, liveScanCode } = await seedPreviewRoutePasses(env, f, template, orgId);
  const otherTemplateFixture = makeTemplate({ id: f.ids.id(), orgId: otherOrgId });
  const otherTemplate = otherTemplateFixture.resolved;
  const otherTemplateId = otherTemplate.id;
  await persistTemplate(f, otherTemplate, { registry: otherTemplateFixture.registry });
  const foreign = await makePass(f, { orgId: otherOrgId, template: otherTemplate });
  const wrongTemplateFixture = makeTemplate({ id: f.ids.id(), orgId });
  const wrongTemplate = wrongTemplateFixture.resolved;
  const wrongTemplateId = wrongTemplate.id;
  await persistTemplate(f, wrongTemplate, { registry: wrongTemplateFixture.registry });

  const admin = (mode: Mode = 'live'): Record<string, string> => ({
    ...adminSession.headers,
    ...(mode === 'test' ? { 'x-passbook-mode': mode } : {}),
  });
  const query = (over: Record<string, string> = {}) => ({
    orgId,
    mode: 'live',
    templateId,
    passId: live.id,
    role: 'door',
    ...over,
  });
  const preview = (params: Record<string, string>, headers = admin()) =>
    Promise.resolve(
      app.request(
        `${ORIGIN}/api/v1/scan-display/preview?${new URLSearchParams(params)}`,
        { headers },
        env,
      ),
    );
  return {
    env,
    f,
    clock,
    fake,
    userId,
    plainSession,
    orgId,
    otherOrgId,
    template,
    templateId,
    otherTemplateId,
    wrongTemplateId,
    liveScanCode,
    live,
    sandbox,
    foreign,
    admin,
    query,
    preview,
  };
}
