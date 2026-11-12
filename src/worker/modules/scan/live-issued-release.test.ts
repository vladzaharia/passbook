// A pass used under its own release while the head is on another build is a valid scan: the live
// screen shows what the scanning device's card shows (own content, the head's visibility policy).
import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { scannerActor, withRole } from './actor.ts';
import { publishScan } from './live.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { hub, kit, screen } from './scan-hub-test-fixtures.ts';
import { codeOf, key, proofedScanActor } from './test-kit.ts';

const desk = { roleWithoutSignIn: 'desk' };

async function setup(name: string) {
  const templateId = await kit.scanTemplate(name, {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
  });
  const source = await kit.scanner({ templateIds: [templateId], settings: desk });
  const monitor = await screen('monitor', [source.id], false, desk);
  const pass = await kit.scanPass(templateId, { memberName: `${name} Member` });
  const png = btoa(String.fromCharCode(...makePng(270, 270)));
  await putMemberPhoto(
    kit.ctx,
    { type: 'system', id: null },
    pass.id,
    { png, includeInPass: false },
    null,
  );
  return { templateId, source, monitor, pass };
}

/** Approve a second version with a different build as the head; `edit` changes its policy. */
async function moveHead(templateId: string, version: string, edit?: (m: TemplateManifest) => void) {
  const pinned = await kit.registry.resolve(templateId);
  const manifest = structuredClone(pinned.manifest);
  manifest.name = `${manifest.name} ${version}`;
  edit?.(manifest);
  const next = kit.registry.add({
    id: templateId,
    orgId: pinned.orgId,
    version,
    manifest,
    passJson: pinned.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, next, {
    registry: kit.registry,
    buildKey: `incompatible-${version}`,
  });
  await approveAppleRelease(kit, { templateId, version, mode: 'live' });
}

/** Scan on the device, publish to the live hub, and return the device card and the live row. */
async function scanAndWatch(fixture: Awaited<ReturnType<typeof setup>>) {
  const device = await getScanner(kit.env.DB, fixture.source.id);
  if (!device) throw new Error('Missing scanning device.');
  const actor = await proofedScanActor(
    kit.ctx,
    withRole(
      scannerActor(kit.ctx, device, 'live', 'cookie', {
        event: null,
        templateIds: [fixture.templateId],
      }),
      null,
    ),
  );
  const evaluation = await resolveOutcome(kit.ctx, actor, {
    input: codeOf(fixture.pass),
    clientTs: kit.clock.now(),
    idempotencyKey: key(),
  });
  const before = new Set(
    (await hub().snapshot(fixture.monitor.attachment)).rows.map((entry) => entry.id),
  );
  publishScan(
    kit.ctx,
    actor,
    evaluation.outcome,
    evaluation.evaluatedSnapshot,
    evaluation.credentialContext,
    'camera',
  );
  await kit.settle();
  const live = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
    (entry) => entry.scannerId === fixture.source.id && !before.has(entry.id),
  );
  return { outcome: evaluation.outcome, live };
}

/** Fetch the card's photo as the scanning device and the live row's photo as the screen. */
function photos(fixture: Awaited<ReturnType<typeof setup>>, card: string, live: string) {
  const path = (url: string) => url.replace('/api/v1/scan', '');
  return Promise.all([
    kit.get(fixture.source.headers, path(card)).then((response) => response.status),
    kit.get(fixture.monitor.headers, path(live)).then((response) => response.status),
  ]);
}

describe('live screens under the issued-release rule', () => {
  it('shows an old-version pass under a newer incompatible head as the device card does', async () => {
    const fixture = await setup('Own release');
    const current = await scanAndWatch(fixture);
    expect(current.live).toMatchObject({ passId: fixture.pass.id, holder: 'Own release Member' });
    await moveHead(fixture.templateId, 'v2');
    const candidate = await candidateById(kit.env.DB, kit.org.id, fixture.pass.id);
    expect(candidate).toMatchObject({
      activeReleaseVersion: 'v2',
      displayTemplateVersion: null,
      pass: { templateVersion: fixture.pass.templateVersion },
    });
    const { outcome, live } = await scanAndWatch(fixture);
    expect(outcome.kind).toBe('ready');
    const identity = outcome.card?.display?.identity;
    expect(identity?.holder).toBe('Own release Member');
    expect(live).toMatchObject({ passId: fixture.pass.id, holder: identity?.holder });
    // The member photo survives the rebuild: shown and served on the card and the live row.
    const card = identity?.photo?.url;
    if (!card || !live?.photoUrl) throw new Error('Photo withheld under the issued release.');
    expect(await photos(fixture, card, live.photoUrl)).toEqual([200, 200]);
  });

  it('hides the photo on both when the head raises its role above the reader', async () => {
    const fixture = await setup('Photo policy');
    const shown = await scanAndWatch(fixture);
    expect(shown.outcome.card?.display?.identity.photo?.url).toEqual(expect.any(String));
    expect(shown.live?.photoUrl).toEqual(expect.any(String));
    await moveHead(fixture.templateId, 'v2', (manifest) => {
      if (!manifest.scan) throw new Error('Missing scan manifest.');
      manifest.scan.display = { v: 1, header: {}, photo: { minRole: 'manager' } };
    });
    const { outcome, live } = await scanAndWatch(fixture);
    expect(outcome.kind).toBe('ready');
    expect(outcome.card?.display?.identity.photo?.url ?? null).toBeNull();
    // The pass itself is still shown on both; only the photo is withheld from the desk reader.
    expect(live).toMatchObject({ passId: fixture.pass.id, holder: 'Photo policy Member' });
    expect(live?.photoUrl).toBeNull();
  });

  it('keeps a field the head hides hidden even though the pass’s own release showed it', async () => {
    const fixture = await setup('Head policy');
    const shown = await scanAndWatch(fixture);
    expect(shown.live).toMatchObject({ passId: fixture.pass.id, holder: 'Head policy Member' });
    await moveHead(fixture.templateId, 'v2', (manifest) => {
      const memberName = manifest.inputs.properties?.memberName;
      if (!memberName || typeof memberName !== 'object') throw new Error('Missing memberName.');
      manifest.inputs.properties!.memberName = { ...memberName, 'x-scan': 'hidden' };
    });
    const { outcome, live } = await scanAndWatch(fixture);
    expect(outcome.kind).toBe('ready');
    // The card falls back to a non-personal holder line; neither surface shows the hidden name.
    expect(JSON.stringify(outcome.card)).not.toContain('Head policy Member');
    expect(live).toMatchObject({ passId: fixture.pass.id, holder: null });
    expect(JSON.stringify(live)).not.toContain('Head policy Member');
    // The photo has its own policy (the head leaves it at door): shown on both, as on the card.
    expect(outcome.card?.display?.identity.photo?.url).toEqual(expect.any(String));
    expect(live?.photoUrl).toEqual(expect.any(String));
  });

  it('withholds a deleted template’s pass from the live screen', async () => {
    const fixture = await setup('Deleted');
    await moveHead(fixture.templateId, 'v2');
    const retained = await scanAndWatch(fixture);
    expect(retained.live).toMatchObject({ passId: fixture.pass.id, holder: 'Deleted Member' });
    const card = retained.outcome.card?.display?.identity.photo?.url;
    if (!card || !retained.live?.photoUrl) throw new Error('Photo withheld before deletion.');
    expect(await photos(fixture, card, retained.live.photoUrl)).toEqual([200, 200]);
    await run(kit.env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [
      fixture.templateId,
    ]);
    expect(await photos(fixture, card, retained.live.photoUrl)).toEqual([404, 404]);
    const old = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === retained.live?.id,
    );
    expect(old === undefined || (old.passId === null && old.holder === null)).toBe(true);
    const { outcome, live } = await scanAndWatch(fixture);
    expect(outcome.kind).toBe('refused');
    expect(live?.passId ?? null).toBeNull();
    expect(live?.holder ?? null).toBeNull();
    expect(live?.photoUrl ?? null).toBeNull();
    expect(JSON.stringify(live ?? null)).not.toContain('Deleted Member');
  });
});
