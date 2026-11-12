import { describe, expect, it } from 'vitest';
import {
  makePass,
  makeScanner,
  makeTemplate,
  materializeTemplateAssets,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import {
  app,
  ctx,
  env,
  f,
  liveReleaseId,
  ORIGIN,
  orgId,
  passId,
  type Rec,
  recordedAction,
  recordVersion,
  seed,
  template,
} from './repo-scans-split-test-fixtures.ts';

describe('scanner recent and summary privacy', () => {
  const scannerGet = (headers: Record<string, string>, path: string) =>
    app.request(`${ORIGIN}/api/v1/scan${path}`, { headers }, env);
  const own = (id: string) => ({ scanner_id: id, actor_id: id, actor_key: `s:${id}` });

  it('shows only role-authorized titles and action amounts, and never raw contact values', async () => {
    const restricted = makeTemplate({ id: f.ids.id(), orgId });
    Object.assign(restricted.resolved.manifest, {
      inputs: {
        type: 'object',
        properties: {
          memberName: { type: 'string', 'x-scan': 'desk' },
          balance: { type: 'integer', 'x-scan': 'desk' },
        },
      },
      scan: {
        actions: [
          { id: 'private_entry', label: 'Private entry', kind: 'check_in' },
          { id: 'pay', label: 'Pay', kind: 'take', input: 'balance', amount: 1 },
        ],
      },
    });
    await persistTemplate(f, restricted.resolved, { registry: restricted.registry });
    const restrictedRelease = await approveAppleRelease(
      { ctx, fx: f, registry: restricted.registry },
      {
        orgId,
        mode: 'live',
        templateId: restricted.resolved.id,
        version: restricted.resolved.version,
      },
    );
    const privatePass = await makePass(f, {
      orgId,
      template: restricted.resolved,
      personalization: { memberName: 'Private Name', balance: 50 },
    });
    const contactPass = await makePass(f, {
      orgId,
      template: template.resolved,
      personalization: { memberName: 'private@example.test' },
    });
    await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
      restrictedRelease.id,
      privatePass.id,
    ]);
    await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
      liveReleaseId,
      contactPass.id,
    ]);
    await recordVersion(privatePass.id);
    await recordVersion(contactPass.id);
    await run(env.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [
      'Private Name',
      privatePass.id,
    ]);
    await run(env.DB, 'UPDATE passes SET display_title = ? WHERE id = ?', [
      'private@example.test',
      contactPass.id,
    ]);
    const scanner = await makeScanner(f, {
      orgId,
      templateIds: [template.resolved.id, restricted.resolved.id],
    });
    const publicScan = await recordedAction(scanner, passId);
    const hiddenScan = await seed({
      ...own(scanner.id),
      pass_id: privatePass.id,
      pass_version: 1,
      template_id: restricted.resolved.id,
      action_id: 'pay',
      action_kind: 'take',
      amount: 27,
    });
    const privateScan = await recordedAction(scanner, privatePass.id, 'private_entry');
    const contactScan = await recordedAction(scanner, contactPass.id);

    const recent = (await (await scannerGet(scanner.headers, '/scans')).json()) as { items: Rec[] };
    expect(recent.items.find((r) => r.scanId === publicScan.id)).toMatchObject({
      title: 'Alex Morgan',
      actionLabel: 'Let in',
    });
    expect(recent.items.find((r) => r.scanId === hiddenScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Scan',
    });
    expect(recent.items.find((r) => r.scanId === privateScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Private entry',
    });
    expect(recent.items.find((r) => r.scanId === contactScan.id)?.title).toBeNull();
    const summary = (await (await scannerGet(scanner.headers, '/summary')).json()) as Rec;
    expect(summary).toMatchObject({ total: 4, ok: 4 });
    expect(summary.byAction).toEqual([]);

    await run(
      env.DB,
      "UPDATE scanners SET settings = json_set(settings, '$.roleWithoutSignIn', 'desk') WHERE id = ?",
      [scanner.id],
    );
    const deskRecent = (await (await scannerGet(scanner.headers, '/scans')).json()) as {
      items: Rec[];
    };
    expect(deskRecent.items.find((r) => r.scanId === hiddenScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Scan',
    });
    // An event records each role's view only up to the recorder's role (event-safe-projection),
    // so a scan recorded at the door keeps the door's view after the scanner is raised to desk.
    expect(deskRecent.items.find((r) => r.scanId === privateScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Private entry',
    });
    const deskPass = await makePass(f, {
      orgId,
      template: restricted.resolved,
      personalization: { memberName: 'Desk Name', balance: 5 },
    });
    await run(env.DB, 'UPDATE passes SET release_id = ?, display_title = ? WHERE id = ?', [
      restrictedRelease.id,
      'Desk Name',
      deskPass.id,
    ]);
    await recordVersion(deskPass.id);
    const deskScanner = await makeScanner(f, {
      orgId,
      templateIds: [restricted.resolved.id],
      settings: { roleWithoutSignIn: 'desk' },
    });
    const deskScan = await recordedAction(deskScanner, deskPass.id, 'private_entry');
    const deskOwn = (await (await scannerGet(deskScanner.headers, '/scans')).json()) as {
      items: Rec[];
    };
    expect(deskOwn.items.find((r) => r.scanId === deskScan.id)).toMatchObject({
      title: 'Desk Name',
      actionLabel: 'Private entry',
    });
    expect(deskRecent.items.find((r) => r.scanId === contactScan.id)?.title).toBeNull();
    const deskSummary = (await (await scannerGet(scanner.headers, '/summary')).json()) as Rec;
    expect(deskSummary.byAction).toEqual([]);

    const tightened = makeTemplate({ id: restricted.resolved.id, orgId, version: 'v2' });
    Object.assign(tightened.resolved.manifest, {
      inputs: {
        type: 'object',
        properties: {
          memberName: { type: 'string', 'x-scan': 'hidden' },
          balance: { type: 'integer', 'x-scan': 'hidden' },
        },
      },
      scan: {
        actions: [
          { id: 'private_entry', label: 'Private entry', kind: 'check_in' },
          { id: 'pay', label: 'Pay', kind: 'take', input: 'balance', amount: 1 },
        ],
      },
    });
    await persistTemplate(f, tightened.resolved, { registry: tightened.registry });
    await approveAppleRelease(
      { ctx, fx: f, registry: tightened.registry },
      {
        orgId,
        mode: 'live',
        templateId: tightened.resolved.id,
        version: tightened.resolved.version,
      },
    );
    const unknownKeyRecent = (await (await scannerGet(scanner.headers, '/scans')).json()) as {
      items: Rec[];
    };
    expect(unknownKeyRecent.items.find((r) => r.scanId === hiddenScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Scan',
    });
    // Policy follows the head whatever its build: the action survives, the now-hidden title does not.
    expect(unknownKeyRecent.items.find((r) => r.scanId === privateScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Private entry',
    });
    const unknownKeySummary = (await (await scannerGet(scanner.headers, '/summary')).json()) as Rec;
    expect(unknownKeySummary).toMatchObject({ total: 4, ok: 4 });
    expect(unknownKeySummary.byAction).toEqual([]);
    for (const copy of [
      { source: restricted, version: 'v3', key: 'same-build' },
      { source: tightened, version: 'v4', key: 'same-build' },
      { source: tightened, version: 'v5', key: 'different-build' },
    ]) {
      const bytes = Object.fromEntries(
        await Promise.all(
          copy.source.resolved.assets.map(
            async (asset) =>
              [
                asset.name,
                new Uint8Array(
                  await new Response(
                    await copy.source.registry.openAsset(copy.source.resolved, asset.name),
                  ).arrayBuffer(),
                ),
              ] as const,
          ),
        ),
      );
      const resolved = copy.source.registry.add({
        id: copy.source.resolved.id,
        orgId: copy.source.resolved.orgId,
        version: copy.version,
        manifest: copy.source.resolved.manifest,
        passJson: copy.source.resolved.passJson,
        assets: bytes,
      });
      const assets = await materializeTemplateAssets(f, resolved, copy.source.registry);
      await run(
        env.DB,
        `INSERT INTO template_versions
        (template_id,version,manifest,pass_json,assets,report,created_by,created_at,build_key)
        SELECT template_id,?,manifest,pass_json,?,report,created_by,created_at,?
        FROM template_versions WHERE template_id=? AND version=?`,
        [
          copy.version,
          JSON.stringify(assets),
          copy.key,
          restricted.resolved.id,
          copy.source.resolved.version,
        ],
      );
    }
    const thirdRelease = await approveAppleRelease(
      { ctx, fx: f, registry: restricted.registry },
      { orgId, mode: 'live', templateId: restricted.resolved.id, version: 'v3' },
    );
    await run(env.DB, "UPDATE passes SET template_version='v3', release_id=? WHERE id=?", [
      thirdRelease.id,
      privatePass.id,
    ]);
    await approveAppleRelease(
      { ctx, fx: f, registry: tightened.registry },
      { orgId, mode: 'live', templateId: restricted.resolved.id, version: 'v4' },
    );
    const tightenedRecent = (await (await scannerGet(scanner.headers, '/scans')).json()) as {
      items: Rec[];
    };
    expect(tightenedRecent.items.find((r) => r.scanId === hiddenScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Scan',
    });
    expect(tightenedRecent.items.find((r) => r.scanId === privateScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Private entry',
    });
    const tightenedSummary = (await (await scannerGet(scanner.headers, '/summary')).json()) as Rec;
    expect(tightenedSummary).toMatchObject({ total: 4, ok: 4 });
    expect(tightenedSummary.byAction).toEqual([]);
    await approveAppleRelease(
      { ctx, fx: f, registry: tightened.registry },
      { orgId, mode: 'live', templateId: restricted.resolved.id, version: 'v5' },
    );
    const differentKeyRecent = (await (await scannerGet(scanner.headers, '/scans')).json()) as {
      items: Rec[];
    };
    expect(differentKeyRecent.items.find((r) => r.scanId === hiddenScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Scan',
    });
    expect(differentKeyRecent.items.find((r) => r.scanId === privateScan.id)).toMatchObject({
      title: null,
      actionLabel: 'Private entry',
    });
    const differentKeySummary = (await (
      await scannerGet(scanner.headers, '/summary')
    ).json()) as Rec;
    expect(differentKeySummary).toMatchObject({ total: 4, ok: 4 });
    expect(differentKeySummary.byAction).toEqual([]);
  });

  it('checks the recorded and current template policies before adding historical amounts', async () => {
    const original = makeTemplate({ id: f.ids.id(), orgId });
    Object.assign(original.resolved.manifest, {
      inputs: {
        type: 'object',
        properties: {
          memberName: { type: 'string' },
          balance: { type: 'integer', 'x-scan': 'desk' },
        },
      },
      scan: { actions: [{ id: 'pay', label: 'Pay', kind: 'take', input: 'balance', amount: 1 }] },
    });
    await persistTemplate(f, original.resolved, { registry: original.registry });
    const originalRelease = await approveAppleRelease(
      { ctx, fx: f, registry: original.registry },
      { orgId, mode: 'live', templateId: original.resolved.id, version: original.resolved.version },
    );
    const pass = await makePass(f, {
      orgId,
      template: original.resolved,
      personalization: { memberName: 'Alex Morgan', balance: 40 },
    });
    await run(env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
      originalRelease.id,
      pass.id,
    ]);
    await recordVersion(pass.id);
    const scanner = await makeScanner(f, { orgId, templateIds: [original.resolved.id] });
    const transaction = {
      ...own(scanner.id),
      pass_id: pass.id,
      template_id: original.resolved.id,
      action_id: 'pay',
      action_kind: 'take',
    };
    await seed({ ...transaction, pass_version: 1, amount: 13 });

    const newer = makeTemplate({ id: original.resolved.id, orgId, version: 'v2' });
    Object.assign(newer.resolved.manifest, {
      inputs: {
        type: 'object',
        properties: { memberName: { type: 'string' }, balance: { type: 'integer' } },
      },
      scan: { actions: [{ id: 'pay', label: 'Pay', kind: 'take', input: 'balance', amount: 1 }] },
    });
    await persistTemplate(f, newer.resolved, { registry: newer.registry });
    const newerRelease = await approveAppleRelease(
      { ctx, fx: f, registry: newer.registry },
      { orgId, mode: 'live', templateId: newer.resolved.id, version: newer.resolved.version },
    );
    await run(
      env.DB,
      "UPDATE passes SET template_version = 'v2', release_id = ?, version = 2, object_key = object_key || '-v2' WHERE id = ?",
      [newerRelease.id, pass.id],
    );
    await recordVersion(pass.id);
    await seed({ ...transaction, pass_version: 2, amount: 7 });
    await seed({ ...transaction, pass_version: null, amount: 33 });

    const res = await scannerGet(scanner.headers, '/summary');
    expect(res.status).toBe(200);
    const summary = (await res.json()) as Rec;
    expect(summary).toMatchObject({ total: 3, ok: 3 });
    expect(summary.byAction).toEqual([]);
    const visibleScanner = await makeScanner(f, { orgId, templateIds: [original.resolved.id] });
    await seed({ ...transaction, ...own(visibleScanner.id), pass_version: 2, amount: 7 });
    const visible = await scannerGet(visibleScanner.headers, '/summary');
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      total: 1,
      ok: 1,
      byAction: [],
    });
  });
});
