import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { setTemplateStatus } from '../templates/testing.ts';
import { act } from './act.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { liveAttachment, publishScan, scanHub } from './live.ts';
import type { LiveAttachment } from './live-auth.ts';
import { getScanner, scannerEpochsOf } from './repo-device.ts';
import type { Candidate } from './repo-lookup.ts';
import { updateScannerStmt } from './repo-scanners-test-support.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';
import { undo } from './undo.ts';

let kit: ScanKit;
let template: string;
const system = { type: 'system' as const, id: null };
const png = makePng(270, 270);
const encoded = btoa(String.fromCharCode(...png));

beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Live asset lineage', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function setup() {
  const source = await kit.scanner({ templateIds: [template] });
  const monitor = await kit.scanner({ deviceRole: 'monitor' });
  await setSetupWatchStmt(kit.env.DB, kit.org.id, monitor.id, {
    scannerIds: [source.id],
    allOrg: false,
  }).run();
  const attachment = liveAttachment(kit.ctx, await assetActorFor(kit, monitor));
  const actor = await assetActorFor(kit, source);
  const pass = await kit.scanPass(template, { memberName: 'LIVE-PRIVATE-MEMBER' });
  await putMemberPhoto(jobCtxOf(kit), system, pass.id, { png: encoded, includeInPass: true }, null);
  const result = await resolveOutcome(kit.ctx, actor, {
    idempotencyKey: key(),
    input: codeOf(pass),
    clientTs: kit.clock.now(),
  });
  if (
    !result.evaluatedSnapshot ||
    !result.credentialContext ||
    result.outcome.card?.passId !== pass.id
  )
    throw new Error('Missing evaluated pass authority');
  expect(result.credentialContext.credentialKeysetCommitment).toBe(
    result.evaluatedSnapshot.credentialKeysetCommitment,
  );
  expect(result.credentialContext.credentialTombstoneRefs).toEqual(
    result.evaluatedSnapshot.credentialTombstoneRefs,
  );
  expect(result.credentialContext.otherModeCredentialTombstoneRefs).toEqual(
    result.evaluatedSnapshot.otherModeCredentialTombstoneRefs,
  );
  return { actor, pass, source, monitor, attachment, result };
}

async function publishedRows(fixture: { attachment: LiveAttachment; source: { id: string } }) {
  await kit.settle();
  const hub = scanHub(kit.ctx, kit.org.id, 'live');
  const snapshot = await hub.snapshot(fixture.attachment);
  return snapshot.rows.filter((row) => row.scannerId === fixture.source.id);
}

describe('live scanner evaluated asset lineage', () => {
  it('seals the original evaluation and invalidates its URL when the source changes', async () => {
    const fixture = await setup();
    const { actor, pass, source, monitor, result } = fixture;
    expect(result.evaluatedSnapshot).toMatchObject({
      pass: {
        id: pass.id,
        credentialGeneration: expect.any(Number),
        lifecycleGeneration: expect.any(Number),
        imageGeneration: expect.any(Number),
      },
      orgRevision: expect.any(Number),
      transferPending: false,
      templateRevision: expect.any(Number),
      displayTemplateVersion: expect.any(String),
      activeReleaseId: expect.any(String),
      activeReleaseGeneration: expect.any(Number),
      activeReleaseVersion: expect.any(String),
      activeReleaseCandidateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.outcome).not.toHaveProperty('evaluatedSnapshot');
    expect(result.outcome).not.toHaveProperty('credentialContext');
    const dto = JSON.stringify(result.outcome);
    expect(dto).not.toMatch(
      /orgRevision|templateRevision|connectionGeneration|displayTemplateVersion|activeRelease|tenantAuthority|credentialGeneration|lifecycleGeneration|imageGeneration|transferPending|identityRevision|walletVersion|walletTemplateVersion|versionPersonalization|credentialTombstoneRefs|credentialKeysetCommitment|assetPhoto|photoGrant|guardSql|guardParams|tokenHash/,
    );
    expect(dto).not.toContain(actor.scanner?.tokenHash ?? 'missing-token');
    publishScan(
      kit.ctx,
      actor,
      result.outcome,
      result.evaluatedSnapshot,
      result.credentialContext,
      'camera',
    );
    const [row] = await publishedRows(fixture);
    expect(row).toMatchObject({ passId: pass.id, holder: 'LIVE-PRIVATE-MEMBER' });
    if (!row?.photoUrl) throw new Error('Authorized live photo is missing');
    const url = new URL(row.photoUrl, 'https://wallet.test');
    expect([...url.searchParams.keys()].sort()).toEqual(['event', 'g']);
    expect(row.photoUrl).not.toContain('LIVE-PRIVATE-MEMBER');
    expect(row.photoUrl).not.toContain(actor.scanner?.tokenHash ?? 'missing-token');
    const keyset = result.evaluatedSnapshot?.credentialKeysetCommitment;
    if (!keyset) throw new Error('Missing captured credential keyset');
    expect(keyset).toMatch(/^[a-f0-9]{64}$/);
    expect(dto).not.toContain(keyset);
    expect(row.photoUrl).not.toContain(keyset);
    for (const ref of [
      ...result.credentialContext!.credentialTombstoneRefs,
      ...result.credentialContext!.otherModeCredentialTombstoneRefs,
    ]) {
      expect(dto).not.toContain(ref);
      expect(row.photoUrl).not.toContain(ref);
    }
    const path = url.pathname.replace('/api/v1/scan', '') + url.search;
    const image = await kit.get(monitor.headers, path);
    expect(image.status).toBe(200);
    expect(image.headers.get('cache-control')).toBe('private, no-store');
    expect(image.headers.get('etag')).toBeNull();
    await image.arrayBuffer();
    const scanner = await getScanner(kit.env.DB, source.id);
    if (!scanner) throw new Error('Scanner fixture missing');
    // A rename and its reversal touch only labels: the URL still serves.
    await updateScannerStmt(
      kit.env.DB,
      source.id,
      { name: 'Temporary source' },
      kit.clock.now(),
    ).run();
    await updateScannerStmt(kit.env.DB, source.id, { name: scanner.name }, kit.clock.now()).run();
    expect((await kit.get(monitor.headers, path)).status).toBe(200);
    // A configuration change moves the source's config epoch and ends it.
    await run(kit.env.DB, "UPDATE scanners SET time_zone = 'Pacific/Honolulu' WHERE id=?", [
      source.id,
    ]);
    const stale = await kit.get(monitor.headers, path);
    expect(stale.status).toBe(404);
    expect(await stale.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    expect(await publishedRows(fixture)).toEqual([]);
  });

  it('carries the original evaluation alongside a committed check-in, not in its DTO', async () => {
    const fixture = await setup();
    const result = await act(kit.ctx, fixture.actor, {
      input: codeOf(fixture.pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    if (!result.evaluatedSnapshot || !result.credentialContext)
      throw new Error('Missing action authority');
    expect(result.evaluatedSnapshot?.pass.id).toBe(fixture.pass.id);
    expect(result.outcome).not.toHaveProperty('evaluatedSnapshot');
    publishScan(
      kit.ctx,
      fixture.actor,
      result.outcome,
      result.evaluatedSnapshot,
      result.credentialContext,
      'camera',
    );
    const [row] = await publishedRows(fixture);
    expect(row).toMatchObject({ passId: fixture.pass.id, holder: 'LIVE-PRIVATE-MEMBER' });
    expect(row?.photoUrl).toBeTruthy();
  });

  it('carries the original target evaluation through undo publication', async () => {
    const fixture = await setup();
    const checked = await act(kit.ctx, fixture.actor, {
      input: codeOf(fixture.pass),
      actionId: 'auto',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    if (!checked.outcome.scanId) throw new Error('Check-in fixture missing');
    // Undo is granted to the actor the guard captured; this fixture builds its own.
    const sourceRow = await getScanner(kit.env.DB, fixture.source.id);
    if (!sourceRow) throw new Error('Scanner fixture is missing');
    await captureScanEpochs(kit.env.DB, fixture.actor, scannerEpochsOf(sourceRow));
    const result = await undo(kit.ctx, fixture.actor, checked.outcome.scanId, {
      idempotencyKey: key(),
    });
    if (!result.evaluatedSnapshot || !result.credentialContext)
      throw new Error('Missing undo authority');
    expect(result.evaluatedSnapshot?.pass.id).toBe(fixture.pass.id);
    expect(result.outcome).not.toHaveProperty('evaluatedSnapshot');
    publishScan(
      kit.ctx,
      fixture.actor,
      result.outcome,
      result.evaluatedSnapshot,
      result.credentialContext,
      'manual',
      true,
    );
    const [row] = await publishedRows(fixture);
    expect(row).toMatchObject({
      kind: 'undo',
      passId: fixture.pass.id,
      holder: 'LIVE-PRIVATE-MEMBER',
    });
    expect(row?.photoUrl).toBeTruthy();
  });

  // An archived template keeps its passes: its status is no policy change for an evaluation.
  it('keeps an evaluation after the template status changes away and back', async () => {
    const fixture = await setup();
    await setTemplateStatus(kit.env.DB, template, 'archived', kit.clock.now());
    await setTemplateStatus(kit.env.DB, template, 'active', kit.clock.now());
    publishScan(
      kit.ctx,
      fixture.actor,
      fixture.result.outcome,
      fixture.result.evaluatedSnapshot,
      fixture.result.credentialContext,
      'camera',
    );
    const [row] = await publishedRows(fixture);
    expect(row).toMatchObject({ passId: fixture.pass.id, holder: 'LIVE-PRIVATE-MEMBER' });
  });

  it('does not republish an old evaluation under a newer approved release of the same version', async () => {
    const fixture = await setup();
    const snapshot = fixture.result.evaluatedSnapshot;
    if (!snapshot?.activeReleaseVersion) throw new Error('Approved release fixture missing');
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: template,
      version: snapshot.activeReleaseVersion,
    });
    publishScan(
      kit.ctx,
      fixture.actor,
      fixture.result.outcome,
      snapshot,
      fixture.result.credentialContext,
      'camera',
    );
    const [row] = await publishedRows(fixture);
    expect(row).toMatchObject({ passId: null, holder: null, photoUrl: null });
    expect(JSON.stringify(row)).not.toContain('LIVE-PRIVATE-MEMBER');
  });

  it.each(['missing', 'other pass'] as const)(
    'does not publish a row when its explicit evaluation is %s',
    async (kind) => {
      const fixture = await setup();
      let source: Candidate | null = null;
      if (kind === 'other pass') {
        const other = await kit.scanPass(template, { memberName: 'OTHER-PRIVATE-MEMBER' });
        source = (
          await resolveOutcome(kit.ctx, fixture.actor, {
            idempotencyKey: key(),
            input: codeOf(other),
            clientTs: kit.clock.now(),
          })
        ).evaluatedSnapshot;
        if (!source) throw new Error('Other evaluated pass snapshot missing');
      }
      publishScan(
        kit.ctx,
        fixture.actor,
        fixture.result.outcome,
        source,
        fixture.result.credentialContext,
        'camera',
      );
      expect(await publishedRows(fixture)).toEqual([]);
    },
  );
});
