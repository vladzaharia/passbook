// Test 26: the issuance statements of delivery/repo-issuance.ts in grant form (builder-ext design section 7).
import { describe, expect, it } from 'vitest';
import { makePass } from '../../../test/helpers/index.ts';
import { grant } from './authority.ts';
import { exists, not, tenantSql } from './authority-cond.ts';
import { inList, ne, orNull } from './authority-expr.ts';
import { db, resultRows } from './authority-ext-fixtures.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { all, first, run } from './db.ts';

type Setup = Awaited<ReturnType<typeof setupGrant>>;
const PURPOSE = 'org_mode.pass.transfer_start';

const COPY = {
  pass_id: 'id',
  recipient: 'holder_email',
  identity_id: 'identity_id',
  source_owner_user_id: 'owner_user_id',
  source_generation: 'credential_generation',
  source_lifecycle_generation: 'lifecycle_generation',
  source_link_generation: 'link_generation',
  source_object_key: 'object_key',
  template_id: 'template_id',
  connection_id: 'connection_id',
  connection_ref: 'external_ref',
};

async function setup(label: string) {
  const x = await setupGrant(label);
  const email = `${label}@example.com`;
  const pass = await makePass(x.s.f, {
    orgId: x.s.org.id,
    template: x.s.template.resolved,
    holderEmail: email,
  });
  return { x, pass, email };
}

/** issuanceDeliveryInsert in grant form. */
async function insertDelivery(x: Setup, passId: string, email: string) {
  const g = grant(x.route, { purpose: 'org_mode.pass.create', principal: x.member() });
  const st = g.insertSelect(
    'pass_issuance_deliveries',
    ['connection_generation', 'context', 'state', 'created_at'],
    [null, '{}', 'pending', 1],
    {
      from: { table: 'passes', where: { id: passId, holder_email: email }, copy: COPY },
      returning: ['pass_id'],
    },
  );
  const res = await g.commit();
  return resultRows(res, g.indexOf(st)).length;
}

describe('issuance delivery insert (26)', () => {
  it('inserts only when the pass row exists in the tenant with that holder email', async () => {
    const { x, pass, email } = await setup('iss-insert');
    expect(await insertDelivery(x, pass.id, 'someone@else.example')).toBe(0);
    expect(await first(db, 'SELECT count(*) AS n FROM pass_issuance_deliveries')).toEqual({ n: 0 });
    expect(await insertDelivery(x, pass.id, email)).toBe(1);
    expect(
      await first(
        db,
        'SELECT org_id, mode, recipient, state FROM pass_issuance_deliveries WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual({
      org_id: x.s.org.id,
      mode: 'live',
      recipient: email,
      state: 'pending',
    });
    const other = await setup('iss-insert-other');
    const g = grant(other.x.route, {
      purpose: 'org_mode.pass.create',
      principal: other.x.member(),
    });
    const st = g.insertSelect(
      'pass_issuance_deliveries',
      ['connection_generation', 'context', 'state', 'created_at'],
      [null, '{}', 'pending', 1],
      {
        from: { table: 'passes', where: { id: pass.id, holder_email: email }, copy: COPY },
        returning: ['pass_id'],
      },
    );
    expect(resultRows(await g.commit(), g.indexOf(st))).toEqual([]);
  });
});

/** issuanceTransferStartStatements in grant form (design 7, statements 1-3). */
function startStatements(
  g: ReturnType<typeof grant>,
  passId: string,
  transferId: string,
  verifiedAttach: boolean,
) {
  const released = tenantSql(`({row}.outbox_id IS NULL OR EXISTS (SELECT 1 FROM outbox ob
    WHERE ob.id = {row}.outbox_id AND ob.org_id = {org} AND ob.state = 'cancelled' AND ob.error_code = 'TRANSFER_SUPERSEDED'))`);
  const eligible = tenantSql(
    `{row}.transfer_id IS NULL AND {row}.source_owner_user_id IS NULL
    AND EXISTS (SELECT 1 FROM pass_credential_transfers t JOIN passes p ON p.id = t.pass_id
      WHERE t.id = ? AND t.pass_id = {row}.pass_id AND t.org_id = {org} AND t.mode = {mode}
        AND t.state = 'pending' AND t.source_generation = {row}.source_generation
        AND t.source_lifecycle_generation = {row}.source_lifecycle_generation
        AND t.source_link_generation = {row}.source_link_generation + 1
        AND t.target_holder_email = {row}.recipient AND t.target_owner_user_id IS NOT NULL
        AND p.holder_email = {row}.recipient AND p.owner_user_id IS NULL AND p.identity_id = {row}.identity_id
        AND p.template_id = {row}.template_id AND p.connection_id IS {row}.connection_id
        AND p.external_ref IS {row}.connection_ref AND p.status = 'active' AND p.removed_at IS NULL
        AND p.deleted_at IS NULL AND p.test_data_quarantined = 0)`,
    [transferId],
  );
  const live = { pass_id: passId, state: inList(['pending', 'queued']) };
  return [
    g.update('outbox', {
      set: {
        state: 'cancelled',
        finished_at: 5,
        coalesce_key: null,
        lease: null,
        error_code: 'TRANSFER_SUPERSEDED',
      },
      where: {
        kind: 'email',
        state: inList(['pending', 'enqueued', 'processing']),
        provider_id: null,
        error_code: orNull(ne('EMAIL_OUTCOME_UNKNOWN')),
      },
      when: [
        tenantSql(
          "EXISTS (SELECT 1 FROM pass_issuance_deliveries d WHERE d.outbox_id = {row}.id AND d.pass_id = ? AND d.state = 'queued' AND d.org_id = {org} AND d.mode = {mode})",
          [passId],
        ),
      ],
      returning: ['id'],
    }),
    g.update('pass_issuance_deliveries', {
      set: {
        state: 'cancelled',
        error_code: 'DELIVERY_STALE',
        outbox_id: null,
        next_attempt_at: 0,
      },
      where: live,
      when: verifiedAttach ? [released, not(eligible)] : [released],
      returning: ['pass_id'],
    }),
    ...(verifiedAttach
      ? [
          g.update('pass_issuance_deliveries', {
            set: {
              state: 'pending',
              transfer_id: transferId,
              error_code: null,
              outbox_id: null,
              next_attempt_at: 0,
            },
            where: live,
            when: [released, eligible],
            returning: ['pass_id'],
          }),
        ]
      : []),
  ];
}

describe('issuance transfer start (26)', () => {
  const scenario = async (
    label: string,
    o: { queued?: boolean; targetEmail?: string; verifiedAttach?: boolean },
  ) => {
    const { x, pass, email } = await setup(label);
    await insertDelivery(x, pass.id, email);
    const row = await first<{ rv: number; cg: number; lg: number; lk: number }>(
      db,
      'SELECT row_version AS rv, credential_generation AS cg, lifecycle_generation AS lg, link_generation AS lk FROM passes WHERE id = ?',
      [pass.id],
    );
    const transferId = `t-${label}`;
    await run(
      db,
      `INSERT INTO pass_credential_transfers (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision,
         source_row_version, source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
         requested_by_type, requested_at) VALUES (?, ?, ?, 'live', 'pending', ?, 1, 0, ?, ?, ?, ?, ?, 'system', 1)`,
      [
        transferId,
        pass.id,
        x.s.org.id,
        row?.cg,
        row?.rv,
        row?.lg,
        (row?.lk ?? 0) + 1,
        o.targetEmail ?? email,
        x.s.user.id,
      ],
    );
    if (o.queued) {
      await run(
        db,
        `INSERT INTO outbox (id, org_id, kind, pass_id, payload, state, created_at) VALUES (?, ?, 'email', ?, ?, 'pending', 1)`,
        [`ob-${label}`, x.s.org.id, pass.id, JSON.stringify({ intent: { issuanceId: pass.id } })],
      );
      await run(
        db,
        "UPDATE pass_issuance_deliveries SET state = 'queued', outbox_id = ? WHERE pass_id = ?",
        [`ob-${label}`, pass.id],
      );
    }
    const g = grant(x.route, { purpose: PURPOSE, principal: x.member() });
    startStatements(g, pass.id, transferId, o.verifiedAttach ?? true);
    await g.commit();
    const d = await first<Record<string, unknown>>(
      db,
      'SELECT state, transfer_id, outbox_id, error_code FROM pass_issuance_deliveries WHERE pass_id = ?',
      [pass.id],
    );
    const ob = await first<Record<string, unknown>>(
      db,
      'SELECT state, error_code FROM outbox WHERE id = ?',
      [`ob-${label}`],
    );
    return { d, ob, transferId, pass, x };
  };

  it('eligible: the pending delivery attaches to the transfer', async () => {
    const { d, transferId } = await scenario('is-eligible', {});
    expect(d).toEqual({
      state: 'pending',
      transfer_id: transferId,
      outbox_id: null,
      error_code: null,
    });
  });

  it('ineligible (another target email): the delivery is cancelled', async () => {
    const { d } = await scenario('is-ineligible', { targetEmail: 'other@example.com' });
    expect(d).toEqual({
      state: 'cancelled',
      transfer_id: null,
      outbox_id: null,
      error_code: 'DELIVERY_STALE',
    });
  });

  it('verifiedAttach false: every live delivery is cancelled and none attaches', async () => {
    const { d } = await scenario('is-unverified', { verifiedAttach: false });
    expect(d).toEqual({
      state: 'cancelled',
      transfer_id: null,
      outbox_id: null,
      error_code: 'DELIVERY_STALE',
    });
  });

  it('queued with its outbox cancelled by the first statement: an eligible delivery returns to pending', async () => {
    const { d, ob, transferId } = await scenario('is-queued', { queued: true });
    expect(ob).toEqual({ state: 'cancelled', error_code: 'TRANSFER_SUPERSEDED' });
    expect(d).toEqual({
      state: 'pending',
      transfer_id: transferId,
      outbox_id: null,
      error_code: null,
    });
    const g = await all(db, 'SELECT 1 FROM authority_grants');
    expect(g).toEqual([]);
  });

  it('queued and ineligible: cancelled, with the outbox superseded', async () => {
    const { d, ob } = await scenario('is-queued-bad', {
      queued: true,
      targetEmail: 'other@example.com',
    });
    expect(ob).toEqual({ state: 'cancelled', error_code: 'TRANSFER_SUPERSEDED' });
    expect(d).toEqual({
      state: 'cancelled',
      transfer_id: null,
      outbox_id: null,
      error_code: 'DELIVERY_STALE',
    });
  });
});

describe('issuance transfer finish (26)', () => {
  it('writes nothing while the transfer is pending', async () => {
    const { x, pass, email } = await setup('if-finish');
    await insertDelivery(x, pass.id, email);
    const row = await first<{ rv: number; cg: number; lg: number; lk: number; key: string }>(
      db,
      'SELECT row_version AS rv, credential_generation AS cg, lifecycle_generation AS lg, link_generation AS lk, object_key AS key FROM passes WHERE id = ?',
      [pass.id],
    );
    await run(
      db,
      `INSERT INTO pass_credential_transfers (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision,
         source_row_version, source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
         requested_by_type, requested_at) VALUES ('t-finish', ?, ?, 'live', 'pending', ?, 1, 0, ?, ?, ?, ?, ?, 'system', 1)`,
      [pass.id, x.s.org.id, row?.cg, row?.rv, row?.lg, (row?.lk ?? 0) + 1, email, x.s.user.id],
    );
    const attach = grant(x.route, { purpose: PURPOSE, principal: x.member() });
    startStatements(attach, pass.id, 't-finish', true);
    await attach.commit();
    const finish = async (objectKey: string) => {
      const g = grant(x.route, { purpose: 'org_mode.pass.transfer_finish', principal: x.member() });
      const st = g.update('pass_issuance_deliveries', {
        set: { target_object_key: objectKey },
        where: {
          pass_id: pass.id,
          transfer_id: 't-finish',
          state: 'pending',
          target_object_key: null,
        },
        when: [
          exists('pass_credential_transfers', {
            id: 't-finish',
            pass_id: pass.id,
            state: 'completed',
          }),
        ],
        returning: ['pass_id'],
      });
      return resultRows(await g.commit(), g.indexOf(st)).length;
    };
    const key = () =>
      first(db, 'SELECT target_object_key AS k FROM pass_issuance_deliveries WHERE pass_id = ?', [
        pass.id,
      ]);
    expect(await finish(row?.key ?? '')).toBe(0);
    expect(await key()).toEqual({ k: null });
  });
});
