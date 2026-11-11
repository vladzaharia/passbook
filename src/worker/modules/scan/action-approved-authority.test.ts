import { beforeAll, describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import {
  expectRefused,
  type Refusal,
  raceApproved,
} from './action-approved-authority-test-fixtures.ts';
import {
  effects,
  request,
  type Suite,
  scenario,
  send,
  signed,
  suite,
} from './action-gate-stale-budget-core-test-fixtures.ts';
import { hashPin } from './staff-pin.ts';

let base: Suite;
beforeAll(async () => {
  base = await suite();
});

// Each change moves the epoch named in the title (migrations/0052_authority_epochs.sql), so the commit grant
// refuses the approved ticket with a classified code. The cases replace the old column-equality fence tests.
describe('approved action: epoch bump between preflight and commit', () => {
  const scanner: [string, string, (id: string, now: number) => unknown[], Refusal][] = [
    [
      'scanner revoked (credential_epoch)',
      'UPDATE scanners SET revoked_at=? WHERE id=?',
      (id, now) => [now, id],
      'SCANNER_REPAIR',
    ],
    [
      'scanner csrf (credential_epoch)',
      'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
      (id) => [`csrf-${id}`, id],
      'SCANNER_REPAIR',
    ],
    [
      'scanner role (config_epoch)',
      "UPDATE scanners SET device_role='monitor' WHERE id=?",
      (id) => [id],
      'SCAN_CONFIG_CHANGED',
    ],
    [
      'scanner policy (config_epoch)',
      "UPDATE scanners SET settings=json_set(settings,'$.roleWithoutSignIn','desk') WHERE id=?",
      (id) => [id],
      'SCAN_CONFIG_CHANGED',
    ],
    [
      'photo policy (config_epoch)',
      "UPDATE scanners SET settings=json_set(settings,'$.showPhoto',json('false')) WHERE id=?",
      (id) => [id],
      'SCAN_CONFIG_CHANGED',
    ],
  ];
  it.each(scanner)('rejects %s', async (_name, sql, values, code) => {
    const s = await scenario(base, { photo: true });
    const body = request(s);
    const raced = await raceApproved(s, body, (db) =>
      runOne(db, sql, values(s.scanner.id, s.kit.clock.now())),
    );
    await expectRefused(s, body, raced, code);
  });

  it.each(['role', 'disabled', 'PIN'] as const)(
    'rejects a changed manager %s (scan_staff.auth_epoch)',
    async (change) => {
      const s = await scenario(base, { photo: true });
      const replacement = await hashPin(s.kit.env, s.manager.id, '654321');
      const body = request(s);
      const raced = await raceApproved(s, body, (db) =>
        change === 'role'
          ? runOne(db, "UPDATE scan_staff SET role='door' WHERE id=?", [s.manager.id])
          : change === 'disabled'
            ? runOne(db, 'UPDATE scan_staff SET disabled_at=? WHERE id=?', [
                s.kit.clock.now(),
                s.manager.id,
              ])
            : runOne(db, 'UPDATE scan_staff SET pin_hash=? WHERE id=?', [
                replacement,
                s.manager.id,
              ]),
      );
      await expectRefused(s, body, raced, 'SCAN_STAFF_CHANGED');
    },
  );

  it.each(['status', 'deleted_at'] as const)(
    'rejects a pass whose %s changes (passes.row_version)',
    async (column) => {
      const s = await scenario(base, { photo: true });
      const body = request(s);
      const raced = await raceApproved(s, body, (db) =>
        column === 'status'
          ? runOne(db, "UPDATE passes SET status='voided' WHERE id=?", [s.pass.id])
          : runOne(db, 'UPDATE passes SET deleted_at=? WHERE id=?', [s.kit.clock.now(), s.pass.id]),
      );
      await expectRefused(s, body, raced, 'SCAN_PASS_CHANGED');
    },
  );

  it.each(['membership', 'session'] as const)(
    'rejects a managed actor whose %s is revoked',
    async (change) => {
      const s = await scenario(base, { managed: true, photo: true });
      if (!s.managed) throw new Error('Missing real managed session');
      const actor = s.managed;
      const body = request(s);
      const raced = await raceApproved(s, body, (db) =>
        change === 'membership'
          ? runOne(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
              s.kit.clock.now(),
              actor.membershipId,
            ])
          : runOne(db, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
              s.kit.clock.now(),
              actor.sessionId,
            ]),
      );
      await expectRefused(s, body, raced, 'ACTOR_CHANGED');
    },
  );

  it('releases the claim so the identical request succeeds once authority is restored', async () => {
    const s = await scenario(base, { photo: true });
    const body = request(s);
    const raced = await raceApproved(s, body, (db) =>
      runOne(db, "UPDATE scan_staff SET role='door' WHERE id=?", [s.manager.id]),
    );
    await expectRefused(s, body, raced, 'SCAN_STAFF_CHANGED');
    await runOne(s.kit.env.DB, "UPDATE scan_staff SET role='manager' WHERE id=?", [s.manager.id]);
    const accepted = await send(s, body);
    expect(accepted).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
    if (!accepted.scanId) throw new Error('Missing retried scan');
    await signed(s, accepted.scanId);
    expect((await effects(s.kit.env.DB, s)).gates).toHaveLength(1);
    expect(
      await first(s.kit.env.DB, 'SELECT count FROM counters WHERE key=?', [
        `scan:pin:${s.scanner.id}:${s.manager.id}`,
      ]),
    ).toEqual({ count: 2 });
  });
});

describe('approved action: volatile change is not authority', () => {
  it.each([
    ['organization', 'UPDATE orgs SET updated_at=updated_at+1 WHERE id=?'],
    ['template', 'UPDATE templates SET updated_at=updated_at+1 WHERE id=?'],
    ['pass image epoch', 'UPDATE passes SET image_generation=image_generation+1 WHERE id=?'],
    ['pass content version', 'UPDATE passes SET version=version+1 WHERE id=?'],
  ] as const)('admits and signs the action after a changed %s', async (name, sql) => {
    // The photo grant binds the pass's image epoch and version, so a photo scan legitimately refuses on them.
    const s = await scenario(base, { photo: false });
    const body = request(s);
    const id =
      name === 'organization' ? s.kit.org.id : name === 'template' ? s.template : s.pass.id;
    const raced = await raceApproved(s, body, (db) => runOne(db, sql, [id]));
    expect(raced.response.status).toBe(200);
    const outcome = (await raced.response.json()) as { kind: string; scanId: string | null };
    expect(outcome).toMatchObject({ kind: 'ok', scanId: expect.any(String) });
    if (!outcome.scanId) throw new Error('Missing admitted scan');
    await signed(s, outcome.scanId);
    expect((await effects(s.kit.env.DB, s)).gates).toHaveLength(1);
  });
});
