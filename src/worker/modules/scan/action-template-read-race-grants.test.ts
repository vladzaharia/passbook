import { beforeAll, describe, expect, it } from 'vitest';
import { countD1, makeOrg } from '../../../../test/helpers/index.ts';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { clearSettingsCache } from '../settings/service.ts';
import {
  action,
  body,
  expectUnavailable,
  fixture,
  race,
} from './action-template-read-race-test-fixtures.ts';
import { openScannerAsset } from './asset-service.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { effects } from './repo-action-template-read-race-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { getEvent } from './repo-scope.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});
const marker = 'INTO scan_asset_grant_provenance';

async function cardGrantFixture() {
  const f = await fixture(kit, { choose: true, event: true, photo: true, includeInPass: true });
  if (!f.event) throw new Error('Missing policy-selected event');
  expect((await getScanner(kit.env.DB, f.scanner.id))?.eventId).toBeNull();
  const result = await action(kit, f.scanner.headers, body(kit, f.pass.id));
  expect(result).toMatchObject({
    kind: 'ready',
    card: { passId: f.pass.id, checkIn: { mode: 'in_out' } },
  });
  const card = result.card;
  const photoUrl = card?.display.identity.photo?.url;
  if (!card || !photoUrl) throw new Error('Missing confirmed card or photo grant');
  const photo = new URL(photoUrl, 'https://wallet.test');
  const photoToken = photo.searchParams.get('g');
  const genericToken = card.passView.assetGrant;
  expect(
    await first(kit.env.DB, 'SELECT include_in_pass FROM member_photos WHERE pass_id=?', [
      f.pass.id,
    ]),
  ).toEqual({ include_in_pass: 1 });
  if (!photoToken || !genericToken) throw new Error('Missing confirmed grant tokens');
  const genericPath =
    `${card.passView.assetBaseUrl}icon.png?g=${encodeURIComponent(genericToken)}`.replace(
      '/api/v1/scan',
      '',
    );
  const photoPath = (photo.pathname + photo.search).replace('/api/v1/scan', '');
  const assetPath = (name: string, token: string) =>
    `${card.passView.assetBaseUrl}${name}?g=${encodeURIComponent(token)}`.replace(
      '/api/v1/scan',
      '',
    );
  return { ...f, event: f.event, photoToken, genericToken, genericPath, photoPath, assetPath };
}

describe('policy-selected event action grants', () => {
  it('confirms distinct photo and generic grants for the original scanner, not the derived event actor', async () => {
    const f = await cardGrantFixture();
    expect(f.photoToken).not.toBe(f.genericToken);
    for (const token of [f.photoToken, f.genericToken]) {
      const hash = await sha256Hex(token);
      expect(
        await first(
          kit.env.DB,
          `SELECT token_hash FROM scan_asset_grant_provenance
        WHERE token_hash=? AND org_id=? AND mode='live'`,
          [hash, kit.org.id],
        ),
      ).toEqual({ token_hash: hash });
    }
    expect((await kit.get(f.scanner.headers, f.photoPath)).status).toBe(200);
    expect((await kit.get(f.scanner.headers, f.genericPath)).status).toBe(200);
    expect(
      (await kit.get(f.scanner.headers, f.assetPath('member.png', f.genericToken))).status,
    ).toBe(404);
    expect(
      (await kit.get(f.scanner.headers, f.assetPath('thumbnail@3x.png', f.genericToken))).status,
    ).toBe(404);
    expect(
      (await kit.get(f.scanner.headers, f.assetPath('thumbnail@3x.png', f.photoToken))).status,
    ).toBe(200);
    const other = await kit.scanner({ templateIds: [f.templateId], settings: { flow: 'choose' } });
    expect((await kit.get(other.headers, f.photoPath)).status).toBe(404);
    expect((await kit.get(other.headers, f.genericPath)).status).toBe(404);

    const originalActor = await assetActorFor(kit, f.scanner);
    const event = await getEvent(kit.env.DB, kit.org.id, f.event.id);
    if (!event || originalActor.event)
      throw new Error('Expected an unassigned scanner and selected event');
    for (const [name, token] of [
      ['member.png', f.photoToken],
      ['icon.png', f.genericToken],
    ] as const) {
      await expect(
        openScannerAsset(kit.ctx, { ...originalActor, event }, f.pass.id, name, token),
      ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    }
  });

  it.each(['gate', 'stop'] as const)(
    'confirms a policy-selected event photo on a %s result',
    async (phase) => {
      const f = await fixture(kit, { event: true, photo: true, stop: phase === 'stop' });
      if (!f.event) throw new Error('Missing selected event');
      const result = await action(kit, f.scanner.headers, body(kit, f.pass.id));
      expect(result.kind).toBe(phase === 'gate' ? 'ok' : 'heads_up');
      const url = result.display?.identity.photo?.url;
      if (!url) throw new Error('Missing confirmed event photo');
      const photo = new URL(url, 'https://wallet.test');
      const token = photo.searchParams.get('g');
      if (!token) throw new Error('Missing event photo token');
      const hash = await sha256Hex(token);
      expect(
        await first(
          kit.env.DB,
          'SELECT token_hash FROM scan_asset_grant_provenance WHERE token_hash=?',
          [hash],
        ),
      ).toEqual({ token_hash: hash });
      expect(
        (
          await kit.get(
            f.scanner.headers,
            (photo.pathname + photo.search).replace('/api/v1/scan', ''),
          )
        ).status,
      ).toBe(200);
      if (phase === 'gate') {
        expect(
          await first(kit.env.DB, 'SELECT event_id FROM scans WHERE id=?', [result.scanId]),
        ).toEqual({ event_id: f.event.id });
      }
    },
  );

  it('does not issue a card grant when the policy-selected event rejects the pass', async () => {
    const f = await fixture(kit, { choose: true, event: true, photo: true });
    if (!f.event) throw new Error('Missing selected event');
    await run(
      kit.env.DB,
      `UPDATE scan_events SET match_input='tier',match_values='["silver"]',
      updated_at=updated_at+1 WHERE id=?`,
      [f.event.id],
    );
    const request = body(kit, f.pass.id);
    const before = await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id);
    expectUnavailable(await action(kit, f.scanner.headers, request), f.pass.id);
    expect(await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id)).toEqual(
      before,
    );
  });

  for (const phase of ['gate', 'choose', 'stop'] as const) {
    it.each(['event archived', 'event filter', 'foreign event', 'csrf', 'scanner token'] as const)(
      `atomically rejects ${phase} grants when %s changes after event evaluation`,
      async (change) => {
        const f = await fixture(kit, {
          choose: phase === 'choose',
          stop: phase === 'stop',
          event: true,
          photo: true,
        });
        if (!f.event) throw new Error('Missing selected event');
        const foreign = change === 'foreign event' ? await makeOrg(kit.fx) : null;
        const other = foreign ? await kit.event({ orgId: foreign.id }) : null;
        const request = body(kit, f.pass.id);
        const before = await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id);
        const result = await race(kit, f.scanner.headers, request, marker, async (db) => {
          if (change === 'event archived') {
            await run(
              db,
              'UPDATE scan_events SET archived_at=?,updated_at=updated_at+1 WHERE id=?',
              [kit.clock.now(), f.event!.id],
            );
          } else if (change === 'event filter') {
            await run(
              db,
              `UPDATE scan_events SET match_input='tier',match_values='["silver"]',
              updated_at=updated_at+1 WHERE id=?`,
              [f.event!.id],
            );
          } else if (change === 'foreign event') {
            await run(
              db,
              'UPDATE pass_check_in SET rules=?,updated_at=updated_at+1 WHERE pass_id=? AND org_id=?',
              [JSON.stringify({ mode: 'in_out', eventId: other!.id }), f.pass.id, kit.org.id],
            );
          } else if (change === 'csrf') {
            await run(db, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
              'new-scanner-csrf-secret',
              f.scanner.id,
            ]);
          } else {
            await run(db, 'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?', [
              'e'.repeat(64),
              f.scanner.id,
            ]);
          }
        });
        expectUnavailable(result, f.pass.id);
        expect(await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id)).toEqual(
          before,
        );
      },
    );
  }

  it('rejects the previously confirmed grants after original CSRF authority changes', async () => {
    const f = await cardGrantFixture();
    await run(kit.env.DB, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
      'replacement-scanner-secret',
      f.scanner.id,
    ]);
    expect((await kit.get(f.scanner.headers, f.photoPath)).status).toBe(404);
    expect((await kit.get(f.scanner.headers, f.genericPath)).status).toBe(404);
  });

  it('does not redeem or create grants with a keyring foreign to the captured D1 keyset', async () => {
    const f = await cardGrantFixture();
    const original = kit.env.KEK_V1;
    const request = body(kit, f.pass.id);
    const before = await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id);
    try {
      kit.env.KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)));
      expect((await kit.get(f.scanner.headers, f.photoPath)).status).toBe(404);
      expect((await kit.get(f.scanner.headers, f.genericPath)).status).toBe(404);
      expectUnavailable(await action(kit, f.scanner.headers, request), f.pass.id);
    } finally {
      kit.env.KEK_V1 = original;
    }
    expect(await effects(kit.env.DB, f.pass.id, request.idempotencyKey, kit.org.id)).toEqual(
      before,
    );
    expect((await kit.get(f.scanner.headers, f.photoPath)).status).toBe(200);
    expect((await kit.get(f.scanner.headers, f.genericPath)).status).toBe(200);
  });

  it('performs a cold history and photo override in at most five post-guard D1 trips', async () => {
    const f = await fixture(kit, { photo: true, history: true });
    const firstResult = await action(
      kit,
      f.scanner.headers,
      body(kit, f.pass.id, { actionId: 'check_in' }),
    );
    expect(firstResult.kind).toBe('ok');
    const stopped = await action(
      kit,
      f.scanner.headers,
      body(kit, f.pass.id, { actionId: 'check_in' }),
    );
    expect(stopped).toMatchObject({ kind: 'heads_up', reason: 'already_done', overridable: true });
    if (!stopped.scanId) throw new Error('Missing overridable scan');
    const request = body(kit, f.pass.id, { actionId: 'check_in', overrideOf: stopped.scanId });
    const real = kit.env.DB;
    const counted = countD1(real);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await kit.post(f.scanner.headers, '/actions', {});
      const guard = counted.count();
      counted.reset();
      clearSettingsCache(counted.db);
      const response = await kit.post(f.scanner.headers, '/actions', request);
      expect(response.status).toBe(200);
      const outcome = ScanOutcomeSchema.parse(await response.json());
      expect(outcome.kind).toBe('ok');
      expect(outcome.display?.identity.photo?.url).toContain(
        `/passes/${f.pass.id}/assets/member.png?g=`,
      );
      expect(counted.count() - guard).toBeLessThanOrEqual(5);
      const sql = counted.sql().join('\n');
      expect(sql).toContain('template_versions');
      expect(sql).toContain('pass_events');
      expect(sql).toContain('override_of');
      expect(sql).toContain('scan_asset_grant_provenance');
    } finally {
      Object.assign(kit.env, { DB: real });
    }
  });
});
