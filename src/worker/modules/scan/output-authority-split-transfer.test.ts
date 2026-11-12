import { describe, expect, it } from 'vitest';
import { makeScanner, persistTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { scannerActor, withRole } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { lookup } from './lookup.ts';
import { credentialTombstonesClear } from './repo-credential-tombstones.ts';
import { getScanner } from './repo-device.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import { type OutputAuthority, outputAuthorityCurrent } from './repo-output-authority.ts';
import { providerFixture } from './repo-output-authority-provider-test-fixtures.ts';
import {
  finishProviderTransfer,
  raceFence,
  system,
} from './repo-output-authority-split-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { key, proofedScanActor } from './test-kit.ts';

describe('atomic scanner response authority', () => {
  it.each([
    ['resolve', 'pending'],
    ['lookup', 'pending'],
    ['resolve', 'completed'],
    ['lookup', 'completed'],
  ] as const)(
    'masks %s when an actual credential transfer reaches %s after projection',
    async (route, stage) => {
      const t = await providerFixture();
      const orgId = t.kit.org.id;
      const device = await makeScanner(t.kit.fx, { orgId, templateIds: [t.pass.templateId] });
      const row = await getScanner(t.kit.env.DB, device.id);
      if (!row) throw new Error('Missing scanner.');
      const scope = await readScannerScope(t.kit.env.DB, row, null);
      const actor = await proofedScanActor(
        t.kit.ctx,
        withRole(scannerActor(t.kit.ctx, row, row.mode, 'cookie', scope), null),
      );
      const original = await candidateById(t.kit.env.DB, orgId, t.pass.id);
      const expected = await getHolderPass(t.kit.env.DB, t.pass.id, null);
      if (!original || !expected) throw new Error('Missing original transfer snapshot.');
      const request = async () =>
        route === 'resolve'
          ? (
              await resolveOutcome(t.kit.ctx, actor, {
                idempotencyKey: key(),
                input: { passId: t.pass.id, method: 'manual' },
                clientTs: t.kit.clock.now(),
              })
            ).outcome
          : lookup(t.kit.ctx, actor, t.pass.id);
      if (route === 'resolve')
        expect(await request()).toMatchObject({ kind: 'ready', card: { passId: t.pass.id } });
      else expect(await request()).toMatchObject({ items: [{ passId: t.pass.id }] });
      const real = t.kit.env.DB;
      let capturedPending: Candidate | null = null;
      const race = raceFence(
        real,
        async () => {
          Object.assign(t.kit.env, { DB: real });
          try {
            const transfer = await startCredentialTransfer(
              jobCtxOf(t.kit),
              system,
              t.pass.id,
              { holderEmail: 'transfer-new@example.test', ownerUserId: null },
              null,
              { kind: 'tenant-holder', expected },
            );
            expect(transfer.state).toBe('pending');
            capturedPending = await candidateById(real, orgId, t.pass.id);
            if (!capturedPending) throw new Error('Missing pending transfer snapshot.');
            expect(capturedPending.transferPending).toBe(true);
            if (stage === 'completed')
              await finishProviderTransfer(
                t.kit,
                t.pass,
                t.operation.instanceId,
                transfer.transferId,
                t.credentialKeysetCommitment,
              );
          } finally {
            Object.assign(t.kit.env, { DB: race.db });
          }
        },
        route === 'lookup' ? 2 : 1,
      );
      Object.assign(t.kit.env, { DB: race.db });
      try {
        const result = await request();
        expect(race.fired()).toBe(true);
        if (route === 'resolve')
          expect(result).toMatchObject({
            kind: 'refused',
            reason: 'not_found',
            card: null,
            display: null,
          });
        else expect(result).toEqual({ items: [], more: false });
        expect(JSON.stringify(result)).not.toContain(t.pass.id);
        expect(JSON.stringify(result)).not.toContain('transfer-old@example.test');
      } finally {
        Object.assign(t.kit.env, { DB: real });
      }
      const pending = capturedPending as Candidate | null;
      if (!pending) throw new Error('Missing captured pending transfer.');
      expect(pending.pass.credentialGeneration).toBe(original.pass.credentialGeneration + 1);
      const pendingProof: OutputAuthority = {
        actor,
        event: actor.event,
        now: t.kit.clock.now(),
        templateId: pending.pass.templateId,
        credentialKeysetCommitment: pending.credentialKeysetCommitment,
        credentialTombstoneRefs: [],
        pass: pending.pass,
        connectionGeneration: pending.connectionGeneration,
        activeTemplateVersion: pending.activeTemplateVersion,
        orgRevision: pending.orgRevision,
        templateRevision: pending.templateRevision,
        release: pending,
        displayTemplateVersion: pending.displayTemplateVersion,
        checkInRules: pending.checkInRules,
        lookupHash: pending.lookupHash,
        requireActive: true,
      };
      expect(await outputAuthorityCurrent(real, pendingProof)).toBe(false);
      if (stage === 'completed') {
        const current = await candidateById(real, orgId, t.pass.id);
        if (!current) throw new Error('Missing completed transfer snapshot.');
        expect(current.transferPending).toBe(false);
        expect(current.pass.credentialGeneration).toBe(pending.pass.credentialGeneration);
        expect(current.pass.holderEmail).toBe('transfer-new@example.test');
        expect(current.pass.serial).not.toBe(original.pass.serial);
        const currentProof: OutputAuthority = {
          ...pendingProof,
          pass: current.pass,
          release: current,
          lookupHash: current.lookupHash,
          activeTemplateVersion: current.activeTemplateVersion,
          orgRevision: current.orgRevision,
          templateRevision: current.templateRevision,
          displayTemplateVersion: current.displayTemplateVersion,
          checkInRules: current.checkInRules,
        };
        expect(await outputAuthorityCurrent(real, currentProof)).toBe(true);
        expect(
          await outputAuthorityCurrent(real, {
            ...currentProof,
            pass: original.pass,
            release: original,
          }),
        ).toBe(false);
        expect(
          await outputAuthorityCurrent(real, {
            ...currentProof,
            release: { ...current, transferPending: pending.transferPending },
          }),
        ).toBe(false);
        if (route === 'resolve')
          expect(await request()).toMatchObject({ kind: 'ready', card: { passId: t.pass.id } });
        else expect(await request()).toMatchObject({ items: [{ passId: t.pass.id }] });
      }
    },
    180_000,
  );

  it.each(['resolve', 'lookup'] as const)(
    'masks %s when a different pass retires the submitted credential after projection',
    async (route) => {
      const t = await providerFixture();
      const orgId = t.kit.org.id;
      const token = t.pass.serial;
      const id = t.kit.fx.ids.id();
      const template = t.kit.registry.add({
        id,
        orgId,
        version: 'v1',
        manifest: {
          ...t.kit.template.manifest,
          name: 'Cross-pass credential fixture',
          // This Wallet intentionally contains the other pass's actual serial, not its generated scan code.
          bindings: t.kit.template.manifest.bindings.filter(
            (binding) => !('barcode' in binding.to),
          ),
          scan: {
            actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
            display: { v: 1, header: {}, photo: { minRole: 'door' } },
          },
        },
        passJson: {
          ...t.kit.template.passJson,
          barcodes: [
            { format: 'PKBarcodeFormatQR', message: token, messageEncoding: 'iso-8859-1' },
          ],
        },
        assets: { 'icon.png': ICON_PNG },
      });
      await persistTemplate(t.kit.fx, template, { registry: t.kit.registry });
      await approveAppleRelease(t.kit, { templateId: id, mode: 'live', version: template.version });
      const release = await requireApprovedRelease(t.kit.ctx, id, orgId, 'live', 'apple');
      const target = await createPassRow(jobCtxOf(t.kit), {
        orgId,
        templateId: id,
        templateVersion: release.version,
        releaseId: release.id,
        releaseGeneration: release.generation,
        input: { memberName: 'Cross Pass Private Person' } as never,
        holderEmail: 'cross-pass-private@example.test',
        externalId: token,
        mode: 'live',
        source: 'manual',
        actor: system,
        execution: { kind: 'system' },
      });
      await putMemberPhoto(
        t.kit.ctx,
        system,
        target.id,
        {
          png: btoa(String.fromCharCode(...makePng(270, 270))),
          includeInPass: false,
        },
        null,
      );
      const device = await makeScanner(t.kit.fx, { orgId, templateIds: [id] });
      const row = await getScanner(t.kit.env.DB, device.id);
      if (!row) throw new Error('Missing scanner.');
      const scope = await readScannerScope(t.kit.env.DB, row, null);
      const actor = await proofedScanActor(
        t.kit.ctx,
        withRole(scannerActor(t.kit.ctx, row, row.mode, 'cookie', scope), null),
      );
      const keys = await scanCredentialKeys(t.kit.env, orgId, 'live', token, false);
      expect(target.barcodeHash).toBe(keys.barcodeHash);
      expect(
        await credentialTombstonesClear(
          t.kit.env.DB,
          orgId,
          'live',
          keys.credentialTombstoneRefs,
          keys.credentialKeysetCommitment,
        ),
      ).toBe(true);
      const original = await candidateById(t.kit.env.DB, orgId, target.id);
      const source = await candidateById(t.kit.env.DB, orgId, t.pass.id);
      const expected = await getHolderPass(t.kit.env.DB, t.pass.id, null);
      if (!original || !source || !expected) throw new Error('Missing transfer source snapshot.');
      const request = async () =>
        route === 'resolve'
          ? (
              await resolveOutcome(t.kit.ctx, actor, {
                idempotencyKey: key(),
                input: { code: token, method: 'manual' },
                clientTs: t.kit.clock.now(),
              })
            ).outcome
          : lookup(t.kit.ctx, actor, token);
      const baseline = await request();
      if (route === 'resolve')
        expect(baseline).toMatchObject({ kind: 'ready', card: { passId: target.id } });
      else expect(baseline).toMatchObject({ items: [{ passId: target.id }] });
      const projected = baseline as {
        card?: { display?: { identity?: { photo?: { url?: string | null } | null } } } | null;
        items?: { photoUrl?: string | null }[];
      };
      const photoUrl =
        route === 'resolve'
          ? projected.card?.display?.identity?.photo?.url
          : projected.items?.[0]?.photoUrl;
      if (!photoUrl) throw new Error('Missing original credential-authorized photo.');
      const app = createApp({
        stores: { ...denyAllStores, scanners: createScannerStore(t.kit.env, t.kit.clock) },
        clock: t.kit.clock,
      });
      const photoHref = new URL(photoUrl, 'https://wallet.test').href;
      expect((await app.request(photoHref, { headers: device.headers }, t.kit.env)).status).toBe(
        200,
      );
      const real = t.kit.env.DB;
      const race = raceFence(
        real,
        async () => {
          Object.assign(t.kit.env, { DB: real });
          try {
            expect(
              (
                await startCredentialTransfer(
                  jobCtxOf(t.kit),
                  system,
                  t.pass.id,
                  { holderEmail: 'next@example.test', ownerUserId: null },
                  null,
                  { kind: 'tenant-holder', expected },
                )
              ).state,
            ).toBe('pending');
          } finally {
            Object.assign(t.kit.env, { DB: race.db });
          }
        },
        route === 'lookup' ? 2 : 1,
      );
      Object.assign(t.kit.env, { DB: race.db });
      try {
        const result = await request();
        expect(race.fired()).toBe(true);
        if (route === 'resolve')
          expect(result).toMatchObject({
            kind: 'refused',
            reason: 'not_found',
            card: null,
            display: null,
          });
        else expect(result).toEqual({ items: [], more: false });
        const text = JSON.stringify(result);
        for (const secret of [
          target.id,
          t.pass.id,
          token,
          'Cross Pass Private Person',
          'cross-pass-private@example.test',
          ...keys.credentialTombstoneRefs,
        ])
          expect(text).not.toContain(secret);
      } finally {
        Object.assign(t.kit.env, { DB: real });
      }
      expect(
        await credentialTombstonesClear(
          real,
          orgId,
          'live',
          keys.credentialTombstoneRefs,
          keys.credentialKeysetCommitment,
        ),
      ).toBe(false);
      expect((await app.request(photoHref, { headers: device.headers }, t.kit.env)).status).toBe(
        404,
      );
      const pending = await candidateById(real, orgId, t.pass.id);
      expect(pending?.transferPending).toBe(true);
      expect(pending!.pass.credentialGeneration).toBeGreaterThan(source.pass.credentialGeneration);
      const direct: OutputAuthority = {
        actor,
        event: actor.event,
        now: t.kit.clock.now(),
        templateId: id,
        pass: original.pass,
        credentialKeysetCommitment: original.credentialKeysetCommitment,
        credentialTombstoneRefs: [],
        connectionGeneration: original.connectionGeneration,
        activeTemplateVersion: original.activeTemplateVersion,
        orgRevision: original.orgRevision,
        templateRevision: original.templateRevision,
        release: original,
        displayTemplateVersion: original.displayTemplateVersion,
        checkInRules: original.checkInRules,
        lookupHash: original.lookupHash,
        requireActive: true,
      };
      expect(await outputAuthorityCurrent(real, direct)).toBe(true);
      expect(
        await outputAuthorityCurrent(real, {
          ...direct,
          credentialTombstoneRefs: keys.credentialTombstoneRefs,
        }),
      ).toBe(false);
    },
    180_000,
  );
});
