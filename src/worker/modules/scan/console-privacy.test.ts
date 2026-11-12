import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeSession, makeUser, runOne } from '../../../../test/helpers/index.ts';
import { ScanRecordSchema } from '../../../shared/contracts/scanners.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { updatePass } from '../passes/service.ts';
import { buildKey as templateBuildKey } from '../templates/package/hash.ts';
import { adminActor } from './actor.ts';
import { recordedCheckIn } from './console-privacy-actions-test-fixtures.ts';
import {
  AFTER,
  admin,
  CACHED,
  EMAIL,
  EXTERNAL,
  expectNoSecrets,
  exportPath,
  fake,
  get,
  HIDDEN,
  insertVersion,
  kit,
  lastExportCount,
  MANAGER,
  PUBLIC,
  page,
  privatePass,
  seedScan,
  setupPrivacyKit,
  templateId,
} from './console-privacy-test-fixtures.ts';
import { historyPolicy } from './history-policy.ts';
import { scanInputVisible, scanValueSafe } from './projection-privacy.ts';
import { getScanRow } from './repo-feed.ts';
import { candidateById } from './repo-lookup.ts';
import { foundOf } from './resolve.ts';
import { grantScanMembership, ORIGIN } from './test-kit.ts';

setupPrivacyKit();

describe('scan action record projection', () => {
  it('enforces set, add and take source visibility while unsigned D1 records stay redacted', async () => {
    const base = await kit.registry.resolve(templateId, 'v1');
    const template = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      manifest: {
        ...base.manifest,
        name: 'Action projection card',
        inputs: {
          type: 'object',
          required: ['memberName'],
          properties: {
            memberName: { type: 'string', minLength: 1 },
            tier: { type: 'string', 'x-scan': 'manager' },
            points: { type: 'integer', 'x-scan': 'desk' },
            balance: { type: 'integer', 'x-scan': 'manager' },
          },
        },
        scan: {
          actions: [
            { id: 'check_in', label: 'Check in', kind: 'check_in' },
            { id: 'set_tier', label: 'Set tier', kind: 'set', input: 'tier' },
            { id: 'add_points', label: 'Add points', kind: 'add', input: 'points', amount: 31 },
            {
              id: 'take_balance',
              label: 'Take balance',
              kind: 'take',
              input: 'balance',
              amount: 47,
            },
          ],
        },
      },
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await run(
      kit.env.DB,
      `INSERT INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        template.id,
        kit.org.id,
        template.id,
        template.manifest.name,
        template.origin,
        template.version,
        kit.clock.now(),
        kit.clock.now(),
      ],
    );
    await insertVersion(template, await templateBuildKey(template));
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: template.id,
      version: template.version,
    });
    const pass = await kit.scanPass(template.id, {
      memberName: PUBLIC,
      tier: MANAGER,
      points: 31,
      balance: 47,
    });
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['org_admin']);
    const storedSession = await makeSession(kit.fx, { userId: user.id });
    const session = await createSessionStore(kit.env, kit.clock).resolve(storedSession.cookieValue);
    if (!session) throw new Error('The persisted session must resolve.');
    const actor = adminActor(session, 'live', {
      orgId: kit.org.id,
      templateIds: [],
      event: null,
      timeZone: 'UTC',
    });
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('The issued pass candidate must resolve.');
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('The issued pass policy must resolve.');
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [template.id],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const proven = await recordedCheckIn(scanner, pass.id);
    const provenRow = await getScanRow(kit.env.DB, proven.id, kit.clock.now(), 'live');
    const proof = provenRow?.eventProof;
    if (!proof?.eventPinnedManifest || !proof.eventActiveVersion || !proof.eventActiveManifest)
      throw new Error('The genuine check-in must expose its immutable policy proof.');
    for (const spec of [
      {
        id: 'set_tier',
        source: 'tier',
        kind: 'set' as const,
        value: MANAGER,
        amount: undefined,
        minimum: 'manager',
      },
      {
        id: 'add_points',
        source: 'points',
        kind: 'add' as const,
        value: 31,
        amount: 31,
        minimum: 'desk',
      },
      {
        id: 'take_balance',
        source: 'balance',
        kind: 'take' as const,
        value: 47,
        amount: 47,
        minimum: 'manager',
      },
    ]) {
      const seeded = await seedScan({
        scanner,
        passId: pass.id,
        templateId: template.id,
        passVersion: pass.version,
        actionId: spec.id,
        actionKind: spec.kind,
        amount: spec.amount,
        before: spec.value,
        after: spec.value,
      });
      const response = await get(`/${seeded.id}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: seeded.id,
        passId: null,
        templateId: null,
        actionId: null,
        before: null,
        after: null,
        amount: null,
      });
      for (const role of ['door', 'desk', 'manager'] as const) {
        const historical = await historyPolicy(kit.env, {
          event: proof.event,
          scan: proof.scan,
          currentPersonalization: proof.currentPersonalization,
          versionPersonalization: proof.versionPersonalization,
          currentCredentialGeneration: candidate.pass.credentialGeneration,
          transferPending: candidate.transferPending,
          credentialKeysetCommitment: found.credentialKeysetCommitment,
          eventPinned: {
            version: proof.scan.pinnedTemplateVersion,
            manifest: JSON.parse(proof.eventPinnedManifest),
          },
          eventActive: {
            version: proof.eventActiveVersion,
            manifest: JSON.parse(proof.eventActiveManifest),
          },
          currentPinned: { version: found.template.version, manifest: found.template.manifest },
          currentActive: {
            version: found.activeVersion,
            manifest: (found.activePolicy ?? found.activeTemplate ?? found.template).manifest,
          },
          role,
        });
        if (!historical) throw new Error('The genuine check-in policy proof must verify.');
        const viewer = { ...actor, role };
        const allowed = role === 'manager' || (role === 'desk' && spec.minimum === 'desk');
        expect(scanInputVisible(found, viewer, spec.source)).toBe(allowed);
        expect(scanValueSafe(found, spec.value, viewer)).toBe(allowed);
        expect(historical.inputVisible(spec.source)).toBe(allowed);
        expect(historical.valueSafe(spec.value)).toBe(allowed);
        expect(historical.action(spec.id, spec.kind)).toBeNull();
      }
    }
  });
});

describe('scan console and feed privacy', () => {
  it('projects a searchable public title, not cached identity or raw snapshots, across list, detail, CSV and API feed', async () => {
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await privatePass();
    const row = await recordedCheckIn(scanner, pass.id);
    const unproven = await seedScan({
      scanner,
      passId: pass.id,
      actionId: 'private_note',
      actionKind: 'set',
      before: HIDDEN,
      after: AFTER,
    });
    // Stored reason is an unconstrained string and must not become a pass-data channel.
    await run(kit.env.DB, 'UPDATE scans SET reason = ? WHERE id = ?', [HIDDEN, unproven.id]);
    const list = await page(`?orgId=${kit.org.id}`);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({
      id: unproven.id,
      passId: null,
      templateId: null,
      passTitle: null,
      reason: null,
      before: null,
      after: null,
      scannerId: null,
      scannerName: null,
      staffId: null,
      staffName: null,
      actor: { type: 'scanner', id: scanner.id },
    });
    expect(list.items[1]).toMatchObject({
      id: row.id,
      passId: pass.id,
      passTitle: PUBLIC,
      reason: null,
      before: null,
      after: null,
    });
    expectNoSecrets(list, pass);

    const detailResponse = await get(`/${row.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    ScanRecordSchema.parse(detail);
    expect(detail).toMatchObject({
      id: row.id,
      passId: pass.id,
      passTitle: PUBLIC,
      before: null,
      after: null,
    });
    expectNoSecrets(detail, pass);
    const unprovenDetail = await get(`/${unproven.id}`);
    expect(unprovenDetail.status).toBe(200);
    expect(await unprovenDetail.json()).toMatchObject({
      id: unproven.id,
      passId: null,
      templateId: null,
      passTitle: null,
      before: null,
      after: null,
      scannerId: null,
      scannerName: null,
      staffId: null,
      staffName: null,
      actor: { type: 'scanner', id: scanner.id },
    });

    const searched = await page(`?orgId=${kit.org.id}&q=${encodeURIComponent('public guest')}`);
    expect(searched.items.map((item) => item.id)).toEqual([row.id]);
    expectNoSecrets(searched, pass);
    for (const value of [CACHED, HIDDEN, MANAGER, EMAIL, EXTERNAL]) {
      expect((await page(`?orgId=${kit.org.id}&q=${encodeURIComponent(value)}`)).items).toEqual([]);
    }

    const apiKey = fake.apiKey({ orgId: kit.org.id, scopes: ['scans:read'] });
    const feed = await page('', apiKey);
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      id: unproven.id,
      passId: null,
      templateId: null,
      externalId: null,
      before: null,
      after: null,
    });
    expect(feed.items[1]).toMatchObject({
      id: row.id,
      passId: pass.id,
      externalId: null,
      kind: 'check_in',
      actionId: 'check_in',
      before: null,
      after: null,
    });
    expect(feed.items[0]).not.toHaveProperty('passTitle');
    expectNoSecrets(feed, pass);
    expect(JSON.stringify(feed)).not.toContain(PUBLIC);
    expect((await get('?q=Public', apiKey)).status).toBe(403);

    const csvResponse = await get(exportPath());
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get('content-type')).toContain('text/csv');
    const csv = await csvResponse.text();
    expect(csv).toContain(PUBLIC);
    expect(csv).toContain(new Date(row.at).toISOString());
    expect(csv).toContain(new Date(unproven.at).toISOString());
    expectNoSecrets(csv, pass);
    expect(await lastExportCount()).toBe(2);
  });

  it('binds each role’s historical title to an authenticated, non-plaintext event projection', async () => {
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    const pass = await privatePass();
    const original = await recordedCheckIn(scanner, pass.id);
    const missing = await recordedCheckIn(scanner, pass.id);
    const tampered = await recordedCheckIn(scanner, pass.id);
    const event = await first<{ data: string }>(
      kit.env.DB,
      "SELECT data FROM pass_events WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?",
      [pass.id, original.id],
    );
    if (!event) throw new Error('A recorded scan must have its pass event.');
    for (const value of [PUBLIC, HIDDEN, MANAGER, EMAIL, EXTERNAL])
      expect(event.data).not.toContain(value);
    const scannerRow = await first<{ name: string }>(
      kit.env.DB,
      'SELECT name FROM scanners WHERE id = ?',
      [scanner.id],
    );
    if (!scannerRow) throw new Error('The scanner must still exist.');
    expect(event.data).not.toContain(scannerRow.name);
    const roleProjection = z.object({ titleHash: z.string(), scannerNameHash: z.string() });
    const signedEvent = z
      .object({
        authority: z.object({
          eventProjection: z.object({
            v: z.literal(1),
            roles: z.object({
              door: roleProjection,
              desk: roleProjection,
              manager: roleProjection,
            }),
          }),
        }),
      })
      .parse(JSON.parse(event.data));
    const projection = signedEvent.authority.eventProjection;
    const hashes = (['door', 'desk', 'manager'] as const).map(
      (role) => projection.roles[role].titleHash,
    );
    expect(new Set(hashes).size).toBe(3);
    const scannerHashes = (['door', 'desk', 'manager'] as const).map(
      (role) => projection.roles[role].scannerNameHash,
    );
    expect(new Set(scannerHashes).size).toBe(3);

    const viewer = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, viewer.id, ['read_only']);
    const viewerHeaders = {
      ...(await makeSession(kit.fx, { userId: viewer.id })).headers,
      origin: ORIGIN,
    };
    for (const headers of [admin, viewerHeaders]) {
      const baseline = await page(`?orgId=${kit.org.id}&q=${encodeURIComponent(PUBLIC)}`, headers);
      expect(baseline.items.map((item) => item.id)).toEqual([tampered.id, missing.id, original.id]);
      expect(baseline.items.every((item) => item.passTitle === PUBLIC)).toBe(true);
    }
    // Without MACs each role's entry stands alone: the manager reads its own entry, the
    // read-only viewer the door's. Break both readers' title commitments.
    await runOne(
      kit.env.DB,
      `UPDATE pass_events SET data = json_remove(data,
        '$.authority.eventProjection.roles.door.titleHash',
        '$.authority.eventProjection.roles.manager.titleHash')
      WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?`,
      [pass.id, missing.id],
    );
    await runOne(
      kit.env.DB,
      `UPDATE pass_events SET data = json_set(data,
        '$.authority.eventProjection.roles.door.titleHash', ?,
        '$.authority.eventProjection.roles.manager.titleHash', ?)
      WHERE pass_id = ? AND json_extract(data, '$.scanId') = ?`,
      ['tampered-title-commitment', 'tampered-title-commitment', pass.id, tampered.id],
    );
    for (const headers of [admin, viewerHeaders]) {
      const history = await page(`?orgId=${kit.org.id}`, headers);
      for (const id of [missing.id, tampered.id])
        expect(history.items.find((item) => item.id === id)).toMatchObject({
          id,
          passId: null,
          passTitle: null,
          kind: null,
          actionId: null,
        });
      const searched = await page(`?orgId=${kit.org.id}&q=${encodeURIComponent(PUBLIC)}`, headers);
      expect(searched.items.map((item) => item.id)).toEqual([original.id]);
    }

    const changedTitle = 'Updated public guest';
    // A system edit republishes the pass: a job write.
    await updatePass(
      jobCtxOf(kit),
      { type: 'system', id: null },
      pass.id,
      { input: { memberName: changedTitle } },
      { scope: null },
    );
    for (const headers of [admin, viewerHeaders]) {
      const history = await page(`?orgId=${kit.org.id}`, headers);
      expect(history.items.find((item) => item.id === original.id)).toMatchObject({
        id: original.id,
        passId: pass.id,
        passTitle: null,
      });
      const detail = await get(`/${original.id}`, headers);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: original.id, passTitle: null });
      for (const title of [PUBLIC, changedTitle])
        expect(
          (await page(`?orgId=${kit.org.id}&q=${encodeURIComponent(title)}`, headers)).items,
        ).toEqual([]);
      const csv = await get(exportPath(), headers);
      expect(csv.status).toBe(200);
      const text = await csv.text();
      expect(text).not.toContain(PUBLIC);
      expect(text).not.toContain(changedTitle);
    }
    const updated = await recordedCheckIn(scanner, pass.id);
    const history = await page(`?orgId=${kit.org.id}`);
    expect(history.items.find((item) => item.id === updated.id)).toMatchObject({
      id: updated.id,
      passId: pass.id,
      passTitle: changedTitle,
    });
    expect(history.items.find((item) => item.id === original.id)).toMatchObject({
      passTitle: null,
    });
  });
});
