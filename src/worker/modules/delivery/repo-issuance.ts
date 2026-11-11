import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { exists, not, tenantSql } from '../../platform/authority-cond.ts';
import { inList, ne, orNull } from '../../platform/authority-expr.ts';
import { first } from '../../platform/db.ts';
import type { NewPassRow } from '../passes/repo-write-types.ts';

const revisionOf = async (db: D1Database, sql: string, id: string | undefined) =>
  id === undefined ? null : ((await first<{ r: number }>(db, sql, [id]))?.r ?? null);

/**
 * The org and user epochs the issuance is queued under: system and connection work pins the org
 * revision the pass was created at, and a session issuer's user epoch makes a disable-then-enable
 * cycle cancel its mail. A pre-cutover millisecond value reads as the org's current revision.
 */
async function capturedEpochs(db: D1Database, row: NewPassRow) {
  const ex = row.execution;
  const tenant = ex.kind === 'tenant' ? ex : null;
  const users = (
    a: typeof tenant extends null ? never : NonNullable<typeof tenant>['authority'],
  ) =>
    a.kind === 'session'
      ? revisionOf(db, 'SELECT access_revision AS r FROM users WHERE id = ?', a.userId)
      : null;
  const org = await revisionOf(db, 'SELECT access_revision AS r FROM orgs WHERE id = ?', row.orgId);
  return {
    orgRevision: org,
    userRevision: tenant ? await users(tenant.authority) : null,
    additionalUserRevision: tenant?.additionalAuthority
      ? await users(tenant.additionalAuthority)
      : null,
  };
}

/**
 * Inserts the pending issuance delivery in the pass grant, right after the pass insert in the same
 * batch. The facts come from the pass row in the grant's tenant (no row, no insert: count with
 * `returning`); the 0045 trigger holds the rest.
 */
export async function grantIssuanceInsert(
  db: D1Database,
  g: Grant,
  row: NewPassRow,
): Promise<GrantedStatement> {
  const epochs = await capturedEpochs(db, row);
  const context = {
    execution: row.execution,
    release: {
      ...row.release,
      templateId: row.templateId,
      version: row.templateVersion,
      mode: row.mode,
    },
    connection:
      row.connectionId && row.connectionGeneration !== null
        ? {
            orgId: row.orgId,
            connectionId: row.connectionId,
            externalRef: row.externalRef,
            generation: row.connectionGeneration,
          }
        : null,
    connectionMode: row.expectedConnectionMode ?? null,
    ...(epochs.orgRevision === null ? {} : { orgRevision: epochs.orgRevision }),
    ...(epochs.userRevision === null ? {} : { userRevision: epochs.userRevision }),
    ...(epochs.additionalUserRevision === null
      ? {}
      : { additionalUserRevision: epochs.additionalUserRevision }),
  };
  return g.insertSelect(
    'pass_issuance_deliveries',
    ['connection_generation', 'context', 'state', 'created_at'],
    [row.connectionGeneration, JSON.stringify(context), 'pending', row.now],
    {
      from: {
        table: 'passes',
        where: { id: row.id, holder_email: row.holderEmail },
        copy: {
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
        },
      },
      returning: ['pass_id'],
    },
  );
}

/**
 * START, in the transfer's grant: the queued issuance email is superseded, then the delivery is
 * either re-pended under this transfer (a verified attach whose lineage the transfer names) or
 * cancelled. A committed provider marker is never touched. Two ordered updates replace the old CASE:
 * the cancel runs first, so the attach sees only the survivors.
 */
export function grantTransferStart(
  g: Grant,
  input: { passId: string; transferId: string; now: number; verifiedAttach: boolean },
): GrantedStatement[] {
  const released = tenantSql(`({row}.outbox_id IS NULL OR EXISTS (SELECT 1 FROM outbox ob
    WHERE ob.id = {row}.outbox_id AND ob.org_id = {org} AND ob.state = 'cancelled'
      AND ob.error_code = 'TRANSFER_SUPERSEDED'))`);
  const eligible = tenantSql(
    `{row}.transfer_id IS NULL AND {row}.source_owner_user_id IS NULL
    AND EXISTS (SELECT 1 FROM pass_credential_transfers t JOIN passes p ON p.id = t.pass_id
      WHERE t.id = ? AND t.pass_id = {row}.pass_id AND t.org_id = {org} AND t.mode = {mode}
        AND t.state = 'pending' AND t.source_generation = {row}.source_generation
        AND t.source_lifecycle_generation = {row}.source_lifecycle_generation
        AND t.source_link_generation = {row}.source_link_generation + 1
        AND t.target_holder_email = {row}.recipient AND t.target_owner_user_id IS NOT NULL
        AND p.holder_email = {row}.recipient AND p.owner_user_id IS NULL
        AND p.identity_id = {row}.identity_id AND p.template_id = {row}.template_id
        AND p.connection_id IS {row}.connection_id AND p.external_ref IS {row}.connection_ref
        AND p.status = 'active' AND p.removed_at IS NULL AND p.deleted_at IS NULL
        AND p.test_data_quarantined = 0)`,
    [input.transferId],
  );
  const live = { pass_id: input.passId, state: inList(['pending', 'queued']) };
  return [
    g.update('outbox', {
      set: {
        state: 'cancelled',
        finished_at: input.now,
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
          `EXISTS (SELECT 1 FROM pass_issuance_deliveries d WHERE d.outbox_id = {row}.id
            AND d.pass_id = ? AND d.state = 'queued' AND d.org_id = {org} AND d.mode = {mode})`,
          [input.passId],
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
      when: input.verifiedAttach ? [released, not(eligible)] : [released],
      returning: ['pass_id'],
    }),
    ...(input.verifiedAttach
      ? [
          g.update('pass_issuance_deliveries', {
            set: {
              state: 'pending',
              transfer_id: input.transferId,
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

/**
 * FINISH, in the transfer's grant after the completing update: records the committed artifact's
 * object key (a GC hold) on the re-pended delivery. `objectKey` is the key FINISH wrote.
 */
export function grantTransferFinish(
  g: Grant,
  input: { passId: string; transferId: string; objectKey: string },
): GrantedStatement[] {
  return [
    g.update('pass_issuance_deliveries', {
      set: { target_object_key: input.objectKey },
      where: {
        pass_id: input.passId,
        transfer_id: input.transferId,
        state: 'pending',
        target_object_key: null,
      },
      when: [
        exists('pass_credential_transfers', {
          id: input.transferId,
          pass_id: input.passId,
          state: 'completed',
        }),
      ],
      returning: ['pass_id'],
    }),
  ];
}
