import { beforeEach, describe, expect, it } from 'vitest';
import { makePass, makeTemplate, persistTemplate } from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { ScanDisplayScope } from '../../../passkit/template/scan-display/index.ts';
import { ScanDisplayPreviewSchema } from '../../../shared/contracts/scan-display-preview.ts';
import { first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { readReleaseAsset } from '../templates/release-content.ts';
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
  it('applies both the active and pinned template visibility to an older pass', async () => {
    const { templateId, orgId, template, f, env, clock, preview, query } = fixture;
    const next = makeTemplate({ id: templateId, orgId, version: 'v2' });
    const active: ResolvedTemplate = next.resolved;
    active.passJson = template.passJson;
    active.manifest = {
      ...template.manifest,
      inputs: {
        ...template.manifest.inputs,
        properties: {
          ...template.manifest.inputs.properties,
          seat: { type: 'string', 'x-scan': 'manager' },
          tier: { type: 'string', 'x-scan': 'hidden' },
          lounge: { type: 'string', 'x-scan': 'door' },
        },
      },
      display: { title: '{{seat}}' },
    };
    await persistTemplate(f, active, { registry: next.registry });
    const stored = await first<{ assets: string }>(
      env.DB,
      'SELECT assets FROM template_versions WHERE template_id = ? AND version = ?',
      [templateId, active.version],
    );
    if (!stored) throw new Error('Missing persisted preview template version');
    const assets = JSON.parse(stored.assets) as ResolvedTemplate['assets'];
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.map((asset) => asset.name)).toEqual(active.assets.map((asset) => asset.name));
    const ctx = createServiceContext(env, { clock });
    for (const asset of assets) {
      expect(asset.source.kind).toBe('r2');
      const fromRegistry = new Uint8Array(
        await new Response(await next.registry.openAsset(active, asset.name)).arrayBuffer(),
      );
      expect(await readReleaseAsset(ctx, asset)).toEqual(fromRegistry);
    }
    await approveAppleRelease(
      { ctx, fx: f, registry: next.registry },
      { orgId, templateId, version: 'v2', mode: 'live' },
    );
    for (const role of ['door', 'desk', 'manager'] as const) {
      const response = await preview(query({ role }));
      expect(response.status).toBe(200);
      noStore(response);
      const { scope } = (await response.json()) as { scope: ScanDisplayScope };
      const inputs = scope.inputs as Record<string, unknown>;
      const fields = scope.fields as Record<string, unknown>;
      for (const object of [inputs, fields]) {
        expect(object).not.toHaveProperty('tier');
        if (role === 'manager') {
          expect(object).toMatchObject({ seat: 'C12', lounge: 'Roof lounge' });
        } else {
          expect(object).not.toHaveProperty('seat');
          expect(object).not.toHaveProperty('lounge');
        }
      }
      if (role === 'manager') expect(scope.pass).toHaveProperty('title', 'C12');
      const text = JSON.stringify(scope);
      expect(text).not.toContain('Gold');
      if (role !== 'manager') {
        expect(text).not.toContain('C12');
        expect(text).not.toContain('Roof lounge');
      }
    }
  });

  it('protects an absent pinned hidden default from newer preview metadata and lookups', async () => {
    const { f, orgId, env, clock, preview, query } = fixture;
    const protectedDefault = 'CONFIDENTIAL-ORCHID';
    const pinned = makeTemplate({ id: f.ids.id(), orgId, version: 'v1' });
    pinned.resolved.manifest.inputs = {
      type: 'object',
      properties: {
        memberName: { type: 'string' },
        internalNote: { type: 'string', 'x-scan': 'hidden', default: protectedDefault },
      },
    };
    await persistTemplate(f, pinned.resolved, { registry: pinned.registry });
    await approveAppleRelease(
      { ctx: createServiceContext(env, { clock }), fx: f, registry: pinned.registry },
      { orgId, templateId: pinned.resolved.id, version: 'v1', mode: 'live' },
    );
    const pass = await makePass(f, {
      orgId,
      template: pinned.resolved,
      personalization: { memberName: 'Public visitor' },
    });
    const identity = await first<{ pass_type_identifier: string; team_identifier: string }>(
      env.DB,
      `SELECT si.pass_type_identifier, si.team_identifier FROM passes p
       JOIN signing_identities si ON si.id = p.identity_id WHERE p.id = ?`,
      [pass.id],
    );
    if (!identity) throw new Error('Missing pass signing identity');
    await run(env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ? AND version = 1', [
      JSON.stringify({
        ...pinned.resolved.passJson,
        serialNumber: pass.serial,
        passTypeIdentifier: identity.pass_type_identifier,
        teamIdentifier: identity.team_identifier,
        authenticationToken: pass.authToken,
      }),
      pass.id,
    ]);
    const next = makeTemplate({ id: pinned.resolved.id, orgId, version: 'v2' });
    next.resolved.passJson = pinned.resolved.passJson;
    next.resolved.manifest = {
      ...pinned.resolved.manifest,
      name: protectedDefault,
      display: { title: 'Welcome {{memberName}}' },
      inputs: {
        type: 'object',
        properties: {
          memberName: { type: 'string' },
          internalNote: { type: 'string', 'x-scan': 'hidden' },
        },
      },
      lookups: { directory: { public: { label: protectedDefault } } },
    };
    await persistTemplate(f, next.resolved, { registry: next.registry });
    await approveAppleRelease(
      { ctx: createServiceContext(env, { clock }), fx: f, registry: next.registry },
      { orgId, templateId: pinned.resolved.id, version: 'v2', mode: 'live' },
    );
    const response = await preview(
      query({ templateId: pinned.resolved.id, passId: pass.id, role: 'manager' }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(protectedDefault);
    const body = ScanDisplayPreviewSchema.parse(JSON.parse(text));
    expect(body.scope.inputs).toHaveProperty('memberName', 'Public visitor');
    expect(body.scope.pass).toHaveProperty('title', 'Welcome Public visitor');
  });

  it('does not expose a lookup-derived field when its pinned selector is manager-only', async () => {
    const { templateId, orgId, template, f, env, clock, live, preview, query } = fixture;
    const next = makeTemplate({ id: templateId, orgId, version: 'v2' });
    const active = next.resolved;
    active.passJson = template.passJson;
    active.manifest = {
      ...template.manifest,
      inputs: {
        ...template.manifest.inputs,
        properties: {
          ...template.manifest.inputs.properties,
          lounge: { type: 'string', 'x-scan': 'door' },
        },
      },
      lookups: {
        ...template.manifest.lookups,
        directory: {
          ...template.manifest.lookups?.directory,
          'Roof lounge': { label: 'Observatory access' },
        },
      },
      display: { title: '{{lookups.directory[lounge].label}}' },
      bindings: [
        ...template.manifest.bindings,
        { to: { field: 'mapped_access' }, value: '{{lookups.directory[lounge].label}}' },
      ],
    };
    await persistTemplate(f, active, { registry: next.registry });
    await approveAppleRelease(
      { ctx: createServiceContext(env, { clock }), fx: f, registry: next.registry },
      { orgId, templateId, version: 'v2', mode: 'live' },
    );
    await run(
      env.DB,
      `UPDATE pass_versions
       SET pass_json = json_insert(pass_json, '$.generic.secondaryFields[#]',
         json_object('key', 'mapped_access', 'value', 'Observatory access'))
       WHERE pass_id = ? AND version = 1`,
      [live.id],
    );
    const door = await preview(query());
    expect(door.status).toBe(200);
    const doorText = await door.text();
    expect(doorText).not.toContain('Observatory access');
    const doorBody = ScanDisplayPreviewSchema.parse(JSON.parse(doorText));
    expect(doorBody.scope.fields).not.toHaveProperty('mapped_access');
    const manager = await preview(query({ role: 'manager' }));
    expect(manager.status).toBe(200);
    const body = ScanDisplayPreviewSchema.parse(await manager.json());
    expect(body.scope.fields).toHaveProperty('mapped_access', 'Observatory access');
    expect(body.scope.pass).toHaveProperty('title', 'Observatory access');
  });
});
