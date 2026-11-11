import { describe, expect, it } from 'vitest';
import {
  makeSession,
  makeUser,
  materializeTemplateAssets,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import {
  adminActor,
  captureScanTenantAuthority,
  scannerActor,
  tenantScanRole,
  withRole,
} from './actor.ts';
import {
  actorCsrfAuthorityStmt,
  actorCsrfSnapshotFence,
  actorCsrfSnapshotFromResult,
} from './actor-csrf.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import {
  type OutputAuthority,
  outputAuthoritiesAllCurrent,
  outputAuthorityCurrent,
  outputAuthorityPredicate,
} from './repo-output-authority.ts';
import {
  fixture,
  kit,
  name,
  noDisclosure,
  raceFence,
  rollbackRemoval,
  templateId,
} from './repo-output-authority-split-test-fixtures.ts';
import { packOutputPredicate } from './repo-output-predicates.ts';
import { readScannerScope } from './repo-scope.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { grantScanMembership, key, proofedScanActor } from './test-kit.ts';

describe('atomic scanner response authority', () => {
  it.each(['membership', 'session'] as const)(
    'masks a ready card when the original tenant %s is revoked after projection',
    async (change) => {
      const f = await fixture();
      const user = await makeUser(kit.fx);
      const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
      const session = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
      const auth = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
      if (!auth) throw new Error('Missing session.');
      const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read');
      if (authority.kind !== 'session') throw new Error('Missing tenant authority.');
      const actor = adminActor(auth, 'live', {
        orgId: kit.org.id,
        event: null,
        templateIds: [templateId],
        timeZone: 'UTC',
      });
      actor.platformSessionId = auth.sessionId;
      actor.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
      actor.role = tenantScanRole(authority);
      const real = kit.env.DB;
      const race = raceFence(real, () =>
        change === 'membership'
          ? run(real, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
              kit.clock.now(),
              membershipId,
            ])
          : run(real, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
              kit.clock.now(),
              auth.sessionId,
            ]),
      );
      Object.assign(kit.env, { DB: race.db });
      try {
        const result = await resolveOutcome(kit.ctx, actor, {
          idempotencyKey: key(),
          input: { passId: f.pass.id, method: 'manual' },
          clientTs: kit.clock.now(),
        });
        expect(race.fired()).toBe(true);
        expect(result.outcome).toMatchObject({
          kind: 'refused',
          reason: 'not_found',
          card: null,
          display: null,
        });
        noDisclosure(JSON.stringify(result), f.pass.id);
      } finally {
        Object.assign(kit.env, { DB: real });
      }
    },
  );

  it('keeps incompatible historical reads while applying the current source policy', async () => {
    const id = await kit.scanTemplate('Incompatible output policy', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const original = await kit.registry.resolve(id);
    const pinned = kit.registry.add({
      id,
      orgId: kit.org.id,
      version: 'output-v1',
      manifest: original.manifest,
      passJson: original.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    const pinnedAssets = await materializeTemplateAssets(kit.fx, pinned, kit.registry);
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id,version,manifest,pass_json,assets,build_key,created_at) VALUES (?,?,?,?,?,?,?)`,
      [
        id,
        pinned.version,
        JSON.stringify(pinned.manifest),
        JSON.stringify(pinned.passJson),
        JSON.stringify(pinnedAssets),
        'old-output-build',
        kit.clock.now(),
      ],
    );
    await approveAppleRelease(kit, { templateId: id, mode: 'live', version: pinned.version });
    const pass = await kit.scanPass(id, { memberName: 'Previously Visible Member' });
    const manifest = structuredClone(pinned.manifest);
    manifest.inputs.properties!.memberName = { type: 'string', 'x-scan': 'manager' };
    const active = kit.registry.add({
      id,
      orgId: kit.org.id,
      version: 'output-v2',
      manifest,
      passJson: pinned.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    const activeAssets = await materializeTemplateAssets(kit.fx, active, kit.registry);
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id,version,manifest,pass_json,assets,build_key,created_at) VALUES (?,?,?,?,?,?,?)`,
      [
        id,
        active.version,
        JSON.stringify(active.manifest),
        JSON.stringify(active.passJson),
        JSON.stringify(activeAssets),
        'new-output-build',
        kit.clock.now(),
      ],
    );
    await approveAppleRelease(kit, { templateId: id, mode: 'live', version: active.version });
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    const device = await kit.scanner({
      templateIds: [id],
      settings: { roleWithoutSignIn: 'door' },
    });
    const row = await getScanner(kit.env.DB, device.id);
    if (!candidate || !row) throw new Error('Missing incompatible fixture.');
    expect(candidate.displayTemplateVersion).toBeNull();
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(
          kit.ctx,
          row,
          row.mode,
          'cookie',
          await readScannerScope(kit.env.DB, row, null),
        ),
        null,
      ),
    );
    const proof: OutputAuthority = {
      actor,
      event: actor.event,
      now: kit.clock.now(),
      templateId: id,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
      pass: candidate.pass,
      connectionGeneration: candidate.connectionGeneration,
      activeTemplateVersion: candidate.activeTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      release: candidate,
      displayTemplateVersion: candidate.displayTemplateVersion,
      checkInRules: candidate.checkInRules,
      lookupHash: candidate.lookupHash,
      requireActive: true,
    };
    expect(await outputAuthorityCurrent(kit.env.DB, proof)).toBe(true);
    expect(await outputAuthorityCurrent(kit.env.DB, { ...proof, purpose: 'commit' })).toBe(false);
    const lookup = await kit.post(device.headers, '/lookup', { q: pass.id });
    const text = await lookup.text();
    expect(JSON.parse(text)).toMatchObject({ items: [{ passId: pass.id, title: '' }] });
    expect(text).not.toContain('Previously Visible Member');
  });

  it('separates identity-only reads from strict photo and action image fences', async () => {
    const f = await fixture({ photo: true });
    const row = await getScanner(kit.env.DB, f.scanner.id);
    if (!row) throw new Error('Missing scanner.');
    const scope = await readScannerScope(kit.env.DB, row, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
    );
    const input: OutputAuthority = {
      actor,
      event: actor.event,
      now: kit.clock.now(),
      templateId,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: f.candidate.credentialKeysetCommitment,
      pass: f.candidate.pass,
      connectionGeneration: f.candidate.connectionGeneration,
      activeTemplateVersion: f.candidate.activeTemplateVersion,
      orgRevision: f.candidate.orgRevision,
      templateRevision: f.candidate.templateRevision,
      release: f.candidate,
      displayTemplateVersion: f.candidate.displayTemplateVersion,
      checkInRules: f.candidate.checkInRules,
      lookupHash: f.candidate.lookupHash,
      requireActive: true,
    };
    expect(
      await outputAuthorityCurrent(kit.env.DB, { ...input, imagePolicy: 'identity-only' }),
    ).toBe(true);
    expect(await outputAuthorityCurrent(kit.env.DB, { ...input, requirePhoto: true })).toBe(true);
    await run(
      kit.env.DB,
      'UPDATE member_photos SET include_in_pass=1-include_in_pass WHERE org_id=? AND pass_id=?',
      [kit.org.id, f.pass.id],
    );
    expect(
      await outputAuthorityCurrent(kit.env.DB, { ...input, imagePolicy: 'identity-only' }),
    ).toBe(true);
    expect(await outputAuthorityCurrent(kit.env.DB, input)).toBe(false);
    expect(await outputAuthorityCurrent(kit.env.DB, { ...input, requirePhoto: true })).toBe(false);
    expect(
      await outputAuthorityCurrent(kit.env.DB, {
        ...input,
        imagePolicy: 'identity-only',
        requirePhoto: true,
      }),
    ).toBe(false);
    expect(
      await outputAuthorityCurrent(kit.env.DB, {
        ...input,
        imagePolicy: 'identity-only',
        purpose: 'commit',
      }),
    ).toBe(false);
    expect(
      await outputAuthorityCurrent(kit.env.DB, {
        ...input,
        imagePolicy: 'identity-only',
        pass: { ...input.pass, imageGeneration: -1 },
      }),
    ).toBe(false);
  });

  it('rejects an originally pending transfer snapshot even when no transfer is pending now', async () => {
    const f = await fixture({ memberNo: 'private-lookup-key' });
    const row = await getScanner(kit.env.DB, f.scanner.id);
    if (!row) throw new Error('Missing scanner.');
    const scope = await readScannerScope(kit.env.DB, row, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
    );
    const csrfRead = actorCsrfAuthorityStmt(kit.env.DB, actor);
    if (!csrfRead) throw new Error('Missing scanner authority statement.');
    const csrfSnapshot = await actorCsrfSnapshotFromResult(kit.ctx, actor, await csrfRead.all());
    if (!csrfSnapshot) throw new Error('Missing verified scanner snapshot.');
    const csrf = actorCsrfSnapshotFence(actor, csrfSnapshot);
    if (!csrf) throw new Error('Missing scanner scalar fence.');
    const input: OutputAuthority = {
      actor,
      event: actor.event,
      now: kit.clock.now(),
      templateId,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: f.candidate.credentialKeysetCommitment,
      pass: f.candidate.pass,
      connectionGeneration: f.candidate.connectionGeneration,
      activeTemplateVersion: f.candidate.activeTemplateVersion,
      orgRevision: f.candidate.orgRevision,
      templateRevision: f.candidate.templateRevision,
      release: f.candidate,
      displayTemplateVersion: f.candidate.displayTemplateVersion,
      checkInRules: f.candidate.checkInRules,
      lookupHash: f.candidate.lookupHash,
      requireActive: true,
      extra: csrf,
    };
    expect(f.candidate.transferPending).toBe(false);
    expect(await outputAuthorityCurrent(kit.env.DB, input)).toBe(true);
    const packed = packOutputPredicate(outputAuthorityPredicate(input));
    const metadata = packed.params[0];
    expect(typeof metadata).toBe('string');
    for (const secret of [
      f.candidate.pass.authToken,
      f.candidate.pass.downloadToken,
      f.candidate.pass.serial,
      f.candidate.pass.scanCode,
      f.candidate.pass.barcodeHash,
      f.candidate.lookupHash,
      f.candidate.pass.holderEmail,
      name,
      row.csrfSecret,
    ])
      if (secret) expect(metadata).not.toContain(secret);
    expect(packed.params.slice(1)).toContain(f.candidate.pass.authToken);
    expect(packed.params.slice(1)).toContain(f.candidate.pass.downloadToken);
    expect(packed.params.slice(1)).toContain(f.candidate.passJsonSnapshot);
    expect(packed.params.slice(1)).toContain(row.csrfSecret);
    expect(packed.params.slice(1)).toContain(f.candidate.lookupHash);
    const missingRefs: Partial<OutputAuthority> = { ...input };
    delete missingRefs.credentialTombstoneRefs;
    expect(await outputAuthorityCurrent(kit.env.DB, missingRefs as OutputAuthority)).toBe(false);
    const missingKeyset: Partial<OutputAuthority> = { ...input };
    delete missingKeyset.credentialKeysetCommitment;
    expect(await outputAuthorityCurrent(kit.env.DB, missingKeyset as OutputAuthority)).toBe(false);
    expect(
      await outputAuthorityCurrent(kit.env.DB, { ...input, credentialKeysetCommitment: 'bad' }),
    ).toBe(false);
    const currentKeyset = input.credentialKeysetCommitment;
    const wrongKeyset = `${currentKeyset[0] === '0' ? '1' : '0'}${currentKeyset.slice(1)}`;
    expect(
      await outputAuthorityCurrent(kit.env.DB, {
        ...input,
        credentialKeysetCommitment: wrongKeyset,
        release: { ...f.candidate, credentialKeysetCommitment: wrongKeyset },
      }),
    ).toBe(false);
    expect(
      await outputAuthorityCurrent(kit.env.DB, {
        ...input,
        release: { ...f.candidate, transferPending: true },
      }),
    ).toBe(false);
    expect(
      await outputAuthorityCurrent(kit.env.DB, {
        ...input,
        pass: { ...f.candidate.pass, credentialGeneration: 0 },
      }),
    ).toBe(false);
    expect(
      await outputAuthorityCurrent(kit.env.DB, {
        ...input,
        pass: { ...f.candidate.pass, lifecycleGeneration: -1 },
      }),
    ).toBe(false);
    await rollbackRemoval(kit.env.DB, f.pass.id, kit.clock.now());
    expect(await outputAuthorityCurrent(kit.env.DB, input)).toBe(false);
    const current = await candidateById(kit.env.DB, kit.org.id, f.pass.id);
    if (!current) throw new Error('Missing current candidate.');
    expect(
      await outputAuthorityCurrent(kit.env.DB, {
        ...input,
        pass: current.pass,
        release: current,
      }),
    ).toBe(true);
  });

  it('checks a large set of original snapshots in one D1 read transaction', async () => {
    const f = await fixture();
    const real = kit.env.DB;
    const row = await getScanner(real, f.scanner.id);
    if (!row) throw new Error('Missing scanner.');
    const scope = await readScannerScope(real, row, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
    );
    const input: OutputAuthority = {
      actor,
      event: actor.event,
      now: kit.clock.now(),
      templateId,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: f.candidate.credentialKeysetCommitment,
      pass: f.candidate.pass,
      connectionGeneration: f.candidate.connectionGeneration,
      activeTemplateVersion: f.candidate.activeTemplateVersion,
      orgRevision: f.candidate.orgRevision,
      templateRevision: f.candidate.templateRevision,
      release: f.candidate,
      displayTemplateVersion: f.candidate.displayTemplateVersion,
      checkInRules: f.candidate.checkInRules,
      lookupHash: f.candidate.lookupHash,
      requireActive: true,
    };
    const inputs = Array.from({ length: 1000 }, () => input);
    expect(await outputAuthoritiesAllCurrent(real, inputs)).toBe(true);
    await run(real, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), f.scanner.id]);
    expect(await outputAuthoritiesAllCurrent(real, inputs)).toBe(false);
  });
});
