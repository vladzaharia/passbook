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
    // The photo follows the card's own decision for this release state.
    expect(live?.photoUrl != null).toBe(identity?.photo != null);
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
    expect(live).toMatchObject({ passId: fixture.pass.id, holder: null, photoUrl: null });
    expect(JSON.stringify(live)).not.toContain('Head policy Member');
  });

  it('withholds a deleted template’s pass from the live screen', async () => {
    const fixture = await setup('Deleted');
    const retained = await scanAndWatch(fixture);
    expect(retained.live).toMatchObject({ passId: fixture.pass.id, holder: 'Deleted Member' });
    await moveHead(fixture.templateId, 'v2');
    await run(kit.env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [
      fixture.templateId,
    ]);
    const old = (await hub().snapshot(fixture.monitor.attachment)).rows.find(
      (entry) => entry.id === retained.live?.id,
    );
    expect(old === undefined || (old.passId === null && old.holder === null)).toBe(true);
    const { outcome, live } = await scanAndWatch(fixture);
    expect(outcome.kind).toBe('refused');
    expect(live?.passId ?? null).toBeNull();
    expect(live?.holder ?? null).toBeNull();
    expect(JSON.stringify(live ?? null)).not.toContain('Deleted Member');
  });
});
