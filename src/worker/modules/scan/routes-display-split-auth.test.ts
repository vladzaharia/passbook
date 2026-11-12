import { beforeEach, describe, expect, it } from 'vitest';
import type { ScanRole } from '../../../passkit/types.ts';
import { all } from '../../platform/db.ts';
import {
  createPreviewRouteFixture,
  noStore,
  type PreviewRouteFixture,
} from './routes-display-split-fixture.ts';

let fixture: PreviewRouteFixture;

beforeEach(async () => {
  fixture = await createPreviewRouteFixture();
});

describe('real-pass scan display preview', () => {
  it('requires an authorized session and every explicit query parameter', async () => {
    const { plainSession, fake, preview, query } = fixture;
    for (const [headers, status] of [
      [{}, 401],
      [plainSession.headers, 403],
      [fake.apiKey(), 401],
      [fake.scanner({ transport: 'bearer' }), 401],
    ] as const) {
      const response = await preview(query(), headers);
      expect(response.status).toBe(status);
      noStore(response);
    }
    for (const key of ['orgId', 'mode', 'templateId', 'passId', 'role']) {
      const params: Record<string, string> = query();
      delete params[key];
      const response = await preview(params);
      expect(response.status).toBe(422);
      noStore(response);
    }
    for (const params of [query({ mode: 'other' }), query({ role: 'customer' })]) {
      const response = await preview(params);
      expect(response.status).toBe(422);
      noStore(response);
    }
  });

  it('uses the admin mode header and rejects a mismatched requested mode', async () => {
    const { sandbox, preview, query, admin } = fixture;
    const testQuery = query({ mode: 'test', passId: sandbox.id });
    const testResponse = await preview(testQuery, { ...admin(), 'x-passbook-mode': 'TEST' });
    expect(testResponse.status).toBe(200);
    noStore(testResponse);
    for (const [params, headers] of [
      [testQuery, admin()],
      [query(), admin('test')],
    ] as const) {
      const response = await preview(params, headers);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      noStore(response);
      expect(await response.text()).not.toContain('Morgan');
    }
  });

  it('makes foreign, unknown, wrong-template and wrong-pass-mode requests indistinguishable', async () => {
    const {
      f,
      foreign,
      otherTemplateId,
      otherOrgId,
      wrongTemplateId,
      sandbox,
      preview,
      query,
      admin,
    } = fixture;
    const cases = [
      query({ passId: f.ids.id() }),
      query({ templateId: f.ids.id() }),
      query({ orgId: f.ids.id() }),
      query({ passId: foreign.id }),
      query({ passId: foreign.id, templateId: otherTemplateId }),
      query({ templateId: otherTemplateId }),
      query({ orgId: otherOrgId }),
      query({ templateId: wrongTemplateId }),
      query({ passId: sandbox.id }),
      query({ mode: 'test' }),
    ];
    const problems: unknown[] = [];
    for (const params of cases) {
      const response = await preview(params, admin(params.mode === 'test' ? 'test' : 'live'));
      expect(response.status).toBe(404);
      noStore(response);
      const body = (await response.json()) as { requestId?: string };
      delete body.requestId;
      problems.push(body);
    }
    expect(problems).toEqual(cases.map(() => problems[0]));
  });

  it('audits the successful preview with only IDs and role in its detail', async () => {
    const { env, userId, orgId, templateId, live, preview, query } = fixture;
    const role: ScanRole = 'manager';
    const response = await preview(query({ role }));
    expect(response.status).toBe(200);
    const rows = await all<{
      org_id: string;
      actor_type: string;
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      detail: string | null;
    }>(
      env.DB,
      "SELECT org_id, actor_type, actor_id, action, target_type, target_id, detail FROM audit_log WHERE action = 'scan_display.preview'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: orgId,
      actor_type: 'user',
      actor_id: userId,
      action: 'scan_display.preview',
      target_type: 'pass',
      target_id: live.id,
    });
    const detail = JSON.parse(rows[0]?.detail ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({ templateId, role });
    expect(
      Object.keys(detail).filter((key) => !['orgId', 'templateId', 'passId', 'role'].includes(key)),
    ).toEqual([]);
    if ('orgId' in detail) expect(detail.orgId).toBe(orgId);
    if ('passId' in detail) expect(detail.passId).toBe(live.id);
  });
});
