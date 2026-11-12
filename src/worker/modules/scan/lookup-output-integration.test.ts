import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { scannerActor, withRole } from './actor.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { lookup } from './lookup.ts';
import {
  interceptBatches,
  kit,
  registerLookupOutputFixture,
  resolveRequest,
  retireRef,
  scannerForLookup,
  setupPhoto,
  templateId,
  useKeysetlessDatabase,
} from './lookup-output-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { key, makeLegacyScanPass, proofedScanActor } from './test-kit.ts';

registerLookupOutputFixture();

describe('lookup output authority', () => {
  it('keeps same-mode resolve, lookup, and photo visible when only the other mode retired the input', async () => {
    const live = await setupPhoto();
    const retired = await kit.scanPass(templateId, {}, { mode: 'test' });
    const { scanner, actor } = await scannerForLookup();
    const keys = await scanCredentialKeys(kit.env, kit.org.id, 'live', live.scanCode!);
    await retireRef(retired, keys.otherModeCredentialTombstoneRefs[0]!);

    const found = await lookup(kit.ctx, actor, live.scanCode!);
    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.passId).toBe(live.id);
    const photo = found.items[0]?.photoUrl;
    expect(photo).toContain(`/passes/${live.id}/assets/member.png?g=`);
    expect((await kit.get(scanner.headers, photo!.replace('/api/v1/scan', ''))).status).toBe(200);
    const resolved = await resolveOutcome(kit.ctx, actor, resolveRequest(live.scanCode!));
    expect(resolved.outcome).toMatchObject({ kind: 'ready', card: { passId: live.id } });
    expect(resolved.evaluatedSnapshot?.pass.id).toBe(live.id);
    expect(resolved.credentialContext?.credentialKeysetCommitment).toBe(
      keys.credentialKeysetCommitment,
    );
    expect(resolved.credentialContext?.credentialTombstoneRefs).toEqual(
      keys.credentialTombstoneRefs,
    );
    expect(resolved.credentialContext?.otherModeCredentialTombstoneRefs).toEqual(
      keys.otherModeCredentialTombstoneRefs,
    );
  });

  it('requires both mode reference sets clear before returning a passless mode warning', async () => {
    const target = await kit.scanPass(templateId, {}, { mode: 'test' });
    const retired = await kit.scanPass(templateId, {}, { mode: 'test' });
    const { actor } = await scannerForLookup();
    const keys = await scanCredentialKeys(kit.env, kit.org.id, 'live', target.scanCode!);
    expect(
      (await resolveOutcome(kit.ctx, actor, resolveRequest(target.scanCode!))).outcome.reason,
    ).toBe('test_pass');
    await retireRef(retired, keys.otherModeCredentialTombstoneRefs[0]!);
    const after = await resolveOutcome(kit.ctx, actor, resolveRequest(target.scanCode!));
    expect(after.outcome).toMatchObject({ reason: 'not_found', card: null, display: null });
    expect(after.evaluatedSnapshot).toBeNull();
    expect(after.credentialContext).toBeNull();

    const second = await kit.scanPass(templateId, {}, { mode: 'test' });
    const retiredLive = await kit.scanPass(templateId);
    const liveKeys = await scanCredentialKeys(kit.env, kit.org.id, 'live', second.scanCode!);
    expect(
      (await resolveOutcome(kit.ctx, actor, resolveRequest(second.scanCode!))).outcome.reason,
    ).toBe('test_pass');
    await retireRef(retiredLive, liveKeys.credentialTombstoneRefs[0]!);
    const liveBlocked = await resolveOutcome(kit.ctx, actor, resolveRequest(second.scanCode!));
    expect(liveBlocked.outcome).toMatchObject({ reason: 'not_found', card: null, display: null });
    expect(liveBlocked.credentialContext).toBeNull();
  });

  it('does not issue a mode warning if a same-mode candidate appears before final CAS', async () => {
    const target = await kit.scanPass(templateId, {}, { mode: 'test' });
    const live = await kit.scanPass(templateId);
    const { actor } = await scannerForLookup();
    const real = kit.env.DB;
    const barcodeHash = await barcodeHashOfCode(cleanCode(target.scanCode!));
    let changed = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (
        !changed &&
        sql.some((text) => text.includes('AS authorized')) &&
        !sql.some((text) => text.includes('INSERT INTO credential_ref_keyset'))
      ) {
        changed = true;
        await run(real, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
          barcodeHash,
          live.id,
        ]);
      }
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    const result = await resolveOutcome(ctx, actor, resolveRequest(target.scanCode!));
    expect(changed).toBe(true);
    expect(result.outcome).toMatchObject({ reason: 'not_found', card: null, display: null });
    expect(result.credentialContext).toBeNull();
  });

  it('does not return wrong-event after a matching accepted candidate appears', async () => {
    const wrong = await kit.scanPass(templateId, { tier: 'silver' });
    const accepted = await kit.scanPass(templateId, { tier: 'gold' });
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET match_input=?,match_values=? WHERE id=?', [
      'tier',
      '["gold"]',
      event.id,
    ]);
    const scanner = await kit.scanner({ eventId: event.id });
    const row = await getScanner(kit.env.DB, scanner.id);
    if (!row) throw new Error('Missing scanner fixture');
    const scope = await readScannerScope(kit.env.DB, row, null);
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
    );
    const real = kit.env.DB;
    const barcodeHash = await barcodeHashOfCode(cleanCode(wrong.scanCode!));
    let candidateBatch = false;
    let changed = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (sql.some((text) => text.includes('INSERT INTO credential_ref_keyset')))
        candidateBatch = true;
      else if (candidateBatch && !changed && sql.some((text) => text.includes('AS authorized'))) {
        changed = true;
        await run(real, 'UPDATE passes SET barcode_hash=?,revision=revision+1 WHERE id=?', [
          barcodeHash,
          accepted.id,
        ]);
      }
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    const result = await resolveOutcome(ctx, actor, resolveRequest(wrong.scanCode!));
    expect(changed).toBe(true);
    expect(result.outcome).toMatchObject({ reason: 'not_found', card: null, display: null });
    expect(result.credentialContext).toBeNull();
  });

  it('only exposes a last-scan time backed by a matching ledger event', async () => {
    // Event proofs are gone; the reader checks the ledger's recorded facts against the scan row.
    const pass = await setupPhoto();
    const { scanner, actor } = await scannerForLookup();
    const response = await kit.post(scanner.headers, '/actions', {
      ...resolveRequest(pass.scanCode!),
      actionId: 'enter',
    });
    expect(response.status).toBe(200);
    const scan = (await response.json()) as { kind: string; scanId: string | null };
    expect(scan.kind).toBe('ok');
    expect(scan.scanId).toBeTruthy();
    expect((await lookup(kit.ctx, actor, pass.id)).items[0]?.lastScanAt).toBe(kit.clock.now());
    await run(
      kit.env.DB,
      `UPDATE pass_events SET data=json_set(data,'$.authority.scanAt',?)
      WHERE pass_id=? AND json_extract(data,'$.scanId')=?`,
      [kit.clock.now() - 1, pass.id, scan.scanId],
    );
    const after = await lookup(kit.ctx, actor, pass.id);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.lastScanAt).toBeNull();
  });

  it('bootstraps a missing keyset only in the authenticated first search batch', async () => {
    await useKeysetlessDatabase();
    const template = await kit.registry.resolve(templateId);
    const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const { actor } = await scannerForLookup();
    const real = kit.env.DB;
    expect(await first(real, 'SELECT commitment FROM credential_ref_keyset WHERE id=1')).toBeNull();
    const { db, batches } = interceptBatches(real);
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    expect((await lookup(ctx, actor, pass.id)).items.map((item) => item.passId)).toEqual([pass.id]);
    const bootstrap = batches.find((batch) =>
      batch.some((sql) => sql.includes('INSERT INTO credential_ref_keyset')),
    );
    expect(bootstrap).toBeDefined();
    expect(bootstrap?.some((sql) => sql.includes('FROM passes p JOIN templates t'))).toBe(true);
    expect(bootstrap?.find((sql) => sql.includes('INSERT INTO credential_ref_keyset'))).toContain(
      'csrf_actor_scanner',
    );
    expect(await first(real, 'SELECT commitment FROM credential_ref_keyset WHERE id=1')).toEqual({
      commitment: actor.credentialKeysetCommitment,
    });
  });

  it('bootstraps resolve with the original actor and candidate in the same batch', async () => {
    await useKeysetlessDatabase();
    const template = await kit.registry.resolve(templateId);
    const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const { actor } = await scannerForLookup();
    const real = kit.env.DB;
    expect(await first(real, 'SELECT commitment FROM credential_ref_keyset WHERE id=1')).toBeNull();
    const { db, batches } = interceptBatches(real);
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    const result = await resolveOutcome(ctx, actor, {
      idempotencyKey: key(),
      input: { passId: pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(result.outcome).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    expect(result.credentialContext?.credentialTombstoneRefs).toEqual([]);
    const bootstrap = batches.find((batch) =>
      batch.some((sql) => sql.includes('INSERT INTO credential_ref_keyset')),
    );
    // The candidate read, identified by its keyset column; SQL balancing rewrites its WHERE.
    expect(
      bootstrap?.some(
        (sql) =>
          sql.includes('FROM passes p') &&
          sql.includes('credential_keyset.commitment AS credential_keyset_commitment'),
      ),
    ).toBe(true);
    expect(bootstrap?.find((sql) => sql.includes('INSERT INTO credential_ref_keyset'))).toContain(
      'csrf_actor_scanner',
    );
    expect(await first(real, 'SELECT commitment FROM credential_ref_keyset WHERE id=1')).toEqual({
      commitment: result.credentialContext?.credentialKeysetCommitment,
    });
  });

  it('does not bootstrap if the original scanner is revoked before the search batch', async () => {
    await useKeysetlessDatabase();
    const template = await kit.registry.resolve(templateId);
    const pass = await makeLegacyScanPass(kit.fx, { orgId: kit.org.id, template });
    const { scanner, actor } = await scannerForLookup();
    const real = kit.env.DB;
    let revoked = false;
    const { db } = interceptBatches(real, async (sql) => {
      if (!revoked && sql.some((text) => text.includes('INSERT INTO credential_ref_keyset'))) {
        revoked = true;
        await run(real, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          scanner.id,
        ]);
      }
    });
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: db } };
    overrideDeps(ctx.env, depsOf(kit.env));
    expect(await lookup(ctx, actor, pass.id)).toEqual({ items: [], more: false });
    expect(revoked).toBe(true);
    expect(await first(real, 'SELECT commitment FROM credential_ref_keyset WHERE id=1')).toBeNull();
  });
});
