import {
  type ConnectionMode,
  ConnectionModeSchema,
} from '../../../shared/contracts/connections.ts';
import { type Check, exactlyOne, rawCheck } from '../../platform/authority-checks.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type ConnectionActor,
  commitOrNull,
  connectionGrant,
  connectionIs,
  rowCount,
  workflowTracked,
} from './repo-grants.ts';
import { validSyncEpochs } from './repo-pass-snapshot.ts';
import {
  type SyncPass,
  validCredentialKeysetCommitment,
  validPassReleaseBinding,
} from './repo-passes.ts';

export { listRuns, runStats } from './repo-run-queries.ts';

const passSnapshotChecks = (id: string, connectionId: string, p: PassSnapshot): Check[] => [
  exactlyOne(
    'passes',
    {
      id,
      connection_id: connectionId,
      external_ref: p.externalRef,
      status: 'active',
      version: p.version,
      identity_id: p.identityId,
      credential_generation: p.credentialGeneration,
      lifecycle_generation: p.lifecycleGeneration,
      owner_user_id: p.ownerUserId,
      link_generation: p.linkGeneration,
      template_id: p.templateId,
      template_version: p.templateVersion,
      release_id: p.releaseId,
      deleted_at: null,
      removed_at: null,
      test_data_quarantined: 0,
    },
    undefined,
    'lineage',
  ),
  rawCheck(
    'lineage',
    "NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')",
    [id],
  ),
];

type PassSnapshot = NonNullable<NonNullable<RunInsert['expected']>['pass']>;

interface RunInsert {
  id: string;
  connectionId: string;
  trigger: string;
  actorId?: string | null;
  passId?: string | null;
  startedAt: number;
  expected?: {
    orgId: string;
    generation: number;
    mode?: ConnectionMode;
    credentialKeysetCommitment?: string;
    workflowInstanceId?: string;
    /** Configuration tests may also run against disabled connections. */
    allowDisabled?: boolean;
    pass?: Pick<
      SyncPass,
      | 'id'
      | 'version'
      | 'identityId'
      | 'credentialGeneration'
      | 'lifecycleGeneration'
      | 'credentialKeysetCommitment'
      | 'transferPending'
      | 'ownerUserId'
      | 'linkGeneration'
      | 'templateId'
      | 'templateVersion'
      | 'releaseId'
    > & { mode: 'live'; status: 'active'; externalRef: string };
  };
}

/** True when this call inserted the run; an existing id or a context that moved is false. */
export async function insertRun(
  ctx: ServiceContext,
  r: RunInsert,
  actor: ConnectionActor,
): Promise<boolean> {
  const p = r.expected?.pass;
  const keyset = r.expected?.credentialKeysetCommitment;
  const workflow = r.expected?.workflowInstanceId;
  const mode = r.expected?.mode;
  if (
    (mode !== undefined && !ConnectionModeSchema.options.includes(mode)) ||
    (keyset !== undefined && !validCredentialKeysetCommitment(keyset)) ||
    (workflow !== undefined &&
      (typeof workflow !== 'string' || !workflow || workflow !== r.id || keyset === undefined)) ||
    (r.expected !== undefined && r.expected.orgId !== actor.orgId) ||
    (r.passId && !p) ||
    (p &&
      (r.passId !== p.id ||
        keyset !== p.credentialKeysetCommitment ||
        typeof p.identityId !== 'string' ||
        !p.identityId ||
        !validSyncEpochs(p) ||
        !validPassReleaseBinding(p)))
  )
    return false;
  const checks: Check[] = [
    connectionIs({
      id: r.connectionId,
      ...(r.expected ? { generation: r.expected.generation } : {}),
      ...(mode === undefined ? {} : { syncMode: mode }),
      ...(r.expected && !r.expected.allowDisabled ? { enabled: true } : {}),
    }),
    rawCheck('lineage', 'NOT EXISTS (SELECT 1 FROM connection_runs WHERE id = ?)', [r.id]),
  ];
  if (workflow !== undefined && keyset !== undefined)
    checks.push(workflowTracked(workflow, r.connectionId, keyset));
  if (p) checks.push(...passSnapshotChecks(p.id, r.connectionId, p));
  const g = connectionGrant(ctx, actor, 'run.start', checks, r.id);
  g.insertJoined('connection_runs', {
    parents: { connection_id: r.connectionId },
    columns: ['id', 'trigger', 'actor_id', 'pass_id', 'started_at', 'outcome'],
    values: [r.id, r.trigger, r.actorId ?? null, r.passId ?? null, r.startedAt, 'running'],
    returning: ['id'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}

/** An already-enqueued workflow is usable only with its original run and keyset. */
export async function syncRunCurrent(
  db: D1Database,
  expected: {
    runId: string;
    connectionId: string;
    orgId: string;
    trigger: 'schedule' | 'webhook' | 'admin';
    generation: number;
    mode: ConnectionMode;
    credentialKeysetCommitment: string;
  },
): Promise<boolean> {
  if (
    !expected.runId ||
    !expected.connectionId ||
    !expected.orgId ||
    (expected.trigger !== 'schedule' &&
      expected.trigger !== 'webhook' &&
      expected.trigger !== 'admin') ||
    !ConnectionModeSchema.options.includes(expected.mode) ||
    !Number.isSafeInteger(expected.generation) ||
    expected.generation < 1 ||
    !validCredentialKeysetCommitment(expected.credentialKeysetCommitment)
  )
    return false;
  return (
    (await first(
      db,
      `SELECT 1 FROM connection_runs r
     JOIN connections c ON c.id = r.connection_id
     JOIN orgs o ON o.id = c.org_id
     JOIN workflow_runs w ON w.instance_id = r.id AND w.kind = 'connection_sync'
       AND w.org_id = c.org_id AND w.target_id = c.id
     WHERE r.id = ? AND c.id = ? AND c.org_id = ? AND r.trigger = ? AND c.generation = ? AND c.mode = ?
       AND r.outcome = 'running'
       AND c.enabled = 1 AND o.status = 'active'
       AND (r.trigger <> 'schedule' OR c.mode IN ('poll', 'hybrid'))
       AND w.credential_keyset_commitment = ?`,
      [
        expected.runId,
        expected.connectionId,
        expected.orgId,
        expected.trigger,
        expected.generation,
        expected.mode,
        expected.credentialKeysetCommitment,
      ],
    )) !== null
  );
}

export async function finishRun(
  ctx: ServiceContext,
  r: {
    id: string;
    connectionId: string;
    finishedAt: number;
    outcome: 'unchanged' | 'changed' | 'error' | 'skipped';
    recordsSeen: number;
    passesChanged: number;
    errorCode: string | null;
    errorDetail: string | null;
    httpStatus: number | null;
    credentialKeysetCommitment?: string;
    workflowInstanceId?: string;
    staleWorkflowScope?: { orgId: string; connectionId: string };
    expected?: {
      connectionId: string;
      orgId: string;
      generation: number;
      mode?: ConnectionMode;
      requireEnabled?: boolean;
    };
  },
  actor: ConnectionActor,
): Promise<boolean> {
  const keyset = r.credentialKeysetCommitment;
  const workflow = r.workflowInstanceId;
  const staleScope = r.staleWorkflowScope;
  if (
    (r.expected?.mode !== undefined && !ConnectionModeSchema.options.includes(r.expected.mode)) ||
    (r.expected?.requireEnabled !== undefined && typeof r.expected.requireEnabled !== 'boolean') ||
    (keyset !== undefined && !validCredentialKeysetCommitment(keyset)) ||
    (workflow !== undefined &&
      (typeof workflow !== 'string' || !workflow || workflow !== r.id || keyset === undefined)) ||
    (r.expected !== undefined &&
      (r.expected.orgId !== actor.orgId || r.expected.connectionId !== r.connectionId))
  )
    return false;
  if (
    staleScope !== undefined &&
    (!staleScope ||
      r.outcome !== 'skipped' ||
      workflow === undefined ||
      keyset === undefined ||
      r.expected !== undefined ||
      typeof staleScope.orgId !== 'string' ||
      staleScope.orgId !== actor.orgId ||
      typeof staleScope.connectionId !== 'string' ||
      staleScope.connectionId !== r.connectionId)
  )
    return false;
  const e = r.expected;
  // A stale close has no expectation to compare and must finish while the org is suspended.
  const closing = e === undefined;
  const checks: Check[] = [
    connectionIs({
      id: r.connectionId,
      ...(e ? { generation: e.generation } : {}),
      ...(e?.mode === undefined ? {} : { syncMode: e.mode }),
      ...(e?.requireEnabled ? { enabled: true } : {}),
    }),
  ];
  if (workflow !== undefined && keyset !== undefined)
    checks.push(workflowTracked(workflow, r.connectionId, keyset));
  const g = connectionGrant(
    ctx,
    actor,
    'run.finish',
    checks,
    r.id,
    closing && actor.authority === undefined,
  );
  const started = await first<{ started_at: number }>(
    ctx.env.DB,
    'SELECT started_at FROM connection_runs WHERE id = ?',
    [r.id],
  );
  if (!started) return false;
  const set: Record<string, SqlValue> = {
    finished_at: r.finishedAt,
    duration_ms: r.finishedAt - started.started_at,
    outcome: r.outcome,
    records_seen: r.recordsSeen,
    passes_changed: r.passesChanged,
    error_code: r.errorCode,
    error_detail: r.errorDetail,
    http_status: r.httpStatus,
  };
  g.joined('connection_runs', {
    set,
    where: { id: r.id, connection_id: r.connectionId, outcome: 'running' },
    returning: ['id'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}
