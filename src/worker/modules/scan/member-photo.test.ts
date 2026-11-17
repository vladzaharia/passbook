import { beforeAll, describe, expect, it } from 'vitest';
import type { PassJson } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { deleteMemberPhoto, putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { replaceCallbackKeysetForTest } from '../wallet-providers/callbacks-test-fixtures.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { knownPhotoUrl, photoGrantUrl, scannerPassActive } from './member-photo.ts';
import { scanPhotoUrl } from './member-photo-url-test-fixtures.ts';
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

  it('keeps a cloneable photo plan tokenless and releases its URL only to the recipient it was minted for', async () => {
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
    expect(photoGrantUrl(actor, pass.id, clone.grant)).toBeNull();
    const otherScanner = await kit.scanner({ templateIds: [template] });
    const otherActor = await assetActorFor(kit, otherScanner);
    expect(photoGrantUrl(otherActor, pass.id, prepared.grant)).toBeNull();
    const changedSettings = {
      ...actor,
      settings: { ...actor.settings, lookup: !actor.settings.lookup },
    };
    expect(photoGrantUrl(changedSettings, pass.id, prepared.grant)).toBeNull();
    const changedKeyset = { ...actor, credentialKeysetCommitment: '0'.repeat(64) };
    expect(photoGrantUrl(changedKeyset, pass.id, prepared.grant)).toBeNull();
    expect(photoGrantUrl(actor, `${pass.id}-other`, prepared.grant)).toBeNull();
    const url = photoGrantUrl(actor, pass.id, prepared.grant);
    if (!url) throw new Error('Photo URL missing');
    const after = await kit.get(scanner.headers, url.replace('/api/v1/scan', ''));
    expect(after.status).toBe(200);
    expect(new Uint8Array(await after.arrayBuffer())).toEqual(bytes);
  });

  it('does not serve a photo that was removed after its grant was minted', async () => {
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
    const url = photoGrantUrl(actor, pass.id, prepared.grant)?.replace('/api/v1/scan', '');
    if (!url) throw new Error('Photo URL missing');
    // Positive control: served before the photo is removed.
    expect((await kit.get(scanner.headers, url)).status).toBe(200);
    await deleteMemberPhoto(kit.ctx, { type: 'system', id: null }, pass.id, null);
    const gone = await kit.get(scanner.headers, url);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it.each([0, 1])('does not serve a photo grant %i ms at or after its expiry', async (offset) => {
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
    const url = photoGrantUrl(actor, pass.id, prepared.grant)?.replace('/api/v1/scan', '');
    if (!url) throw new Error('Photo URL missing');
    // Positive control: one millisecond before expiry it is served.
    kit.clock.advance(prepared.grant.expiresAt - kit.clock.now() - 1);
    expect((await kit.get(scanner.headers, url)).status).toBe(200);
    kit.clock.advance(1 + offset);
    expect(kit.clock.now()).toBe(prepared.grant.expiresAt + offset);
    expect((await kit.get(scanner.headers, url)).status).toBe(404);
  });
});
