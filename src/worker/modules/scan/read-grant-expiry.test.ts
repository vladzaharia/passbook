import { describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { first, run } from '../../platform/db.ts';
import { depsOf, overrideDeps } from '../passes/deps.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { scannerActor, withRole } from './actor.ts';
import { assetGrantTokenHash } from './assets.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { lookup } from './lookup.ts';
import { kit, registerLookupOutputFixture, templateId } from './lookup-output-test-fixtures.ts';
import {
  clockDuringGrant,
  GROUP,
  grants,
  measured,
  PRIVATE_EMAIL,
  photoPass,
  principal,
} from './read-grant-expiry-core-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { key, proofedScanActor } from './test-kit.ts';

registerLookupOutputFixture();

const request = (passId: string) => ({
  idempotencyKey: key(),
  input: { passId, method: 'manual' as const },
  clientTs: kit.clock.now(),
});

function noDisclosure(
  text: string,
  passes: { id: string; serial: string; scanCode: string | null }[],
  names: string[],
  allowOtherPhoto = false,
) {
  for (const pass of passes) {
    expect(text).not.toContain(pass.id);
    expect(text).not.toContain(pass.serial);
    if (pass.scanCode) expect(text).not.toContain(pass.scanCode);
  }
  for (const name of names) expect(text).not.toContain(name);
  expect(text).not.toContain(PRIVATE_EMAIL);
  if (!allowOtherPhoto) expect(text).not.toContain('member.png');
  expect(text).not.toContain('assetGrant');
}

async function expireWallet(passId: string) {
  expect(
    await run(
      kit.env.DB,
      "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.expirationDate',?) WHERE pass_id=?",
      [new Date(kit.clock.now() + 1_000).toISOString(), passId],
    ),
  ).toEqual({ changes: 1 });
}

async function expectOnlyPhotoGrant(url: string) {
  const token = new URL(url, 'https://wallet.test').searchParams.get('g');
  const tokenHash = await assetGrantTokenHash(token ?? undefined);
  expect(tokenHash).not.toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT token_hash FROM scan_asset_grant_provenance WHERE org_id=?', [
      kit.org.id,
    ]),
  ).toEqual({ token_hash: tokenHash });
  expect(await grants()).toBe(1);
}

describe('read grant final-clock authority', () => {
  const cases = (
    [
      'session idle',
      'session absolute',
      'scanner absolute',
      'staff idle',
      'staff absolute',
    ] as const
  ).flatMap((kind) => (['resolve', 'lookup'] as const).map((route) => [kind, route] as const));

  it.each(cases)(
    'withholds %s authority expiring during %s grant planning',
    async (kind, route) => {
      const names = ['Expiry Private First', 'Expiry Private Second'];
      const passes = [await photoPass(names[0]!)];
      if (route === 'lookup') passes.push(await photoPass(names[1]!));
      const actor = await principal(kind);
      expect(await grants()).toBe(0);
      const body = route === 'resolve' ? request(passes[0]!.id) : { q: GROUP };
      const result = await measured(actor.post, route, body, {
        race: {
          passId: passes[0]!.id,
          snapshotOccurrence: route === 'resolve' ? 3 : 2,
          advance: actor.advance,
        },
      });
      expect(result.grantBatchAt).toBe(kit.clock.now());
      expect(result.response.status).toBe(200);
      const text = await result.response.text();
      if (route === 'resolve') {
        expect(ScanOutcomeSchema.parse(JSON.parse(text))).toMatchObject({
          kind: 'refused',
          reason: 'not_found',
          card: null,
          display: null,
          template: null,
        });
      } else {
        expect(ScanLookupResultSchema.parse(JSON.parse(text))).toEqual({ items: [], more: false });
      }
      noDisclosure(text, passes, names);
      expect(await grants()).toBe(0);
    },
  );

  it.each(['resolve', 'lookup'] as const)(
    'rejects scanner idle expiry in the captured actor during %s preparation',
    async (route) => {
      const name = 'Idle Scanner Private Member';
      const pass = await photoPass(name);
      // A live route refreshes an old last_seen_at; retain the real pre-refresh actor to test this boundary.
      const scanner = await kit.scanner({
        templateIds: [templateId],
        lastSeenAt: kit.clock.now() - DEVICE_IDLE_MS + 1_000,
      });
      const row = await getScanner(kit.env.DB, scanner.id);
      if (!row) throw new Error('Missing scanner fixture');
      const scope = await readScannerScope(kit.env.DB, row, null);
      const actor = await proofedScanActor(
        kit.ctx,
        withRole(scannerActor(kit.ctx, row, row.mode, 'cookie', scope), null),
        { keysetPolicy: 'defer' },
      );
      const counted = countD1(kit.env.DB);
      const ctx = { ...kit.ctx, env: { ...kit.env, DB: counted.db } };
      overrideDeps(ctx.env, depsOf(kit.env));
      clearSettingsCache(counted.db);
      const race = clockDuringGrant(kit.clock, {
        passId: pass.id,
        orgId: kit.org.id,
        snapshotOccurrence: route === 'resolve' ? 3 : 2,
        advance: 2_000,
      });
      let result: unknown;
      try {
        result =
          route === 'resolve'
            ? (await resolveOutcome(ctx, actor, request(pass.id))).outcome
            : await lookup(ctx, actor, GROUP);
        expect(race.fired()).toBe(true);
        expect(counted.count()).toBeLessThanOrEqual(5);
      } finally {
        race.restore();
      }
      if (route === 'resolve')
        expect(result).toMatchObject({ reason: 'not_found', card: null, display: null });
      else expect(result).toEqual({ items: [], more: false });
      noDisclosure(JSON.stringify(result), [pass], [name]);
      expect(await grants()).toBe(0);
    },
  );

  it('does not leave either resolve capability when its Wallet expires during final planning', async () => {
    const name = 'Expiring Wallet Private Member';
    const pass = await photoPass(name);
    await expireWallet(pass.id);
    const actor = await principal('valid');
    const result = await measured(actor.post, 'resolve', request(pass.id), {
      race: {
        passId: pass.id,
        snapshotOccurrence: 3,
        advance: 2_000,
      },
    });
    expect(result.grantBatchAt).toBe(kit.clock.now());
    expect(result.response.status).toBe(200);
    const text = await result.response.text();
    expect(JSON.parse(text)).toMatchObject({ reason: 'not_found', card: null, display: null });
    noDisclosure(text, [pass], [name]);
    expect(await grants()).toBe(0);
  });

  it('resamples after an earlier photo plan when another guard finishes, masking only the expired Wallet', async () => {
    const expiredName = 'Expired Early Photo Member';
    const validName = 'Current Late Photo Member';
    const expired = await photoPass(expiredName);
    const valid = await photoPass(validName);
    await expireWallet(expired.id);
    const actor = await principal('valid');
    if (!actor.scannerId || !actor.headers) throw new Error('Missing scanner fixture');
    const result = await measured(
      actor.post,
      'lookup',
      { q: GROUP },
      {
        race: {
          passId: valid.id,
          firstPhotoId: expired.id,
          scannerId: actor.scannerId,
          snapshotOccurrence: 2,
          advance: 2_000,
        },
      },
    );
    expect(result.events).toEqual([
      'first photo prepared',
      'second photo signing',
      'first guard prepared',
      'clock advanced',
    ]);
    expect(result.grantBatchAt).toBe(kit.clock.now());
    expect(result.response.status).toBe(200);
    const text = await result.response.text();
    const body = ScanLookupResultSchema.parse(JSON.parse(text));
    expect(body.more).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      passId: valid.id,
      title: validName,
      photoUrl: expect.any(String),
    });
    noDisclosure(text, [expired], [expiredName], true);
    const url = body.items[0]!.photoUrl!;
    expect(url).toContain(`/passes/${valid.id}/assets/member.png?g=`);
    await expectOnlyPhotoGrant(url);
    expect((await kit.get(actor.headers, url.replace('/api/v1/scan', ''))).status).toBe(200);
  });

  it('masks an earlier expired photo grant while retaining a later still-valid grant', async () => {
    const earlier = await photoPass('Earlier Grant Member');
    const later = await photoPass('Later Grant Member');
    const actor = await principal('valid');
    if (!actor.scannerId || !actor.headers) throw new Error('Missing scanner fixture');
    const start = kit.clock.now();
    const result = await measured(
      actor.post,
      'lookup',
      { q: GROUP },
      {
        race: {
          passId: later.id,
          firstPhotoId: earlier.id,
          scannerId: actor.scannerId,
          staggerAdvance: 2_000,
          snapshotOccurrence: 2,
          advance: 3_598_001,
        },
      },
    );
    expect(result.events).toEqual([
      'first photo prepared',
      'clock staggered',
      'second photo signing',
      'first guard prepared',
      'clock advanced',
    ]);
    expect(kit.clock.now()).toBe(start + 3_600_001);
    expect(result.grantBatchAt).toBe(kit.clock.now());
    expect(result.response.status).toBe(200);
    const body = ScanLookupResultSchema.parse(await result.response.json());
    expect(body.more).toBe(false);
    expect(body.items).toHaveLength(2);
    expect(body.items.find((item) => item.passId === earlier.id)).toMatchObject({
      title: 'Earlier Grant Member',
      photoUrl: null,
    });
    const url = body.items.find((item) => item.passId === later.id)?.photoUrl;
    expect(url).toContain(`/passes/${later.id}/assets/member.png?g=`);
    await expectOnlyPhotoGrant(url!);
    expect(
      await first(kit.env.DB, 'SELECT expires_at FROM scan_asset_grant_provenance WHERE org_id=?', [
        kit.org.id,
      ]),
    ).toEqual({ expires_at: start + 3_602_000 });
    expect((await kit.get(actor.headers, url!.replace('/api/v1/scan', ''))).status).toBe(200);
  });

  it('keeps a photo-removed identity masked without disturbing an independently valid photo', async () => {
    const hidden = await photoPass('Photo Removed Member');
    const valid = await photoPass('Photo Still Current Member');
    const actor = await principal('valid');
    const real = kit.env.DB;
    let removed = false;
    const result = await measured(
      actor.post,
      'lookup',
      { q: GROUP },
      {
        beforeGrantBatch: async () => {
          expect(await run(real, 'DELETE FROM member_photos WHERE pass_id=?', [hidden.id])).toEqual(
            { changes: 1 },
          );
          removed = true;
        },
      },
    );
    expect(removed).toBe(true);
    expect(result.response.status).toBe(200);
    const body = ScanLookupResultSchema.parse(await result.response.json());
    expect(body.more).toBe(false);
    expect(body.items.find((item) => item.passId === hidden.id)).toMatchObject({ photoUrl: null });
    const url = body.items.find((item) => item.passId === valid.id)?.photoUrl;
    expect(url).toContain(`/passes/${valid.id}/assets/member.png?g=`);
    await expectOnlyPhotoGrant(url!);
  });

  it('retains fresh photo and pass-view capabilities for a resolve and multi-entry lookup', async () => {
    const firstPass = await photoPass('Fresh First Member');
    const secondPass = await photoPass('Fresh Second Member');
    const actor = await principal('valid');
    if (!actor.headers) throw new Error('Missing scanner headers');
    const resolved = await measured(actor.post, 'resolve', request(firstPass.id));
    expect(resolved.grantBatchAt).toBe(kit.clock.now());
    expect(resolved.response.status).toBe(200);
    const outcome = ScanOutcomeSchema.parse(await resolved.response.json());
    expect(outcome).toMatchObject({ kind: 'ready', card: { passId: firstPass.id } });
    expect(outcome.card?.passView.assetGrant).toMatch(/^[A-Za-z0-9_-]{54}$/);
    const resolvedPhoto = outcome.card?.display.identity.photo?.url;
    expect(resolvedPhoto).toContain(`/passes/${firstPass.id}/assets/member.png?g=`);
    expect((await kit.get(actor.headers, resolvedPhoto!.replace('/api/v1/scan', ''))).status).toBe(
      200,
    );
    expect(await grants()).toBe(2);

    const searched = await measured(actor.post, 'lookup', { q: GROUP });
    expect(searched.grantBatchAt).toBe(kit.clock.now());
    expect(searched.response.status).toBe(200);
    const body = ScanLookupResultSchema.parse(await searched.response.json());
    expect(body.items.map((item) => item.passId).sort()).toEqual(
      [firstPass.id, secondPass.id].sort(),
    );
    expect(body.more).toBe(false);
    for (const pass of [firstPass, secondPass]) {
      const url = body.items.find((item) => item.passId === pass.id)?.photoUrl;
      expect(url).toContain(`/passes/${pass.id}/assets/member.png?g=`);
      expect((await kit.get(actor.headers, url!.replace('/api/v1/scan', ''))).status).toBe(200);
    }
    expect(await grants()).toBe(4);
  });
});
