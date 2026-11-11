import { beforeAll, describe, expect, it } from 'vitest';
import type { PassJson } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { deleteMemberPhoto, putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { replaceCallbackKeysetForTest } from '../wallet-providers/callbacks-test-fixtures.ts';
import { grantInsertConfirmed } from './asset-grant-results.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { confirmedPhotoUrl, knownPhotoUrl, scannerPassActive } from './member-photo.ts';
import { scanPhotoUrl } from './member-photo-url.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { candidateById } from './repo-lookup.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
const bytes = makePng(270, 270);
const png = btoa(String.fromCharCode(...bytes));
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  template = await kit.scanTemplate('Photo membership', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});
const read = async (headers: Record<string, string>, code: ReturnType<typeof codeOf>) =>
  (await (
    await kit.post(headers, '/actions', {
      idempotencyKey: key(),
      input: code,
      actionId: 'auto',
      clientTs: kit.clock.now(),
    })
  ).json()) as ScanOutcome;

describe('scanner member photos', () => {
  it('does not initialize a missing credential keyset when requesting a photo URL', async () => {
    const scoped = await setupScanKit();
    await ensureCredentialRefKeyset(scoped.env.DB, scoped.env);
    const templateId = await scoped.scanTemplate('Read-only photo keyset', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const scanner = await scoped.scanner({ templateIds: [templateId] });
    const pass = await scoped.scanPass(templateId);
    await putMemberPhoto(
      scoped.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const actor = await assetActorFor(scoped, scanner);
    await replaceCallbackKeysetForTest(scoped.env.DB, null);
    await expect(scanPhotoUrl(scoped.ctx, actor, pass.id)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    expect(
      await first(scoped.env.DB, 'SELECT id FROM credential_ref_keyset WHERE id=1'),
    ).toBeNull();
    expect(
      await first(scoped.env.DB, 'SELECT token_hash FROM scan_asset_grant_provenance'),
    ).toBeNull();
  });
  it('renders a private photo and binds its image grant to the scanning device', async () => {
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template] });
    const other = await kit.scanner({ templateIds: [template] });
    const out = await read(scanner.headers, codeOf(pass));
    expect(out.kind).toBe('ok');
    const url = out.display?.identity.photo?.url;
    expect(url).toContain(`/passes/${pass.id}/assets/member.png?g=`);
    const path = (url ?? '').replace('/api/v1/scan', '');
    const image = await kit.get(scanner.headers, path);
    expect(image.status).toBe(200);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    expect((await kit.get(other.headers, path)).status).toBe(404);
    expect((await kit.get({}, path)).status).toBe(401);
    kit.clock.advance(3_600_001);
    expect((await kit.get(scanner.headers, path)).status).toBe(404);
  });

  it('honors the scanner photo setting', async () => {
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template], settings: { showPhoto: false } });
    expect((await read(scanner.headers, codeOf(pass))).display?.identity.photo).toBeNull();
  });

  it('preserves a template photo role restriction', async () => {
    const restricted = await kit.scanTemplate('Desk photo', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, photo: { minRole: 'desk' }, header: {} },
    });
    const pass = await kit.scanPass(restricted);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [restricted] });
    expect((await read(scanner.headers, codeOf(pass))).display?.identity.photo).toBeNull();
  });

  it('requires valid wallet state and an exact connection-generation shape', async () => {
    const pass = await kit.scanPass(template);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate?.passJsonSnapshot) throw new Error('Missing pass fixture.');
    const json = JSON.parse(candidate.passJsonSnapshot) as PassJson;
    const now = kit.clock.now();
    expect(scannerPassActive(candidate, json, now)).toBe(true);
    for (const altered of [
      { ...json, serialNumber: 'different-serial' },
      { ...json, passTypeIdentifier: 'pass.invalid.type' },
      { ...json, teamIdentifier: 'INVALIDTEAM' },
    ]) {
      expect(scannerPassActive(candidate, altered, now)).toBe(false);
    }
    expect(scannerPassActive({ ...candidate, passJsonSnapshot: null }, json, now)).toBe(false);
    expect(scannerPassActive({ ...candidate, identityPassTypeIdentifier: null }, json, now)).toBe(
      false,
    );
    expect(scannerPassActive({ ...candidate, identityTeamIdentifier: null }, json, now)).toBe(
      false,
    );
    for (const identityRevision of [null, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(scannerPassActive({ ...candidate, identityRevision }, json, now)).toBe(false);
    }
    for (const voided of ['false', null, 0]) {
      expect(scannerPassActive(candidate, { ...json, voided } as unknown as PassJson, now)).toBe(
        false,
      );
    }
    for (const expirationDate of [
      'invalid',
      '2026-01-01',
      '2026-01-01T12:00:00',
      'Mon, 01 Jan 2035 00:00:00 GMT',
      null,
    ]) {
      expect(
        scannerPassActive(candidate, { ...json, expirationDate } as unknown as PassJson, now),
      ).toBe(false);
    }
    expect(
      scannerPassActive(
        candidate,
        { ...json, expirationDate: new Date(now - 1).toISOString() },
        now,
      ),
    ).toBe(false);
    expect(
      scannerPassActive(candidate, { ...json, expirationDate: new Date(now).toISOString() }, now),
    ).toBe(true);
    expect(
      scannerPassActive(
        candidate,
        { ...json, expirationDate: new Date(now + 1).toISOString() },
        now,
      ),
    ).toBe(true);
    expect(scannerPassActive({ ...candidate, connectionGeneration: 1 }, json, now)).toBe(false);
    expect(
      scannerPassActive(
        {
          ...candidate,
          pass: { ...candidate.pass, connectionId: 'missing' },
          connectionGeneration: null,
        },
        json,
        now,
      ),
    ).toBe(false);
    expect(
      scannerPassActive(
        {
          ...candidate,
          pass: { ...candidate.pass, connectionId: 'linked' },
          connectionGeneration: -1,
        },
        json,
        now,
      ),
    ).toBe(false);
  });

  it('keeps a cloneable photo plan tokenless until its guarded insert is confirmed', async () => {
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template] });
    const actor = await assetActorFor(kit, scanner);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Pass fixture missing');
    const pinned = await kit.registry.resolve(template, candidate.pass.templateVersion);
    const prepared = await knownPhotoUrl(kit.ctx, actor, candidate, pinned);
    if (!prepared) throw new Error('Photo grant plan missing');
    const clone = structuredClone(prepared);
    expect(prepared).not.toHaveProperty('url');
    expect(confirmedPhotoUrl(actor, pass.id, prepared.grant, undefined)).toBeNull();
    const cloneBind = await prepareAssetGrantInsertion(kit.ctx, clone.grant, undefined, candidate);
    await expect(kit.env.DB.batch(cloneBind(kit.clock.now(), undefined))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
    const bind = await prepareAssetGrantInsertion(kit.ctx, prepared.grant, undefined, candidate);
    const inserted = await kit.env.DB.batch(bind(kit.clock.now(), undefined));
    expect(grantInsertConfirmed(inserted)).toBe(true);
    expect(confirmedPhotoUrl(actor, pass.id, clone.grant, inserted)).toBeNull();
    const otherScanner = await kit.scanner({ templateIds: [template] });
    const otherActor = await assetActorFor(kit, otherScanner);
    expect(confirmedPhotoUrl(otherActor, pass.id, prepared.grant, inserted)).toBeNull();
    const changedSettings = {
      ...actor,
      settings: { ...actor.settings, lookup: !actor.settings.lookup },
    };
    expect(confirmedPhotoUrl(changedSettings, pass.id, prepared.grant, inserted)).toBeNull();
    const changedKeyset = { ...actor, credentialKeysetCommitment: '0'.repeat(64) };
    expect(confirmedPhotoUrl(changedKeyset, pass.id, prepared.grant, inserted)).toBeNull();
    expect(confirmedPhotoUrl(actor, `${pass.id}-other`, prepared.grant, inserted)).toBeNull();
    const wrongHash = inserted.map((result, index) =>
      index === 0 ? { ...result, results: [{ token_hash: '0'.repeat(64) }] } : result,
    );
    expect(confirmedPhotoUrl(actor, pass.id, prepared.grant, wrongHash)).toBeNull();
    const url = confirmedPhotoUrl(actor, pass.id, prepared.grant, inserted);
    if (!url) throw new Error('Confirmed photo URL missing');
    expect(confirmedPhotoUrl(actor, pass.id, prepared.grant, inserted)).toBeNull();
    const after = await kit.get(scanner.headers, url.replace('/api/v1/scan', ''));
    expect(after.status).toBe(200);
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(bytes);
  });

  it('does not insert a prepared grant after the observed photo is removed', async () => {
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template] });
    const actor = await assetActorFor(kit, scanner);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Pass fixture missing');
    const pinned = await kit.registry.resolve(template, candidate.pass.templateVersion);
    const prepared = await knownPhotoUrl(kit.ctx, actor, candidate, pinned);
    if (!prepared) throw new Error('Photo grant plan missing');
    const bind = await prepareAssetGrantInsertion(kit.ctx, prepared.grant, undefined, candidate);
    await deleteMemberPhoto(kit.ctx, { type: 'system', id: null }, pass.id, null);
    await expect(kit.env.DB.batch(bind(kit.clock.now(), undefined))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
    expect(confirmedPhotoUrl(actor, pass.id, prepared.grant, undefined)).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT token_hash FROM scan_asset_grant_provenance WHERE token_hash=?',
        [prepared.grant.tokenHash],
      ),
    ).toBeNull();
  });

  it.each([0, 1])(
    'does not insert a photo grant %i ms at or after its prepared expiry',
    async (offset) => {
      const pass = await kit.scanPass(template);
      await putMemberPhoto(
        kit.ctx,
        { type: 'system', id: null },
        pass.id,
        { png, includeInPass: false },
        null,
      );
      const scanner = await kit.scanner({ templateIds: [template] });
      const actor = await assetActorFor(kit, scanner);
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate) throw new Error('Pass fixture missing');
      const pinned = await kit.registry.resolve(template, candidate.pass.templateVersion);
      const prepared = await knownPhotoUrl(kit.ctx, actor, candidate, pinned);
      if (!prepared) throw new Error('Photo grant plan missing');
      expect(prepared.grant.expiresAt).toBeGreaterThan(kit.clock.now());
      const bind = await prepareAssetGrantInsertion(kit.ctx, prepared.grant, undefined, candidate);
      kit.clock.advance(prepared.grant.expiresAt - kit.clock.now() + offset);
      expect(kit.clock.now()).toBe(prepared.grant.expiresAt + offset);
      await expect(kit.env.DB.batch(bind(kit.clock.now(), undefined))).rejects.toThrow(
        'scan_asset_authority_failed',
      );
      expect(confirmedPhotoUrl(actor, pass.id, prepared.grant, undefined)).toBeNull();
      expect(
        await first(
          kit.env.DB,
          'SELECT token_hash FROM scan_asset_grant_provenance WHERE token_hash=?',
          [prepared.grant.tokenHash],
        ),
      ).toBeNull();
    },
  );
});
