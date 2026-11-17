import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { expectBlocked, photoGrantFixture, raceGate } from './act-authority-test-fixtures.ts';
import { act, CHECK_IN, kit, out, rows, tpl } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

export function registerAuthorityGrants() {
  it.each(['choose', 'stop'] as const)(
    'publishes photo and applicable generic grants that redeem for an authorized %s result',
    async (phase) => {
      const { scanner, pass } = await photoGrantFixture(phase === 'stop');
      const outcome = await out(await act(scanner.headers, codeOf(pass)));
      expect(outcome.kind).toBe(phase === 'choose' ? 'ready' : 'heads_up');
      const photo =
        phase === 'choose' ? outcome.card?.display.identity.photo : outcome.display?.identity.photo;
      if (!photo?.url) throw new Error('Missing confirmed photo URL');
      const photoUrl = new URL(photo.url, 'https://wallet.test');
      const photoToken = photoUrl.searchParams.get('g');
      if (!photoToken) throw new Error('Missing confirmed photo token');
      expect(
        (
          await kit.get(
            scanner.headers,
            photoUrl.pathname.replace('/api/v1/scan', '') + photoUrl.search,
          )
        ).status,
      ).toBe(200);
      if (phase === 'choose') {
        const generic = outcome.card?.passView.assetGrant;
        if (!generic) throw new Error('Missing confirmed pass-view grant');
        expect(generic).not.toBe(photoToken);
        const icon = await kit.get(
          scanner.headers,
          `/passes/${pass.id}/assets/icon.png?g=${encodeURIComponent(generic)}`,
        );
        expect(icon.status).toBe(200);
        await icon.body?.cancel();
      }
    },
  );

  it.each(['choose', 'stop'] as const)(
    'rolls back %s and publishes no grant when output authority changes',
    async (phase) => {
      const { scanner, pass } = await photoGrantFixture(phase === 'stop');
      const idempotencyKey = key();
      // The scanner is revoked before the commit: the grant refuses (401 re-pair) and no deferred
      // grant, scan or ledger row is written.
      const response = await raceGate(
        scanner.headers,
        codeOf(pass),
        (db) =>
          run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), scanner.id]),
        { idempotencyKey },
      );
      const body = await response.clone().text();
      await expectBlocked(response, pass.id, idempotencyKey, 'SCANNER_REPAIR');
      expect(body).not.toContain(pass.id);
      expect(body).not.toContain('member.png');
      expect(body).not.toContain('assetGrant');
      expect(
        await rows("SELECT id FROM scans WHERE pass_id=? AND state='done'", [pass.id]),
      ).toHaveLength(0);
      expect(
        await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
      ).toHaveLength(0);
    },
  );

  it('admits a repeat-always visit when the observed gate count moves (history is display, not authority)', async () => {
    const templateId = await kit.scanTemplate('Gate-fenced visit history', {
      actions: [{ ...CHECK_IN, repeat: 'always' }],
      display: {
        v: 1,
        header: { title: 'First visit' },
        variants: [
          {
            id: 'returning',
            name: 'Returning',
            when: { path: 'history.visits.total', gte: 1 },
            header: { title: 'Returning member' },
          },
        ],
      },
    });
    const scanner = await kit.scanner({ templateIds: [templateId] });
    const pass = await kit.scanPass(templateId);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    expect((await out(await act(scanner.headers, codeOf(pass)))).kind).toBe('ok');
    const response = await raceGate(scanner.headers, codeOf(pass), (db) =>
      run(db, 'UPDATE scan_gates SET count=count+1 WHERE pass_id=?', [pass.id]),
    );
    // Gate count is not authority for a repeat-always action: the visit commits against the live gate.
    const outcome = await out(response);
    expect(outcome.kind).toBe('ok');
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.checked_in'", [
        pass.id,
      ]),
    ).toHaveLength(2);
    expect(await rows('SELECT count FROM scan_gates WHERE pass_id=?', [pass.id])).toEqual([
      { count: 3 },
    ]);
  });

  it('does not claim a key after the original scanner CSRF authority changes', async () => {
    const scanner = await kit.scanner({ templateIds: [tpl] });
    const pass = await kit.scanPass(tpl);
    const idempotencyKey = key();
    const keyset = await first(
      kit.env.DB,
      'SELECT commitment FROM credential_ref_keyset WHERE id=1',
    );
    const response = await raceGate(
      scanner.headers,
      codeOf(pass),
      (db) =>
        run(db, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
          `changed-${key()}`,
          scanner.id,
        ]),
      { idempotencyKey },
      'INSERT INTO scans',
    );
    await expectBlocked(response, pass.id, idempotencyKey, 'SCANNER_REPAIR');
    expect(
      await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [idempotencyKey]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT commitment FROM credential_ref_keyset WHERE id=1'),
    ).toEqual(keyset);
    expect(
      await rows("SELECT id FROM pass_events WHERE pass_id=? AND kind LIKE 'scan.%'", [pass.id]),
    ).toHaveLength(0);
  });
}
