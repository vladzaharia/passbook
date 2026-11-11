import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { rollbackRelease } from '../templates/releases.ts';
import { candidateById } from './repo-lookup.ts';
import { installVersion } from './repo-resolve-test-fixtures.ts';
import { foundOf } from './resolve.ts';
import { cardProjectionFixture } from './resolve-card-projection-test-fixtures.ts';
import { body, kit, resolve, setupResolveFixture } from './resolve-test-fixtures.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupResolveFixture);

describe('resolve: the card', () => {
  it('projects preview fields, action values and identity by source and role', async () => {
    const {
      templateId,
      pass,
      template,
      pinnedRelease,
      hidden,
      nestedHidden,
      hiddenDefault,
      password,
      email,
      untypedEmail,
      telephone,
      barcode,
    } = await cardProjectionFixture();

    const manager = await kit.staff('manager');
    const scanners = [
      await kit.scanner({ templateIds: [templateId], settings: { roleWithoutSignIn: 'door' } }),
      await kit.scanner({ templateIds: [templateId], settings: { roleWithoutSignIn: 'desk' } }),
      await kit.scanner({
        templateIds: [templateId],
        settings: { staffSignIn: true },
        staffId: manager.id,
      }),
    ];
    for (const [index, scanner] of scanners.entries()) {
      const { out } = await resolve(scanner.headers, codeOf(pass));
      expect(out.kind).toBe('ready');
      const card = out.card!;
      expect(card.title).toBe('Ada Carter');
      expect(card.subtitle).toBe(index === 2 ? 'Roof manager lounge' : null);
      const pj = card.passView.passJson as {
        backgroundColor: string;
        logoText?: string;
        generic: {
          primaryFields: Record<string, unknown>[];
          secondaryFields: Record<string, unknown>[];
          backFields: Record<string, unknown>[];
        };
      };
      expect(pj.backgroundColor).toBe('rgb(20, 30, 40)');
      expect(pj.logoText).toBe(index === 2 ? 'Roof manager lounge' : undefined);
      expect(pj.generic.primaryFields).toEqual([
        { key: 'name', label: 'Member', value: 'Ada Carter' },
      ]);
      expect(pj.generic.secondaryFields).toContainEqual({
        key: 'static',
        label: 'Membership',
        value: 'Member',
      });
      expect(pj.generic.secondaryFields).toContainEqual({
        key: 'public_nested',
        label: 'Area',
        value: 'Public atrium',
      });
      expect(pj.generic.secondaryFields).toContainEqual({
        key: 'entrance',
        label: 'Entry',
        value: 'North entrance',
      });
      const keys = pj.generic.secondaryFields.map((field) => field.key);
      expect(keys.includes('tier')).toBe(index >= 1);
      if (index >= 1)
        expect(pj.generic.secondaryFields).toContainEqual({
          key: 'tier',
          label: 'Tier',
          value: 'Silver desk tier',
          textAlignment: 'PKTextAlignmentRight',
        });
      expect(keys.includes('lounge')).toBe(index === 2);
      expect(keys.includes('manager_nested')).toBe(index === 2);
      expect(keys).not.toContain('private_nested');
      expect(pj.generic.backFields).toEqual([]);
      expect(card.flags.map((flag) => flag.label)).toEqual([
        'Balance notice',
        ...(index >= 1 ? ['Tier notice'] : []),
      ]);
      const valueInputs = card.values.map((value) => value.input);
      expect(valueInputs).toContain('balance');
      expect(valueInputs.includes('tier')).toBe(index >= 1);
      expect(valueInputs.includes('lounge')).toBe(index === 2);
      expect(valueInputs).not.toContain('privateNote');
      expect(valueInputs).not.toContain('copy');
      const serialized = JSON.stringify(out);
      for (const forbidden of [
        hidden,
        nestedHidden,
        password,
        encodeURIComponent(password),
        email,
        untypedEmail,
        telephone,
        barcode,
        pass.authToken,
        pass.downloadToken,
        hiddenDefault,
        'Restricted notice',
        pass.serial,
        pass.scanCode!,
        'NFC-PAYLOAD-SECRET',
        'ARBITRARY-FIELD-METADATA',
        'ARBITRARY-STYLE-METADATA',
        'ARBITRARY-TOP-LEVEL-METADATA',
        'UNAPPROVED-SNAPSHOT-DATA',
      ])
        expect(serialized).not.toContain(forbidden);
      if (index === 0) expect(serialized).not.toContain('Silver desk tier');
      if (index !== 2) {
        expect(serialized).not.toContain('Roof manager lounge');
        expect(serialized).not.toContain('Manager balcony host');
      }
    }

    // Display-only revisions intersect with the pinned source policy when their build keys match.
    const currentManifest = structuredClone(template.manifest);
    currentManifest.inputs.properties!.tier = { type: 'string', 'x-scan': 'manager' };
    currentManifest.inputs.properties!.lounge = { type: 'string', 'x-scan': 'hidden' };
    currentManifest.scan!.actions!.find((action) => action.id === 'check_in')!.minRole = 'manager';
    currentManifest.inputs.properties!.profile = {
      type: 'object',
      properties: {
        publicLabel: { type: 'string', 'x-scan': 'hidden' },
        managerHint: { type: 'string', 'x-scan': 'manager' },
        insideNote: { type: 'string', 'x-scan': 'hidden' },
      },
    };
    const displayHead = await installVersion(
      templateId,
      'v3',
      currentManifest,
      template.passJson,
      'scan-display-compatible',
    );
    const displayCandidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(displayCandidate).toMatchObject({
      activeReleaseId: displayHead.id,
      activeReleaseGeneration: displayHead.generation,
      activeReleaseVersion: 'v3',
      activeReleaseCandidateHash: displayHead.candidateHash,
      displayTemplateVersion: 'v3',
    });
    const displayFound = displayCandidate && (await foundOf(kit.ctx, displayCandidate));
    expect(displayFound?.activeTemplate?.version).toBe('v3');
    expect(displayFound?.displayTemplateVersion).toBe('v3');
    const deskResult = await resolve(scanners[1]!.headers, codeOf(pass));
    expect(JSON.stringify(deskResult.out)).not.toContain(displayHead.id);
    expect(JSON.stringify(deskResult.out)).not.toContain(displayHead.candidateHash);
    const deskCard = deskResult.out.card!;
    const deskView = JSON.stringify(deskCard.passView.passJson);
    expect(deskView).not.toContain('Silver desk tier');
    expect(deskView).not.toContain('Public atrium');
    expect(deskCard.values.map((value) => value.input)).not.toContain('tier');
    expect(deskCard.actions.find((action) => action.id === 'check_in')?.available).toBe(false);
    const managerCard = (await resolve(scanners[2]!.headers, codeOf(pass))).out.card!;
    expect(managerCard.actions.find((action) => action.id === 'check_in')?.available).toBe(true);
    const managerView = managerCard.passView.passJson as {
      logoText?: string;
      backgroundColor?: string;
      generic: { secondaryFields: { key: string; value: unknown }[] };
    };
    expect(managerView.backgroundColor).toBe('rgb(20, 30, 40)');
    expect(managerView.logoText).toBeUndefined();
    expect(managerView.generic.secondaryFields).toContainEqual(
      expect.objectContaining({ key: 'tier', value: 'Silver desk tier' }),
    );
    expect(managerView.generic.secondaryFields.map((field) => field.key)).not.toContain(
      'public_nested',
    );

    // An incompatible build retains the pinned display internally, but cannot be admitted.
    const head = await installVersion(
      templateId,
      'v4',
      currentManifest,
      template.passJson,
      'different-build',
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(candidate).toMatchObject({
      activeTemplateVersion: 'v4',
      activeReleaseVersion: 'v4',
      displayTemplateVersion: null,
    });
    const found = candidate && (await foundOf(kit.ctx, candidate));
    expect(found?.template.version).toBe('v2');
    expect(found?.activePolicy?.version).toBe('v4');
    expect(found?.activeTemplate?.version).toBe('v2');
    expect(found?.scan.actions.find((action) => action.id === 'check_in')?.minRole).toBe('manager');
    const stale = await resolve(scanners[1]!.headers, codeOf(pass));
    expect(stale).toMatchObject({
      status: 200,
      out: { kind: 'refused', reason: 'not_found', card: null, display: null },
    });
    for (const secret of [
      pass.id,
      pass.serial,
      pass.scanCode!,
      'Silver desk tier',
      'Public atrium',
    ])
      expect(JSON.stringify(stale.out)).not.toContain(secret);
    const action = await kit.post(scanners[1]!.headers, '/actions', {
      ...body(codeOf(pass)),
      actionId: 'auto',
    });
    expect(action.status).toBe(200);
    expect(await action.json()).toMatchObject({ reason: 'not_found', card: null, display: null });
    expect(
      await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
    ).toHaveLength(0);
    expect(
      await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
        pass.id,
      ]),
    ).toHaveLength(0);

    // Roll back the scoped release while the legacy pointer and registry default remain on v4.
    await rollbackRelease(kit.ctx, head.publisherAuth, templateId, {
      orgId: kit.org.id,
      mode: 'live',
      provider: 'apple',
      releaseId: pinnedRelease.id,
      candidateHash: pinnedRelease.candidateHash,
      expectedGeneration: head.generation,
      reason: 'Restore the pinned scanner release.',
    });
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      'v4',
      templateId,
    ]);
    const rolledBack = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(rolledBack?.activeReleaseVersion).toBe('v2');
    expect(rolledBack?.activeReleaseGeneration).toBeGreaterThan(
      candidate!.activeReleaseGeneration!,
    );
    const pinnedCard = (await resolve(scanners[1]!.headers, codeOf(pass))).out.card!;
    const pinnedView = JSON.stringify(pinnedCard.passView.passJson);
    expect(pinnedView).toContain('Silver desk tier');
    expect(pinnedView).toContain('Public atrium');
    expect(pinnedCard.values.map((value) => value.input)).toContain('tier');
    expect(pinnedCard.actions.find((action) => action.id === 'check_in')?.available).toBe(true);
  });
});
