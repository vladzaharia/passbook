import { expect, it } from 'vitest';
import { makeOrg, makePass } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { candidateById } from './repo-lookup.ts';
import { CHECK_IN, kit } from './repo-lookup-release-test-fixtures.ts';
import { passSnapshotCurrent } from './repo-pass-authority.ts';
import { foundOf } from './resolve.ts';
import { key } from './test-kit.ts';

export function registerLookupPartialReleaseCases() {
  it('fails closed on partial or inconsistent release and Wallet snapshots', async () => {
    const templateId = await kit.scanTemplate('Unapproved candidate', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId, {
      memberName: 'Unapproved Private Person',
      memberNo: 'P-12',
    });
    const approved = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!approved) throw new Error('Missing approved candidate');
    for (const field of [
      'activeReleaseId',
      'activeReleaseGeneration',
      'activeReleaseVersion',
      'activeReleaseCandidateHash',
    ] as const) {
      expect(await foundOf(kit.ctx, { ...approved, [field]: null })).toBeNull();
    }
    expect(await foundOf(kit.ctx, { ...approved, activeReleaseGeneration: 0 })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, activeReleaseId: '' })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, activeReleaseCandidateHash: '' })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, activeTemplateVersion: 'different' })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, transferPending: true })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, credentialKeysetCommitment: '' })).toBeNull();
    for (const imageGeneration of [undefined, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidPass = { ...approved.pass, imageGeneration: imageGeneration as number };
      expect(await foundOf(kit.ctx, { ...approved, pass: invalidPass })).toBeNull();
    }
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        approved.pass,
        approved.connectionGeneration,
        approved.activeTemplateVersion,
        approved.orgRevision,
        approved.templateRevision,
        kit.clock.now(),
        { ...approved, transferPending: true },
      ),
    ).toBe(false);
    expect(
      await foundOf(kit.ctx, { ...approved, pass: { ...approved.pass, credentialGeneration: 0 } }),
    ).toBeNull();
    expect(
      await foundOf(kit.ctx, { ...approved, pass: { ...approved.pass, lifecycleGeneration: -1 } }),
    ).toBeNull();
    expect(
      await foundOf(kit.ctx, {
        ...approved,
        pass: { ...approved.pass, lifecycleGeneration: Number.NaN },
      }),
    ).toBeNull();
    expect(
      await foundOf(kit.ctx, { ...approved, pass: { ...approved.pass, lifecycleGeneration: 0 } }),
    ).not.toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, walletVersion: null })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, walletVersion: 0 })).toBeNull();
    expect(
      await foundOf(kit.ctx, { ...approved, walletVersion: approved.pass.version + 1 }),
    ).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, walletTemplateVersion: null })).not.toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, walletTemplateVersion: '' })).not.toBeNull();
    for (const raw of [null, '{invalid', '[]', '{}'])
      expect(await foundOf(kit.ctx, { ...approved, versionPersonalization: raw })).not.toBeNull();
    if (!approved.versionPersonalization) throw new Error('Missing issued personalization');
    const personalization = JSON.parse(approved.versionPersonalization) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(personalization).reverse()));
    expect(
      await foundOf(kit.ctx, { ...approved, versionPersonalization: reordered }),
    ).not.toBeNull();
    if (!approved.passJsonSnapshot) throw new Error('Missing issued Wallet snapshot');
    const wallet = JSON.parse(approved.passJsonSnapshot) as Record<string, unknown>;
    expect(approved.identityPassTypeIdentifier).toBe(wallet.passTypeIdentifier);
    const identity = await first<{ revision: number }>(
      kit.env.DB,
      'SELECT revision FROM signing_identities WHERE id=?',
      [approved.pass.identityId],
    );
    expect(approved.identityRevision).toBe(identity?.revision);
    expect(approved.identityRevision).toBeGreaterThan(0);
    expect(approved.identityTeamIdentifier).toBe(wallet.teamIdentifier);
    for (const raw of [
      null,
      '{invalid',
      '[]',
      '{}',
      JSON.stringify({ ...wallet, serialNumber: 'wrong-serial' }),
      JSON.stringify({ ...wallet, passTypeIdentifier: 'wrong-pass-type' }),
      JSON.stringify({ ...wallet, teamIdentifier: 'wrong-team' }),
    ]) {
      expect(
        await foundOf(kit.ctx, { ...approved, passJson: raw, passJsonSnapshot: raw }),
      ).toBeNull();
    }
    expect(await foundOf(kit.ctx, { ...approved, identityPassTypeIdentifier: null })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, identityTeamIdentifier: null })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, identityRevision: null })).toBeNull();
    expect(await foundOf(kit.ctx, { ...approved, identityRevision: 0 })).toBeNull();
  });
}

export function registerLookupWalletCases() {
  it('invalidates the original signing-identity snapshot after an ABA', async () => {
    const templateId = await kit.scanTemplate('Identity revision', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId);
    const original = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!original?.identityTeamIdentifier || original.identityRevision === null)
      throw new Error('Missing signing identity snapshot');
    try {
      await run(kit.env.DB, 'UPDATE signing_identities SET team_identifier=? WHERE id=?', [
        `${original.identityTeamIdentifier}-changed`,
        pass.identityId,
      ]);
    } finally {
      await run(kit.env.DB, 'UPDATE signing_identities SET team_identifier=? WHERE id=?', [
        original.identityTeamIdentifier,
        pass.identityId,
      ]);
    }
    const fresh = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(fresh?.identityTeamIdentifier).toBe(original.identityTeamIdentifier);
    expect(fresh?.identityRevision).toBeGreaterThan(original.identityRevision);
    expect(fresh && (await foundOf(kit.ctx, fresh))).not.toBeNull();
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        original.pass,
        original.connectionGeneration,
        original.activeTemplateVersion,
        original.orgRevision,
        original.templateRevision,
        kit.clock.now(),
        original,
      ),
    ).toBe(false);
  });

  it('does not trust a signing identity belonging to another organization', async () => {
    const templateId = await kit.scanTemplate('Foreign signing identity', { actions: [CHECK_IN] });
    const other = await makeOrg(kit.fx);
    const identityId = kit.fx.ids.id();
    const passType = `pass.foreign.${kit.fx.ids.token(8)}`;
    const team = 'FOREIGNTEAM';
    await run(
      kit.env.DB,
      `INSERT INTO signing_identities
      (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at)
      VALUES (?, ?, 'Foreign', ?, ?, 'env', 'FOREIGN', ?)`,
      [identityId, other.id, passType, team, kit.clock.now()],
    );
    const template = await kit.registry.resolve(templateId, 'v1');
    const pass = await makePass(kit.fx, {
      orgId: kit.org.id,
      template,
      identityId,
      personalization: { memberName: 'Foreign Identity Private Person' },
    });
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json=(
      SELECT json_set(tv.pass_json,'$.serialNumber',p.serial,'$.passTypeIdentifier',?,'$.teamIdentifier',?)
      FROM passes p JOIN template_versions tv
        ON tv.template_id=p.template_id AND tv.version=p.template_version WHERE p.id=?
      ) WHERE pass_id=?`,
      [passType, team, pass.id, pass.id],
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    expect(candidate).toMatchObject({
      identityPassTypeIdentifier: null,
      identityTeamIdentifier: null,
      identityRevision: null,
    });
    expect(candidate && (await foundOf(kit.ctx, candidate))).toBeNull();
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const response = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    });
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ reason: 'not_found', card: null, display: null });
    expect(text).not.toContain(pass.id);
    expect(text).not.toContain('Foreign Identity Private Person');
  });

  it.each([
    { corruption: 'missing', state: 'active' },
    { corruption: 'malformed', state: 'active' },
    { corruption: 'serial', state: 'active' },
    { corruption: 'passType', state: 'active' },
    { corruption: 'team', state: 'active' },
    { corruption: 'serial', state: 'voided' },
    { corruption: 'serial', state: 'mode-mismatch' },
  ] as const)(
    'does not disclose or act on $state with $corruption Wallet JSON',
    async ({ corruption, state }) => {
      const templateId = await kit.scanTemplate('Wallet identity fence', { actions: [CHECK_IN] });
      const mode = state === 'mode-mismatch' ? 'test' : 'live';
      const pass = await kit.scanPass(
        templateId,
        { memberName: 'Wallet Identity Private Person' },
        { mode },
      );
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate?.passJsonSnapshot) throw new Error('Missing issued Wallet snapshot');
      const wallet = JSON.parse(candidate.passJsonSnapshot) as Record<string, unknown>;
      const raw =
        corruption === 'missing'
          ? null
          : corruption === 'malformed'
            ? '{invalid'
            : JSON.stringify({
                ...wallet,
                ...(corruption === 'serial' ? { serialNumber: 'wrong-serial' } : {}),
                ...(corruption === 'passType' ? { passTypeIdentifier: 'wrong-pass-type' } : {}),
                ...(corruption === 'team' ? { teamIdentifier: 'wrong-team' } : {}),
              });
      await run(kit.env.DB, 'UPDATE pass_versions SET pass_json=? WHERE pass_id=?', [raw, pass.id]);
      if (state === 'voided')
        await run(kit.env.DB, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
      const scanner = await kit.scanner({ templateIds: [templateId], mode: 'live' });
      for (const route of ['resolve', 'actions'] as const) {
        const request = {
          idempotencyKey: key(),
          input: { passId: pass.id, method: 'manual' },
          clientTs: kit.clock.now(),
          ...(route === 'actions' ? { actionId: 'check_in' } : {}),
        };
        const response = await kit.post(scanner.headers, `/${route}`, request);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({
          kind: 'refused',
          reason: state === 'mode-mismatch' ? 'test_pass' : 'not_found',
          action: null,
          template: null,
          card: null,
          display: null,
        });
        const secrets = [
          pass.id,
          pass.serial,
          pass.scanCode,
          pass.identityId,
          pass.releaseId,
          pass.authToken,
          pass.downloadToken,
          candidate.identityPassTypeIdentifier,
          candidate.identityTeamIdentifier,
          candidate.activeReleaseId,
          templateId,
          'Wallet identity fence',
          'Wallet Identity Private Person',
        ].filter((value): value is string => typeof value === 'string' && value.length > 0);
        for (const secret of secrets) expect(text).not.toContain(secret);
        if (state === 'mode-mismatch' && route === 'actions') {
          expect(JSON.parse(text)).toMatchObject({ scanId: null, at: null, replay: false });
          const scan = await first(kit.env.DB, 'SELECT * FROM scans WHERE idempotency_key=?', [
            request.idempotencyKey,
          ]);
          expect(scan).toMatchObject({
            mode: 'live',
            state: 'done',
            outcome: 'refused',
            reason: 'not_found',
            pass_id: null,
            template_id: null,
            pass_version: null,
            action_id: null,
            action_kind: null,
          });
          for (const secret of secrets) expect(JSON.stringify(scan)).not.toContain(secret);
          const replay = await kit.post(scanner.headers, '/actions', request);
          expect(replay.status).toBe(200);
          const replayText = await replay.text();
          // The replay returns the recorded passless miss.
          expect(JSON.parse(replayText)).toMatchObject({
            kind: 'refused',
            reason: 'not_found',
            scanId: (scan as { id: string }).id,
            replay: true,
            action: null,
            template: null,
            card: null,
            display: null,
          });
          for (const secret of secrets) expect(replayText).not.toContain(secret);
          expect(
            await first(kit.env.DB, 'SELECT * FROM scans WHERE idempotency_key=?', [
              request.idempotencyKey,
            ]),
          ).toEqual(scan);
        }
      }
      expect(
        await all(kit.env.DB, 'SELECT pass_id FROM scan_gates WHERE pass_id=?', [pass.id]),
      ).toHaveLength(0);
      expect(
        await all(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [
          pass.id,
        ]),
      ).toHaveLength(0);
    },
  );
}
