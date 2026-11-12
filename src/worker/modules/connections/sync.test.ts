import { beforeEach, describe, expect, it } from 'vitest';
import { guardWrites } from '../../../../test/helpers/guarded-step.ts';
import { makeTemplate, makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { validateInput } from '../../../passkit/build.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { all, first, run } from '../../platform/db.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { getDeps, setDeps } from './deps.ts';
import { breakerDelayMs } from './health.ts';
import type { Incoming } from './record-helpers.ts';
import { applyIncoming, type ConnectionReleaseSnapshot } from './records.ts';
import { getConnection } from './repo.ts';
import { getPassById } from './repo-passes.ts';
import { listRuns } from './repo-runs.ts';
import { prepare } from './runtime.ts';
import {
  inlineStep,
  passRelease,
  replaceKeysetForTest,
  seedConnectionWorkflow,
} from './runtime-fixtures.ts';
import { reconcileConnections } from './schedule.ts';
import * as service from './service.ts';
import { applyChanges, type Change, type ChangeItemOutcome, runRefs } from './sync-apply.ts';
import { executeSync, type StepLike, type SyncRunParams } from './sync-runner.ts';
import { createDemo, type Kit, linkedPass, makeKit, withWorkflow } from './test-kit.ts';
import type { RetainedWebhookCandidate } from './webhook-retention-items.ts';

let kit: Kit;
let n = 0;
beforeEach(async () => {
  kit = await makeKit();
});

function claimed(index: number, candidate: RetainedWebhookCandidate, token = `claim-${index}`) {
  if (candidate.kind !== 'existing' && candidate.kind !== 'new') return null;
  return candidate.kind === 'new'
    ? {
        token,
        revision: 0,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        binding: candidate,
        reservedPassId: candidate.reservedPassId,
        retainedClaim: {
          retentionId: 'retention',
          ordinal: index,
          token,
          revision: 0,
          refHash: 'ref-hash',
          credentialKeysetCommitment: kit.credentialKeysetCommitment,
        },
      }
    : {
        token,
        revision: 0,
        binding: candidate,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
      };
}

async function sync(
  connectionId: string,
  over: Partial<SyncRunParams> = {},
  step: StepLike = inlineStep(),
) {
  const runId = `run-${kit.org.id.slice(-6)}-${++n}`;
  const conn = await getConnection(kit.env.DB, connectionId);
  const params: SyncRunParams = {
    connectionId,
    orgId: conn?.orgId ?? kit.org.id,
    generation: conn?.generation ?? 1,
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    trigger: 'schedule',
    runId,
    instanceId: runId,
    ...over,
  };
  if (conn?.enabled && conn.orgId === params.orgId && conn.generation === params.generation) {
    await seedConnectionWorkflow(kit.sctx, params);
  }
  await executeSync(kit.sctx, step, params);
  const conn2 = await getConnection(kit.env.DB, connectionId);
  const runRow = await first<{
    outcome: string;
    error_code: string | null;
    records_seen: number;
    passes_changed: number;
    http_status: number | null;
    duration_ms: number | null;
  }>(kit.env.DB, 'SELECT * FROM connection_runs WHERE id = ?', [over.runId ?? runId]);
  return { conn: conn2, run: runRow, runId };
}

const passRow = (id: string) =>
  first<{
    sync_error_code: string | null;
    last_synced_at: number | null;
    next_sync_at: number | null;
    sync_failures: number;
  }>(
    kit.env.DB,
    'SELECT sync_error_code, last_synced_at, next_sync_at, sync_failures FROM passes WHERE id = ?',
    [id],
  );

/** Install an unapproved active revision whose input contract rejects the demo records. */
async function installConflictingDraft() {
  const draft = makeTemplate({
    id: kit.templateId,
    orgId: kit.org.id,
    version: 'draft-v2',
  }).resolved;
  draft.manifest.inputs = {
    type: 'object',
    required: ['draftOnly'],
    properties: { draftOnly: { type: 'string' } },
  };
  await persistTemplate(kit, draft);
  await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
    draft.version,
    kit.templateId,
  ]);
  return draft;
}

describe('sync happy path (listChanges)', () => {
  it('applies changes to linked passes and records a healthy run', async () => {
    const dto = await createDemo(kit, { config: { count: 3 } });
    const p1 = await linkedPass(kit, dto.id, 'm-001');
    const p2 = await linkedPass(kit, dto.id, 'm-002');
    kit.clock.advance(1000);

    const { conn, run: r } = await sync(dto.id);

    expect(kit.seams.applied.map((a) => a.passId).sort()).toEqual([p1.id, p2.id].sort());
    expect(kit.seams.applied[0]).toMatchObject({
      connectionId: dto.id,
      generation: 1,
      expectedConnectionMode: 'poll',
      cause: 'connection',
      fields: { memberName: 'Member M-001', memberId: 'm-001' },
    });
    expect(r).toMatchObject({
      outcome: 'changed',
      records_seen: 3,
      passes_changed: 2,
      error_code: null,
    });
    expect(conn).toMatchObject({
      health: 'healthy',
      consecutiveFailures: 0,
      lastSuccessAt: kit.clock.now(),
      cursor: '0:3',
      nextRunAt: kit.clock.now() + 60_000,
    });
    expect((await passRow(p1.id))?.last_synced_at).toBe(kit.clock.now());
    expect(kit.seams.created).toEqual([]);
  });

  it('reports unchanged when the passes service says nothing changed', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    await linkedPass(kit, dto.id, 'm-001');
    kit.seams.changed = false;
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ outcome: 'unchanged', passes_changed: 0, records_seen: 2 });
  });

  it('pages through the whole listing and resumes from the stored cursor', async () => {
    const dto = await createDemo(kit, { config: { count: 25 } });
    const step = inlineStep();
    const { run: r, conn } = await sync(dto.id, {}, step);
    expect(step.names.filter((s) => /^page-\d+$/.test(s))).toEqual(['page-0', 'page-1', 'page-2']);
    expect(r?.records_seen).toBe(25);
    expect(conn?.cursor).toBe('0:25');
    const again = await sync(dto.id);
    expect(again.run?.records_seen).toBe(0);
    expect(again.run?.outcome).toBe('unchanged');
  });

  it('restarts the listing when upstream changes revision', async () => {
    const dto = await createDemo(kit, { config: { count: 4 } });
    await linkedPass(kit, dto.id, 'm-001');
    await sync(dto.id);
    kit.seams.applied.length = 0;
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 4, revision: 1 } });
    await sync(dto.id);
    expect(kit.seams.applied).toHaveLength(1);
  });
});

describe('mapping and validation', () => {
  it('maps upstream fields with transforms before applying', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 },
      mapping: {
        memberName: { from: '/memberName', transform: { kind: 'upper' } },
        level: { from: '/tier', transform: { kind: 'enum', options: { map: {}, default: 'x' } } },
        org: { from: '', transform: { kind: 'constant', options: { value: 'Henry' } } },
      },
    });
    await linkedPass(kit, dto.id, 'm-001');
    await sync(dto.id);
    expect(kit.seams.applied[0]?.fields).toEqual({
      memberName: 'MEMBER M-001',
      level: 'x',
      org: 'Henry',
    });
  });

  it('validates existing passes against their pinned version even without a release', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberId: { from: '/memberId' } },
    });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const pinned = makeTemplate({ id: kit.templateId, orgId: kit.org.id }).resolved;
    const draft = await installConflictingDraft();
    const validations: {
      template: { id: string; version: string | null };
      fields: Record<string, unknown>;
    }[] = [];
    let creates = 0;
    setDeps({
      validateFields: async (_ctx, template, fields) => {
        validations.push({ template, fields });
        validateInput(template.version === pinned.version ? pinned : draft, fields);
      },
      requireApprovedRelease: async () => {
        throw new ConflictError('No approved release.', 'TEMPLATE_RELEASE_REQUIRED');
      },
      createPassFromConnection: async () => {
        creates += 1;
        throw new ConflictError('No approved release.', 'TEMPLATE_RELEASE_REQUIRED');
      },
    });

    const { conn, run: r } = await sync(dto.id);

    expect(validations).toEqual([
      {
        template: { id: kit.templateId, version: pinned.version },
        fields: { memberName: 'Alex Morgan', memberId: 'm-001' },
      },
    ]);
    expect(kit.seams.applied.map((input) => input.passId)).toEqual([pass.id]);
    expect(creates).toBe(0);
    expect(conn?.cursor).toBe('0:1');
    expect(r).toMatchObject({ outcome: 'changed', passes_changed: 1, error_code: null });
    expect((await passRow(pass.id))?.last_synced_at).not.toBeNull();
  });

  it('flags an invalid record on its pass, keeps going and marks the run degraded', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      mapping: {
        memberName: { from: '', transform: { kind: 'constant', options: { value: '' } } },
      },
    });
    const p = await linkedPass(kit, dto.id, 'm-001');
    const { conn, run: r } = await sync(dto.id);
    expect(kit.seams.applied).toEqual([]);
    expect(r).toMatchObject({ outcome: 'unchanged', error_code: 'RECORD_ERRORS', records_seen: 2 });
    expect(conn).toMatchObject({
      health: 'degraded',
      consecutiveFailures: 0,
      lastErrorCode: 'RECORD_ERRORS',
    });
    expect((await passRow(p.id))?.sync_error_code).toBe('INVALID_INPUT');
    expect((await passRow(p.id))?.sync_failures).toBe(1);
  });

  it('isolates a failing pass update from the rest', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    const p1 = await linkedPass(kit, dto.id, 'm-001');
    await linkedPass(kit, dto.id, 'm-002');
    setDeps({
      applyConnectionRecord: async (ctx, input) => {
        if (input.passId === p1.id) throw new NotFoundError('gone', 'PASS_BUSY');
        return {
          changed: true,
          version: input.expectedVersion,
          ...(await passRelease(ctx, input.passId)),
          identityId: input.identityId,
          ownerUserId: input.ownerUserId,
          linkGeneration: input.linkGeneration,
          credentialGeneration: input.credentialGeneration,
          lifecycleGeneration: input.lifecycleGeneration,
          credentialKeysetCommitment: input.credentialKeysetCommitment,
          transferPending: false,
          pushQueued: true,
        };
      },
    });
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ records_seen: 2, passes_changed: 1, error_code: 'RECORD_ERRORS' });
    expect((await passRow(p1.id))?.sync_error_code).toBe('PASS_BUSY');
  });

  it.each([
    ['record', 'transferPending', true],
    ['record', 'transferPending', undefined],
    ['missing', 'transferPending', true],
    ['missing', 'transferPending', undefined],
    ['record', 'pushQueued', undefined],
    ['record', 'pushQueued', 'yes'],
    ['missing', 'pushQueued', undefined],
    ['missing', 'pushQueued', 'yes'],
    ['record', 'templateId', undefined],
    ['record', 'templateVersion', undefined],
    ['record', 'releaseId', undefined],
    ['record', 'credentialKeysetCommitment', undefined],
    ['record', 'credentialKeysetCommitment', 'invalid'],
    ['missing', 'credentialKeysetCommitment', undefined],
    ['missing', 'credentialKeysetCommitment', 'invalid'],
    ['missing', 'templateId', undefined],
    ['missing', 'templateVersion', undefined],
    ['missing', 'releaseId', undefined],
  ] as const)('does not bookkeep a %s mutation with invalid %s=%s', async (path, field, value) => {
    const dto = await createDemo(kit, {
      onMissing: 'flag',
      mapping: { memberName: { from: '/memberName' } },
    });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    const apply = getDeps().applyConnectionRecord;
    const missing = getDeps().markPassMissing;
    setDeps({
      applyConnectionRecord: async (...args) =>
        ({ ...(await apply(...args)), [field]: value }) as never,
      markPassMissing: async (...args) =>
        ({ ...(await missing(...args)), [field]: value }) as never,
    });
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    const incoming: Incoming =
      path === 'record'
        ? { kind: 'record', record: { memberName: 'Updated' } }
        : { kind: 'missing' };
    expect(
      await applyIncoming(kit.sctx, conn, 'm-001', incoming, {
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        cause: 'connection',
        intervalMs: 60_000,
      }),
    ).toEqual({ outcome: 'fenced' });
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(outbox);
  });

  it.each(['credential', 'lifecycle', 'pending only', 'keyset'] as const)(
    'classifies %s result drift without applying bookkeeping',
    async (change) => {
      const dto = await createDemo(kit, { mapping: { memberName: { from: '/memberName' } } });
      const pass = await linkedPass(kit, dto.id, 'm-001');
      const stored = await getPassById(kit.env.DB, pass.id);
      const conn = await getConnection(kit.env.DB, dto.id);
      if (!stored || !conn) throw new Error('Missing bound pass or connection');
      const binding = {
        kind: 'existing' as const,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        templateId: stored.templateId,
        templateVersion: stored.templateVersion,
        releaseId: stored.releaseId,
        snapshot: {
          passId: stored.id,
          orgId: stored.orgId,
          identityId: stored.identityId,
          mode: 'live' as const,
          status: 'active' as const,
          expectedVersion: stored.version,
          expectedRowVersion: stored.rowVersion,
          ownerUserId: stored.ownerUserId,
          linkGeneration: stored.linkGeneration,
          credentialGeneration: stored.credentialGeneration,
          lifecycleGeneration: stored.lifecycleGeneration,
          credentialKeysetCommitment: kit.credentialKeysetCommitment,
          transferPending: stored.transferPending,
          connectionId: dto.id,
          externalRef: 'm-001',
          generation: 1,
          expectedConnectionMode: conn.mode,
        },
      };
      const apply = getDeps().applyConnectionRecord;
      setDeps({
        applyConnectionRecord: async (...args) => {
          const result = await apply(...args);
          return {
            ...result,
            ...(change === 'credential'
              ? { credentialGeneration: result.credentialGeneration + 1, transferPending: true }
              : {}),
            ...(change === 'lifecycle'
              ? { lifecycleGeneration: result.lifecycleGeneration + 1 }
              : {}),
            ...(change === 'pending only' ? { transferPending: true } : {}),
            ...(change === 'keyset'
              ? {
                  credentialKeysetCommitment:
                    kit.credentialKeysetCommitment === '0'.repeat(64)
                      ? '1'.repeat(64)
                      : '0'.repeat(64),
                }
              : {}),
          } as never;
        },
      });
      const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const result = await applyIncoming(
        kit.sctx,
        conn,
        'm-001',
        {
          kind: 'record',
          record: { memberName: 'Updated' },
        },
        {
          generation: 1,
          credentialKeysetCommitment: kit.credentialKeysetCommitment,
          cause: 'connection',
          intervalMs: 60_000,
          retainedBinding: binding,
        },
      );
      expect(result).toEqual(
        change === 'credential' || change === 'lifecycle'
          ? { outcome: 'fenced', staleCode: 'STALE_GENERATION' }
          : { outcome: 'fenced' },
      );
      expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
        before,
      );
    },
  );

  it('records the first failing records in the run detail', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      mapping: {
        memberName: { from: '', transform: { kind: 'constant', options: { value: '' } } },
      },
    });
    await linkedPass(kit, dto.id, 'm-001');
    await linkedPass(kit, dto.id, 'm-002');
    const { runId } = await sync(dto.id);
    const row = await first<{ error_detail: string | null }>(
      kit.env.DB,
      'SELECT error_detail FROM connection_runs WHERE id = ?',
      [runId],
    );
    expect(row?.error_detail).toContain('m-001: INVALID_INPUT');
    expect(row?.error_detail?.split('\n')).toHaveLength(2);
  });

  it('never flags a pass for a lost publish race', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    setDeps({
      applyConnectionRecord: async () => {
        throw new ConflictError('race', 'PASS_CONFLICT');
      },
    });
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
    const row = await passRow(p.id);
    expect(row).toMatchObject({ sync_error_code: null, sync_failures: 0, next_sync_at: null });
  });

  it('does not flag a pass for internal errors', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const p = await linkedPass(kit, dto.id, 'm-001');
    setDeps({
      applyConnectionRecord: async () => {
        throw new Error('D1 down');
      },
    });
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ outcome: 'error', error_code: 'INTERNAL' });
    expect(await passRow(p.id)).toMatchObject({ sync_error_code: null, sync_failures: 0 });
  });
});

describe('upstream holder email validation', () => {
  async function holderFixture() {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: {
        baseUrl: 'https://api.example.com',
        recordPath: '/members/{ref}',
        holderEmailPointer: '/direct',
      },
      secrets: { token: 'unchanged-connector-credential' },
      holderEmailField: '/holder',
      autoCreate: true,
      autoEmail: true,
      defaultTemplateId: kit.templateId,
    } as never);
    const owner = await makeUser(kit, {
      primaryEmail: `holder-${kit.org.id.slice(-8)}@example.com`,
    });
    const pass = await linkedPass(kit, dto.id, 'm-001', kit.org.id, 'live', {
      ownerUserId: owner.id,
      holderEmail: owner.primaryEmail,
    });
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    return { dto, conn, pass, owner };
  }

  async function holderState(passId: string, ownerId: string) {
    // Sync bookkeeping is asserted separately; every other persisted pass field must remain unchanged.
    const rawPass = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT * FROM passes WHERE id = ?',
      [passId],
    );
    return {
      pass: rawPass
        ? Object.fromEntries(
            Object.entries(rawPass).filter(
              ([key]) =>
                !['sync_error_code', 'sync_failures', 'next_sync_at', 'last_synced_at'].includes(
                  key,
                ),
            ),
          )
        : null,
      owner: await first(kit.env.DB, 'SELECT * FROM users WHERE id = ?', [ownerId]),
      emails: await all(kit.env.DB, 'SELECT * FROM user_emails WHERE user_id = ? ORDER BY email', [
        ownerId,
      ]),
      credentials: await all(
        kit.env.DB,
        `SELECT id, org_id, kind, kek_version, hex(iv) AS iv, hex(wrapped_dek) AS wrapped_dek,
           hex(ciphertext) AS ciphertext, fingerprint, created_by, created_at
         FROM credentials WHERE org_id = ? ORDER BY id`,
        [kit.org.id],
      ),
      versions: await all(
        kit.env.DB,
        'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
        [passId],
      ),
      outbox: await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
        kit.org.id,
      ]),
    };
  }

  const invalidEmails: { label: string; direct?: string; mapped: Json }[] = [
    {
      label: 'malformed direct with a valid fallback',
      direct: 'bad@@example.com',
      mapped: 'fallback@example.com',
    },
    { label: 'malformed mapped', mapped: 'not-an-email' },
    {
      label: 'blank direct with malformed mapped fallback',
      direct: ' \t ',
      mapped: 'not-an-email',
    },
    { label: 'non-string mapped', mapped: 42 },
    { label: 'object mapped', mapped: { email: 'member@example.com' } },
  ];

  it.each(invalidEmails)(
    'rejects $label without changing the existing pass, owner or credentials',
    async ({ direct, mapped }) => {
      const { conn, pass, owner } = await holderFixture();
      const before = await holderState(pass.id, owner.id);
      expect(before.credentials.length).toBeGreaterThan(0);
      const samples: string[] = [];
      const incoming: Incoming = {
        kind: 'record',
        record: { memberName: 'Changed upstream', holder: mapped },
        ...(direct === undefined ? {} : { holderEmail: direct }),
      };

      const result = await applyIncoming(kit.sctx, conn, 'm-001', incoming, {
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        cause: 'connection',
        intervalMs: 60_000,
        release: { kind: 'approved', ...kit.seams.release },
        samples,
      });

      expect(result.outcome).toBe('invalid');
      expect(samples).toEqual(['m-001: HOLDER_EMAIL_INVALID']);
      expect(await holderState(pass.id, owner.id)).toEqual(before);
      expect(await passRow(pass.id)).toMatchObject({
        sync_error_code: 'HOLDER_EMAIL_INVALID',
        sync_failures: 1,
        last_synced_at: null,
      });
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.createAttempts).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(kit.seams.pushes).toEqual([]);
      expect(kit.seams.jobs).toEqual([]);
    },
  );

  it.each(invalidEmails)(
    'rejects $label before auto-creating a pass',
    async ({ direct, mapped }) => {
      const { conn, pass, owner } = await holderFixture();
      const before = await holderState(pass.id, owner.id);
      const samples: string[] = [];
      const incoming: Incoming = {
        kind: 'record',
        record: { memberName: 'New member', holder: mapped },
        ...(direct === undefined ? {} : { holderEmail: direct }),
      };
      const result = await applyIncoming(kit.sctx, conn, 'new-ref', incoming, {
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        cause: 'connection',
        intervalMs: 60_000,
        release: { kind: 'approved', ...kit.seams.release },
        samples,
      });

      expect(result.outcome).toBe('invalid');
      expect(samples).toEqual(['new-ref: HOLDER_EMAIL_INVALID']);
      expect(await holderState(pass.id, owner.id)).toEqual(before);
      expect(
        await first(
          kit.env.DB,
          'SELECT id FROM passes WHERE org_id = ? AND connection_id = ? AND external_ref = ?',
          [kit.org.id, conn.id, 'new-ref'],
        ),
      ).toBeNull();
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.createAttempts).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(kit.seams.pushes).toEqual([]);
      expect(kit.seams.jobs).toEqual([]);
    },
  );

  it.each([
    {
      label: 'valid direct wins over invalid mapped',
      direct: '  Direct.User@Example.COM  ',
      mapped: 'invalid',
      email: 'direct.user@example.com',
    },
    {
      label: 'normalized mapped',
      mapped: '  Mapped.User@Example.COM  ',
      email: 'mapped.user@example.com',
    },
    {
      label: 'blank direct uses mapped',
      direct: '  ',
      mapped: '  FALLBACK@Example.COM ',
      email: 'fallback@example.com',
    },
    { label: 'missing address', email: null },
    { label: 'null mapped address', mapped: null, email: null },
    { label: 'empty mapped address', mapped: '', email: null },
    { label: 'whitespace mapped address', mapped: ' \t ', email: null },
  ] as { label: string; direct?: string; mapped?: Json; email: string | null }[])(
    'uses $label for new passes',
    async ({ direct, mapped, email }) => {
      const { conn } = await holderFixture();
      const incoming: Incoming = {
        kind: 'record',
        record: { memberName: 'New member', ...(mapped === undefined ? {} : { holder: mapped }) },
        ...(direct === undefined ? {} : { holderEmail: direct }),
      };
      const result = await applyIncoming(kit.sctx, conn, 'new-ref', incoming, {
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        cause: 'connection',
        intervalMs: 60_000,
        release: { kind: 'approved', ...kit.seams.release },
      });
      expect(result.outcome).toBe('created');
      expect(kit.seams.created).toHaveLength(1);
      expect(kit.seams.created[0]).toMatchObject({ holderEmail: email, sendEmail: email !== null });
    },
  );

  it.each([undefined, null, '', ' \t '] as const)(
    'treats an absent direct address (%s) as eligible for a mapped fallback',
    async (direct) => {
      const { conn } = await holderFixture();
      const incoming: Incoming = {
        kind: 'record',
        record: { memberName: 'New member', holder: '  Fallback@Example.COM ' },
        // A connector can supply null at runtime even though its typed contract omits it.
        holderEmail: direct as string | undefined,
      };
      const result = await applyIncoming(kit.sctx, conn, 'new-ref', incoming, {
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        cause: 'connection',
        intervalMs: 60_000,
        release: { kind: 'approved', ...kit.seams.release },
      });
      expect(result.outcome).toBe('created');
      expect(kit.seams.created[0]).toMatchObject({
        holderEmail: 'fallback@example.com',
        sendEmail: true,
      });
    },
  );

  it('passes a normalized valid address to existing-pass updates', async () => {
    const { conn, pass } = await holderFixture();
    const result = await applyIncoming(
      kit.sctx,
      conn,
      'm-001',
      {
        kind: 'record',
        record: { memberName: 'Updated' },
        holderEmail: '  Existing@Example.COM ',
      },
      {
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        cause: 'connection',
        intervalMs: 60_000,
        release: { kind: 'approved', ...kit.seams.release },
      },
    );
    expect(result.outcome).toBe('changed');
    expect(kit.seams.applied[0]).toMatchObject({
      passId: pass.id,
      holderEmail: 'existing@example.com',
      fields: { memberName: 'Updated' },
    });
  });

  it('leaves the existing holder untouched when the upstream address is absent', async () => {
    const { conn, pass, owner } = await holderFixture();
    const before = await holderState(pass.id, owner.id);
    const result = await applyIncoming(
      kit.sctx,
      conn,
      'm-001',
      {
        kind: 'record',
        record: { memberName: 'Updated', holder: null },
      },
      {
        generation: 1,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        cause: 'connection',
        intervalMs: 60_000,
        release: { kind: 'approved', ...kit.seams.release },
      },
    );
    expect(result.outcome).toBe('changed');
    expect(kit.seams.applied[0]).toMatchObject({ passId: pass.id, holderEmail: null });
    expect(await holderState(pass.id, owner.id)).toEqual(before);
  });

  it('rejects an invalid direct email supplied by the real HTTP connector', async () => {
    const { dto, pass, owner } = await holderFixture();
    const before = await holderState(pass.id, owner.id);
    setDeps({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            memberName: 'Changed upstream',
            direct: 'not-an-email',
            holder: 'fallback@example.com',
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    const result = await runRefs(kit.sctx, {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      mode: 'poll',
      refs: ['m-001'],
      release: { kind: 'approved', ...kit.seams.release },
    });
    expect(result).toMatchObject({
      seen: 1,
      errors: 1,
      failure: null,
      stale: false,
      samples: ['m-001: HOLDER_EMAIL_INVALID'],
    });
    expect(await holderState(pass.id, owner.id)).toEqual(before);
    expect((await passRow(pass.id))?.sync_error_code).toBe('HOLDER_EMAIL_INVALID');
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
  });
});

describe('auto_create', () => {
  it('does not create passes when off', async () => {
    const dto = await createDemo(kit, { config: { count: 3 } });
    const { run: r } = await sync(dto.id);
    expect(kit.seams.created).toEqual([]);
    expect(r).toMatchObject({ outcome: 'unchanged', records_seen: 3 });
  });

  it('creates passes for new refs when on, without emailing by default', async () => {
    const dto = await createDemo(kit, {
      config: { count: 3 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      holderEmailField: '/email',
    });
    await linkedPass(kit, dto.id, 'm-001');
    const { run: r } = await sync(dto.id);
    expect(kit.seams.created.map((c) => c.externalRef).sort()).toEqual(['m-002', 'm-003']);
    expect(kit.seams.created[0]).toMatchObject({
      orgId: kit.org.id,
      templateId: kit.templateId,
      connectionId: dto.id,
      sendEmail: false,
      holderEmail: expect.stringMatching(/^m-00[23]@example\.com$/),
    });
    expect(r).toMatchObject({ outcome: 'changed', passes_changed: 3 });
  });

  it('does not prevalidate new records against a different active draft', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/memberName' } },
    });
    const draft = await installConflictingDraft();
    expect(draft.version).not.toBe(kit.seams.release.version);
    const validations: unknown[] = [];
    setDeps({
      validateFields: async (_ctx, template, fields) => {
        validations.push(template);
        validateInput(draft, fields);
      },
    });
    expect(() => validateInput(draft, { memberName: 'Member M-001' })).toThrow();

    const { conn, run: r } = await sync(dto.id);

    expect(validations).toEqual([]);
    expect(kit.seams.created).toEqual([
      {
        orgId: kit.org.id,
        credentialKeysetCommitment: kit.credentialKeysetCommitment,
        mode: 'live',
        templateId: kit.templateId,
        expectedRelease: { ...kit.seams.release },
        connectionId: dto.id,
        expectedConnectionMode: 'poll',
        generation: 1,
        externalRef: 'm-001',
        fields: { memberName: 'Member M-001' },
        holderEmail: null,
        sendEmail: false,
      },
    ]);
    expect(conn?.cursor).toBe('0:1');
    expect(r).toMatchObject({ outcome: 'changed', passes_changed: 1, error_code: null });
  });

  it('pins the release before fetching and adopts a replacement only on the next run', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/memberName' } },
    });
    const captured = { ...kit.seams.release };
    const inner = inlineStep();
    const step: StepLike = {
      sleep: inner.sleep,
      do: async (name, fn) => {
        if (name === 'page-0') {
          expect(kit.seams.releaseLookups).toEqual([
            {
              templateId: kit.templateId,
              orgId: kit.org.id,
              mode: 'live',
              provider: 'apple',
            },
          ]);
          kit.seams.release = { ...captured, id: 'replacement-release', generation: 2 };
        }
        return inner.do(name, fn);
      },
    };

    const blocked = await sync(dto.id, {}, step);
    expect(kit.seams.createAttempts[0]?.expectedRelease).toEqual(captured);
    expect(kit.seams.created).toEqual([]);
    expect(blocked.conn?.cursor).toBeNull();
    expect(blocked.run).toMatchObject({
      outcome: 'error',
      error_code: 'TEMPLATE_RELEASE_CONFLICT',
    });

    const resumed = await sync(dto.id);
    expect(kit.seams.releaseLookups).toHaveLength(2);
    expect(kit.seams.created[0]?.expectedRelease).toEqual(kit.seams.release);
    expect(resumed.conn?.cursor).toBe('0:1');
    expect(resumed.run).toMatchObject({ outcome: 'changed', error_code: null });
  });

  it('updates existing passes on later pages while a missing release blocks issuance', async () => {
    const dto = await createDemo(kit, {
      config: { count: 21 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    });
    for (let i = 1; i <= 10; i++) {
      await linkedPass(kit, dto.id, `m-${String(i).padStart(3, '0')}`);
    }
    const later = await linkedPass(kit, dto.id, 'm-021');
    const resolveRelease = getDeps().requireApprovedRelease;
    let missing = true;
    let lookups = 0;
    setDeps({
      requireApprovedRelease: async (...args) => {
        lookups += 1;
        if (missing) throw new ConflictError('No approved release.', 'TEMPLATE_RELEASE_REQUIRED');
        return resolveRelease(...args);
      },
    });
    const step = inlineStep();
    const { conn, run: r } = await sync(dto.id, {}, step);

    expect(step.names).toContain('page-2');
    expect(step.names).toContain('page-0-cursor');
    expect(step.names).not.toContain('page-1-cursor');
    expect(step.names).not.toContain('page-2-cursor');
    expect(kit.seams.applied).toHaveLength(11);
    expect(kit.seams.applied.map((input) => input.passId)).toContain(later.id);
    expect(kit.seams.created).toEqual([]);
    expect(conn?.cursor).toBe('0:10');
    expect(r).toMatchObject({
      outcome: 'error',
      error_code: 'TEMPLATE_RELEASE_REQUIRED',
      records_seen: 21,
      passes_changed: 11,
    });

    missing = false;
    kit.clock.advance(60_000);
    const resumed = await sync(dto.id);
    expect(lookups).toBe(2);
    expect(kit.seams.created).toHaveLength(10);
    expect(
      kit.seams.created.every((input) => input.expectedRelease?.id === kit.seams.release.id),
    ).toBe(true);
    expect(resumed.conn?.cursor).toBe('0:21');
    expect(resumed.run).toMatchObject({ outcome: 'changed', error_code: null });
  });

  it('emails new passes only when auto_email is on and there is an address', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      autoCreate: true,
      autoEmail: true,
      defaultTemplateId: kit.templateId,
      holderEmailField: '/email',
    });
    await sync(dto.id);
    expect(kit.seams.created.every((c) => c.sendEmail)).toBe(true);

    kit.seams.created.length = 0;
    const noEmail = await createDemo(kit, {
      config: { count: 1 },
      autoCreate: true,
      autoEmail: true,
      defaultTemplateId: kit.templateId,
    });
    await sync(noEmail.id);
    expect(kit.seams.created[0]).toMatchObject({ holderEmail: null, sendEmail: false });
  });

  it('rejects invalid new records at the pass-service seam without creating a pass', async () => {
    const dto = await createDemo(kit, {
      config: { count: 2 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      mapping: { memberName: { from: '/nope' } },
    });
    let connectionValidations = 0;
    setDeps({
      validateFields: async () => {
        connectionValidations += 1;
      },
    });
    const { conn, run: r, runId } = await sync(dto.id);
    expect(connectionValidations).toBe(0);
    expect(kit.seams.createAttempts.map((input) => input.externalRef).sort()).toEqual([
      'm-001',
      'm-002',
    ]);
    expect(kit.seams.createAttempts.map((input) => input.fields)).toEqual([{}, {}]);
    expect(kit.seams.created).toEqual([]);
    expect(
      await all(kit.env.DB, 'SELECT id FROM passes WHERE connection_id = ?', [dto.id]),
    ).toEqual([]);
    expect(r).toMatchObject({
      outcome: 'unchanged',
      error_code: 'RECORD_ERRORS',
      records_seen: 2,
      passes_changed: 0,
    });
    expect(conn?.health).toBe('degraded');
    const row = await first<{ error_detail: string | null }>(
      kit.env.DB,
      'SELECT error_detail FROM connection_runs WHERE id = ?',
      [runId],
    );
    expect(row?.error_detail).toContain('m-001: INVALID_INPUT');
    expect(row?.error_detail).toContain('m-002: INVALID_INPUT');
  });

  it.each(['TEMPLATE_RELEASE_REQUIRED', 'TEMPLATE_RELEASE_CONFLICT'] as const)(
    'blocks and later resumes polling when the pass service reports %s',
    async (code) => {
      const dto = await createDemo(kit, {
        config: { count: 1 },
        autoCreate: true,
        defaultTemplateId: kit.templateId,
      });
      await run(kit.env.DB, 'UPDATE connections SET cursor = ? WHERE id = ?', ['0:0', dto.id]);
      const resolveRelease = getDeps().requireApprovedRelease;
      const createPass = getDeps().createPassFromConnection;
      let missing = code === 'TEMPLATE_RELEASE_REQUIRED';
      let replaceBeforeCreate = code === 'TEMPLATE_RELEASE_CONFLICT';
      let lookups = 0;
      setDeps({
        requireApprovedRelease: async (...args) => {
          lookups += 1;
          if (missing) throw new ConflictError('No approved release.', code);
          return resolveRelease(...args);
        },
        createPassFromConnection: async (ctx, input) => {
          if (replaceBeforeCreate) {
            replaceBeforeCreate = false;
            kit.seams.release = { ...kit.seams.release, id: 'replacement-release', generation: 2 };
          }
          return createPass(ctx, input);
        },
      });
      const step = inlineStep();
      const { conn, run: r } = await sync(dto.id, {}, step);
      expect(lookups).toBe(1);
      expect(kit.seams.created).toEqual([]);
      expect(conn).toMatchObject({
        cursor: '0:0',
        nextRunAt: kit.clock.now() + 60_000,
        consecutiveFailures: 0,
      });
      expect(step.names).not.toContain('page-0-cursor');
      expect(r).toMatchObject({
        outcome: 'error',
        error_code: code,
        records_seen: 1,
        passes_changed: 0,
      });

      missing = false;
      kit.clock.advance(60_000);
      const resumed = await sync(dto.id);
      expect(lookups).toBe(2);
      expect(resumed.conn?.cursor).toBe('0:1');
      expect(resumed.run).toMatchObject({
        outcome: 'changed',
        error_code: null,
        passes_changed: 1,
      });
      expect(kit.seams.created).toHaveLength(1);
      expect(kit.seams.created[0]?.expectedRelease).toEqual(kit.seams.release);
    },
  );

  it('blocks cursor advancement if the pass service loses the captured release', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    });
    let creates = 0;
    setDeps({
      createPassFromConnection: async (_ctx, input) => {
        creates += 1;
        expect(input.expectedRelease).toEqual(kit.seams.release);
        throw new ConflictError('The release was removed.', 'TEMPLATE_RELEASE_REQUIRED');
      },
    });
    const { conn, run: r } = await sync(dto.id);
    expect(creates).toBe(1);
    expect(conn).toMatchObject({ cursor: null, nextRunAt: kit.clock.now() + 60_000 });
    expect(r).toMatchObject({ outcome: 'error', error_code: 'TEMPLATE_RELEASE_REQUIRED' });
    expect(kit.seams.created).toEqual([]);
  });

  it('holds the cursor and backs off when approved template content changes', async () => {
    const dto = await createDemo(kit, {
      config: { count: 1 },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    });
    await run(kit.env.DB, 'UPDATE connections SET cursor = ? WHERE id = ?', ['0:0', dto.id]);
    const createPass = getDeps().createPassFromConnection;
    let attempts = 0;
    setDeps({
      createPassFromConnection: async () => {
        attempts += 1;
        throw new ConflictError('Template bytes changed.', 'TEMPLATE_CONTENT_CHANGED');
      },
    });
    const step = inlineStep();
    const { conn, run: r } = await sync(dto.id, {}, step);
    expect(attempts).toBe(1);
    expect(conn).toMatchObject({
      cursor: '0:0',
      nextRunAt: kit.clock.now() + 60_000,
      consecutiveFailures: 1,
    });
    expect(step.names).not.toContain('page-0-cursor');
    expect(r).toMatchObject({ outcome: 'error', error_code: 'INTERNAL', passes_changed: 0 });
    expect(kit.seams.created).toEqual([]);

    setDeps({ createPassFromConnection: createPass });
    kit.clock.advance(60_000);
    const resumed = await sync(dto.id);
    expect(resumed.conn?.cursor).toBe('0:1');
    expect(resumed.run).toMatchObject({ outcome: 'changed', error_code: null });
    expect(kit.seams.created).toHaveLength(1);
  });
});

describe('release block effect proof', () => {
  it.each([
    'preblocked-new',
    'preblocked-noop',
    'preblocked-existing',
    'upstream-failure',
    'superseded',
  ] as const)('reports conservative effect-free proof for %s', async (scenario) => {
    const dto = await createDemo(kit, {
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      ...(scenario === 'upstream-failure' ? { config: { count: 1, fail: 'upstream' } } : {}),
    });
    const changes: Change[] = [{ ref: 'new-ref', record: { memberName: 'New' } }];
    if (scenario === 'preblocked-existing') {
      await linkedPass(kit, dto.id, 'existing-ref');
      kit.seams.changed = false;
      changes.push({ ref: 'existing-ref', record: { memberName: 'Existing' } });
    }
    if (scenario === 'preblocked-noop') {
      await linkedPass(kit, dto.id, 'occupied-ref', kit.org.id, 'test');
      changes.push({ ref: 'occupied-ref', record: { memberName: 'Ignored' } });
    }
    if (scenario === 'upstream-failure') changes.push({ ref: 'm-001' });
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    const prep = await prepare(kit.sctx, conn);
    let release: ConnectionReleaseSnapshot = { kind: 'blocked', code: 'TEMPLATE_RELEASE_REQUIRED' };
    if (scenario === 'superseded') {
      release = { kind: 'approved', ...kit.seams.release };
      kit.seams.release = { ...kit.seams.release, id: 'replacement-release', generation: 2 };
    }

    const result = await applyChanges(
      kit.sctx,
      conn,
      prep,
      changes,
      release,
      undefined,
      kit.credentialKeysetCommitment,
    );
    expect(result.releaseBlocked).toBe(
      scenario === 'superseded' ? 'TEMPLATE_RELEASE_CONFLICT' : 'TEMPLATE_RELEASE_REQUIRED',
    );
    expect(result.effectFree).toBe(scenario === 'preblocked-new' || scenario === 'preblocked-noop');
    expect(kit.seams.applied).toHaveLength(scenario === 'preblocked-existing' ? 1 : 0);
    expect(kit.seams.created).toEqual([]);
  });

  it('reports original ordinals across batches and duplicate refs while skipping claimed work', async () => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'hybrid',
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      maxConcurrency: 2,
    });
    const pass = await linkedPass(kit, dto.id, 'existing-ref');
    const alreadyFinished = await linkedPass(kit, dto.id, 'already-finished');
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    const prep = await prepare(kit.sctx, conn);
    const changes: Change[] = [
      { ref: 'new-ref', record: { memberName: 'New' } },
      { ref: 'existing-ref', record: { memberName: 'Existing' } },
      { ref: 'new-ref', record: { memberName: 'New again' } },
      { ref: 'already-finished', record: { memberName: 'Skip' } },
      { ref: 'absent', deleted: true },
    ];
    const begun: number[] = [];
    const finished: { index: number; token: string; outcome: ChangeItemOutcome; code?: string }[] =
      [];
    const result = await applyChanges(
      kit.sctx,
      conn,
      prep,
      changes,
      { kind: 'blocked', code: 'TEMPLATE_RELEASE_REQUIRED' },
      {
        begin: async (index, candidate) => {
          begun.push(index);
          if (candidate.kind === 'no-effect') {
            finished.push({ index, token: `claim-${index}`, outcome: 'success' });
            return null;
          }
          return index === 3 ? null : claimed(index, candidate);
        },
        finish: async (index, token, outcome, code) => {
          finished.push({ index, token, outcome, ...(code ? { code } : {}) });
        },
      },
      kit.credentialKeysetCommitment,
    );
    expect(begun).toEqual([0, 1, 2, 3, 4]);
    expect(finished.sort((a, b) => a.index - b.index)).toEqual([
      { index: 0, token: 'claim-0', outcome: 'blocked', code: 'TEMPLATE_RELEASE_REQUIRED' },
      { index: 1, token: 'claim-1', outcome: 'success' },
      { index: 2, token: 'claim-2', outcome: 'blocked', code: 'TEMPLATE_RELEASE_REQUIRED' },
      { index: 4, token: 'claim-4', outcome: 'success' },
    ]);
    expect(result.effectFree).toBe(false);
    expect(kit.seams.applied.map((input) => input.passId)).toEqual([pass.id]);
    expect(kit.seams.applied.map((input) => input.passId)).not.toContain(alreadyFinished.id);
    expect(kit.seams.created).toEqual([]);
  });

  it('reports a post-service release conflict as uncertain, never safely blocked', async () => {
    const dto = await createDemo(kit, {
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'hybrid',
    });
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    const prep = await prepare(kit.sctx, conn);
    const captured = { kind: 'approved' as const, ...kit.seams.release };
    kit.seams.release = { ...kit.seams.release, id: 'replacement-release', generation: 2 };
    const finished: { index: number; outcome: ChangeItemOutcome; code?: string }[] = [];

    const result = await applyChanges(
      kit.sctx,
      conn,
      prep,
      [{ ref: 'new-ref', record: { memberName: 'New' } }],
      captured,
      {
        begin: async (index, candidate) => claimed(index, candidate, 'claim'),
        finish: async (index, _token, outcome, code) => {
          finished.push({ index, outcome, ...(code ? { code } : {}) });
        },
      },
      kit.credentialKeysetCommitment,
    );
    expect(result.releaseBlocked).toBe('TEMPLATE_RELEASE_CONFLICT');
    expect(result.effectFree).toBe(false);
    expect(finished).toEqual([
      { index: 0, outcome: 'uncertain', code: 'TEMPLATE_RELEASE_CONFLICT' },
    ]);
    expect(kit.seams.created).toEqual([]);
  });

  it('marks a claimed item uncertain when the pass service throws', async () => {
    const dto = await createDemo(kit, {
      autoCreate: true,
      defaultTemplateId: kit.templateId,
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com' },
      mode: 'hybrid',
    });
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    const prep = await prepare(kit.sctx, conn);
    const failure = new Error('pass service unavailable');
    setDeps({
      createPassFromConnection: async () => {
        throw failure;
      },
    });
    const finished: { index: number; outcome: ChangeItemOutcome }[] = [];

    await expect(
      applyChanges(
        kit.sctx,
        conn,
        prep,
        [{ ref: 'new-ref', record: { memberName: 'New' } }],
        { kind: 'approved', ...kit.seams.release },
        {
          begin: async (index, candidate) => claimed(index, candidate, 'claim'),
          finish: async (index, _token, outcome) => {
            finished.push({ index, outcome });
          },
        },
        kit.credentialKeysetCommitment,
      ),
    ).rejects.toBe(failure);
    expect(finished).toEqual([{ index: 0, outcome: 'uncertain' }]);
    expect(kit.seams.created).toEqual([]);
  });

  it.each(['create', 'update'] as const)(
    'distinguishes pre-effect content-change proof for %s',
    async (path) => {
      const dto = await createDemo(kit, {
        autoCreate: true,
        defaultTemplateId: kit.templateId,
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com' },
        mode: 'hybrid',
      });
      if (path === 'update') await linkedPass(kit, dto.id, 'ref');
      const conn = await getConnection(kit.env.DB, dto.id);
      if (!conn) throw new Error('Missing connection');
      const prep = await prepare(kit.sctx, conn);
      const failure = new ConflictError('Template bytes changed.', 'TEMPLATE_CONTENT_CHANGED');
      if (path === 'create') {
        setDeps({
          createPassFromConnection: async () => {
            throw failure;
          },
        });
      } else {
        setDeps({
          applyConnectionRecord: async () => {
            throw failure;
          },
        });
      }
      const finished: { index: number; outcome: ChangeItemOutcome; code?: string }[] = [];
      await expect(
        applyChanges(
          kit.sctx,
          conn,
          prep,
          [{ ref: 'ref', record: { memberName: 'Member' } }],
          { kind: 'approved', ...kit.seams.release },
          {
            begin: async (index, candidate) => claimed(index, candidate, 'claim'),
            finish: async (index, _token, outcome, code) => {
              finished.push({ index, outcome, ...(code ? { code } : {}) });
            },
          },
          kit.credentialKeysetCommitment,
        ),
      ).rejects.toMatchObject({ code: 'TEMPLATE_CONTENT_CHANGED' });
      expect(finished).toEqual(
        path === 'create'
          ? [{ index: 0, outcome: 'retry', code: 'TEMPLATE_CONTENT_CHANGED' }]
          : [{ index: 0, outcome: 'uncertain' }],
      );
    },
  );

  it.each([
    ['INVALID_PAYLOAD', 'failed', 200, 'not json'],
    ['UPSTREAM', 'retry', 503, 'unavailable'],
  ] as const)('records pre-apply %s as %s', async (code, outcome, status, body) => {
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    } as never);
    setDeps({ fetchImpl: (async () => new Response(body, { status })) as typeof fetch });
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    const prep = await prepare(kit.sctx, conn);
    const finished: { index: number; outcome: ChangeItemOutcome; code?: string }[] = [];
    await applyChanges(
      kit.sctx,
      conn,
      prep,
      [{ ref: 'new-ref' }],
      { kind: 'blocked', code: 'TEMPLATE_RELEASE_REQUIRED' },
      {
        begin: async (index, candidate) => claimed(index, candidate, 'claim'),
        finish: async (index, _token, itemOutcome, itemCode) => {
          finished.push({ index, outcome: itemOutcome, ...(itemCode ? { code: itemCode } : {}) });
        },
      },
      kit.credentialKeysetCommitment,
    );
    expect(finished).toEqual([{ index: 0, outcome, code }]);
    expect(kit.seams.created).toEqual([]);
  });
});

describe('retained observer binding', () => {
  it.each([
    'pass id',
    'version',
    'identity',
    'credential',
    'lifecycle',
    'keyset',
    'pending',
    'owner',
    'link',
    'release',
    'template',
  ] as const)('rejects a substituted %s before any fetch or effect', async (field) => {
    const requests: string[] = [];
    const dto = await createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
      mode: 'manual',
      autoCreate: true,
      defaultTemplateId: kit.templateId,
    } as never);
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const conn = await getConnection(kit.env.DB, dto.id);
    if (!conn) throw new Error('Missing connection');
    setDeps({
      fetchImpl: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ memberName: 'Must not apply' }));
      }) as typeof fetch,
    });
    const prep = await prepare(kit.sctx, conn);
    const before = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
    const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    const finished: string[] = [];
    await applyChanges(
      kit.sctx,
      conn,
      prep,
      [{ ref: 'm-001' }],
      { kind: 'approved', ...kit.seams.release },
      {
        begin: async (_index, candidate) => {
          if (candidate.kind !== 'existing') throw new Error('Missing existing candidate');
          // The observer receives a copy: in-place mutation must not rewrite the captured proof.
          if (field === 'pass id') candidate.snapshot.passId = 'other-pass';
          if (field === 'version') candidate.snapshot.expectedVersion += 1;
          if (field === 'identity') candidate.snapshot.identityId = 'other-identity';
          if (field === 'credential') candidate.snapshot.credentialGeneration += 1;
          if (field === 'lifecycle') candidate.snapshot.lifecycleGeneration += 1;
          if (field === 'keyset')
            candidate.snapshot.credentialKeysetCommitment =
              kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
          if (field === 'pending') candidate.snapshot.transferPending = true;
          if (field === 'owner') candidate.snapshot.ownerUserId = 'other-owner';
          if (field === 'link') candidate.snapshot.linkGeneration += 1;
          if (field === 'release') candidate.releaseId = 'other-release';
          if (field === 'template') candidate.templateVersion = 'other-version';
          return {
            token: 'claim',
            revision: 0,
            binding: candidate,
            credentialKeysetCommitment: kit.credentialKeysetCommitment,
          };
        },
        finish: async (_index, _token, outcome) => {
          finished.push(outcome);
        },
      },
      kit.credentialKeysetCommitment,
    );
    expect(finished).toEqual(['uncertain']);
    expect(requests).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(before);
    expect(
      await all(kit.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(outbox);
  });

  it.each(['binding', 'reserved id', 'token', 'revision', 'ref hash', 'claim keyset'] as const)(
    'rejects a new-item %s substitution before fetching or creating',
    async (field) => {
      const requests: string[] = [];
      const dto = await createDemo(kit, {
        connectorType: 'http-json',
        config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
        mode: 'manual',
        autoCreate: true,
        defaultTemplateId: kit.templateId,
      } as never);
      const conn = await getConnection(kit.env.DB, dto.id);
      if (!conn) throw new Error('Missing connection');
      setDeps({
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Must not create' }));
        }) as typeof fetch,
      });
      const prep = await prepare(kit.sctx, conn);
      const outbox = await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
        kit.org.id,
      ]);
      const finished: string[] = [];
      await applyChanges(
        kit.sctx,
        conn,
        prep,
        [{ ref: 'new-ref' }],
        { kind: 'approved', ...kit.seams.release },
        {
          begin: async (index, candidate) => {
            if (candidate.kind !== 'new') throw new Error('Missing new candidate');
            const reservedPassId = candidate.reservedPassId;
            if (field === 'binding') candidate.generation += 1;
            return {
              token: 'claim',
              revision: 0,
              credentialKeysetCommitment: kit.credentialKeysetCommitment,
              binding: candidate,
              reservedPassId: field === 'reserved id' ? `${reservedPassId}-other` : reservedPassId,
              retainedClaim: {
                retentionId: 'retention',
                ordinal: index,
                token: field === 'token' ? 'other-token' : 'claim',
                revision: field === 'revision' ? 1 : 0,
                refHash: field === 'ref hash' ? '' : 'ref-hash',
                credentialKeysetCommitment:
                  field === 'claim keyset'
                    ? kit.credentialKeysetCommitment === '0'.repeat(64)
                      ? '1'.repeat(64)
                      : '0'.repeat(64)
                    : kit.credentialKeysetCommitment,
              },
            };
          },
          finish: async (_index, _token, outcome) => {
            finished.push(outcome);
          },
        },
        kit.credentialKeysetCommitment,
      );
      expect(finished).toEqual(['uncertain']);
      expect(requests).toEqual([]);
      expect(kit.seams.createAttempts).toEqual([]);
      expect(
        await all(kit.env.DB, 'SELECT id FROM passes WHERE connection_id = ?', [dto.id]),
      ).toEqual([]);
      expect(
        await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [kit.org.id]),
      ).toEqual(outbox);
    },
  );
});

describe('on_missing', () => {
  async function missingRun(onMissing: 'keep' | 'flag' | 'void') {
    const dto = await createDemo(kit, { config: { count: 3, missing: ['m-002'] }, onMissing });
    const p = await linkedPass(kit, dto.id, 'm-002');
    const out = await sync(dto.id);
    return { p, ...out };
  }

  it('flags', async () => {
    const { p, run: r } = await missingRun('flag');
    expect(kit.seams.missing).toEqual([{ passId: p.id, mode: 'flag' }]);
    expect(r?.passes_changed).toBe(1);
  });

  it('voids', async () => {
    const { p } = await missingRun('void');
    expect(kit.seams.missing).toEqual([{ passId: p.id, mode: 'void' }]);
  });

  it('keeps: leaves the pass alone', async () => {
    const { p, run: r } = await missingRun('keep');
    expect(kit.seams.missing).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
    expect(r?.passes_changed).toBe(0);
    expect((await passRow(p.id))?.last_synced_at).not.toBeNull();
  });

  it('ignores deletions for refs that have no pass', async () => {
    const dto = await createDemo(kit, { config: { count: 3, missing: ['m-002'] } });
    await sync(dto.id);
    expect(kit.seams.missing).toEqual([]);
  });
});

describe('failures never touch passes', () => {
  it.each([
    ['auth', 'AUTH'],
    ['timeout', 'TIMEOUT'],
    ['upstream', 'UPSTREAM'],
    ['rate_limited', 'RATE_LIMITED'],
  ])('%s', async (fail, code) => {
    const dto = await createDemo(kit, { config: { count: 3, fail }, onMissing: 'void' });
    const p = await linkedPass(kit, dto.id, 'm-001');
    const { conn, run: r } = await sync(dto.id);
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.missing).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    const row = await passRow(p.id);
    expect(row).toMatchObject({ sync_error_code: null, last_synced_at: null, sync_failures: 0 });
    expect(r).toMatchObject({ outcome: 'error', error_code: code });
    expect(conn).toMatchObject({ health: 'degraded', consecutiveFailures: 1, lastErrorCode: code });
  });

  it('records the HTTP status of the failure', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'auth' } });
    expect((await sync(dto.id)).run?.http_status).toBe(401);
  });

  it('a later success resets the failure count', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'timeout' } });
    await sync(dto.id);
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 1 } });
    const { conn } = await sync(dto.id);
    expect(conn).toMatchObject({ health: 'healthy', consecutiveFailures: 0 });
  });
});

describe('circuit breaker', () => {
  it('doubles from 5 minutes to a 1 hour cap', () => {
    expect([1, 4].map(breakerDelayMs)).toEqual([300_000, 300_000]);
    expect([5, 6, 7, 8, 9, 20].map(breakerDelayMs)).toEqual([
      300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000,
    ]);
  });

  it('opens after 5 consecutive failures, audits once, and blocks scheduling until it elapses', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'upstream' } });
    const { sctx, created } = withWorkflow(kit);
    const mine = () => created.filter((c) => c.params.connectionId === dto.id);
    for (let i = 0; i < 4; i++) {
      const { conn } = await sync(dto.id);
      expect(conn?.breakerOpenUntil).toBeNull();
      kit.clock.advance(61_000);
    }
    const fifth = await sync(dto.id);
    expect(fifth.conn).toMatchObject({
      health: 'failing',
      consecutiveFailures: 5,
      breakerOpenUntil: kit.clock.now() + 300_000,
    });
    expect(fifth.conn?.nextRunAt).toBe(kit.clock.now() + 300_000);
    const audits = await all(
      kit.env.DB,
      "SELECT 1 FROM audit_log WHERE action = 'connection.breaker_open' AND target_id = ?",
      [dto.id],
    );
    expect(audits).toHaveLength(1);

    kit.clock.advance(120_000);
    await reconcileConnections({ ...sctx, clock: kit.clock });
    expect(mine()).toEqual([]);

    // Half-open: the next run after the window is a probe. A failure re-opens for longer.
    kit.clock.advance(300_000);
    await reconcileConnections({ ...sctx, clock: kit.clock });
    expect(mine()).toHaveLength(1);
    const sixth = await sync(dto.id);
    expect(sixth.conn?.breakerOpenUntil).toBe(kit.clock.now() + 600_000);
    expect(
      await all(
        kit.env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'connection.breaker_open' AND target_id = ?",
        [dto.id],
      ),
    ).toHaveLength(1);

    // A successful probe closes it.
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 1 } });
    kit.clock.advance(1);
    const ok = await sync(dto.id);
    expect(ok.conn).toMatchObject({
      health: 'healthy',
      consecutiveFailures: 0,
      breakerOpenUntil: null,
    });
  });
});

describe('generation fence', () => {
  it('skips a run started for an old generation', async () => {
    const dto = await createDemo(kit, { config: { count: 2 } });
    await linkedPass(kit, dto.id, 'm-001');
    const params: SyncRunParams = {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      trigger: 'schedule',
      runId: 'stale-generation',
      instanceId: 'stale-generation',
    };
    await seedConnectionWorkflow(kit.sctx, params);
    await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 2, seed: 'new' } });
    await executeSync(kit.sctx, inlineStep(), params);
    expect(
      await first(kit.env.DB, 'SELECT outcome, error_code FROM connection_runs WHERE id = ?', [
        params.runId,
      ]),
    ).toEqual({ outcome: 'skipped', error_code: 'STALE_GENERATION' });
    const conn = await getConnection(kit.env.DB, dto.id);
    expect(kit.seams.applied).toEqual([]);
    expect(conn).toMatchObject({ health: 'unknown', consecutiveFailures: 0, lastRunAt: null });
  });

  it.each(['page-0', 'page-0-apply-0', 'page-0-cursor', 'due', 'chunk-0'] as const)(
    'does not adopt a changed keyset at workflow step %s',
    async (at) => {
      const fanout = at === 'due' || at === 'chunk-0';
      const dto = await createDemo(
        kit,
        fanout
          ? ({
              connectorType: 'http-json',
              config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
              autoCreate: true,
              defaultTemplateId: kit.templateId,
            } as never)
          : { config: { count: 1 }, autoCreate: true, defaultTemplateId: kit.templateId },
      );
      const pass = await linkedPass(kit, dto.id, 'm-001');
      const requests: string[] = [];
      setDeps({
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Changed' }));
        }) as typeof fetch,
      });
      const inner = inlineStep();
      const other =
        kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
      let afterFlip: unknown;
      let outboxAfterFlip: unknown;
      const step: StepLike = {
        sleep: inner.sleep,
        do: async (name, fn) => {
          if (name === at) {
            await replaceKeysetForTest(kit.sctx, other);
            afterFlip = await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
            outboxAfterFlip = await all(
              kit.env.DB,
              'SELECT * FROM outbox WHERE org_id = ? ORDER BY id',
              [kit.org.id],
            );
          }
          return inner.do(name, fn);
        },
      };
      try {
        await expect(sync(dto.id, {}, step)).rejects.toMatchObject({
          code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
        });
        expect(afterFlip).toBeDefined();
        expect(await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(
          afterFlip,
        );
        expect(
          await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [kit.org.id]),
        ).toEqual(outboxAfterFlip);
        expect((await getConnection(kit.env.DB, dto.id))?.cursor).toBeNull();
        if (fanout) expect(requests).toEqual([]);
      } finally {
        await replaceKeysetForTest(kit.sctx, kit.credentialKeysetCommitment);
      }
    },
  );

  it('stops mid-run when the connection changes, without moving the cursor or health', async () => {
    const dto = await createDemo(kit, { config: { count: 25 } });
    await linkedPass(kit, dto.id, 'm-001');
    const inner = inlineStep();
    const step: StepLike = {
      sleep: inner.sleep,
      do: async (name, fn) => {
        if (name === 'page-1') {
          await service.update(kit.sctx, kit.actor, dto.id, {
            mapping: { memberName: { from: '/memberName' } },
          });
        }
        return inner.do(name, fn);
      },
    };
    const { run: r, conn } = await sync(dto.id, { generation: 1 }, step);
    expect(r?.outcome).toBe('skipped');
    expect(conn?.generation).toBe(2);
    expect(conn?.cursor).toBe('0:10');
    expect(conn?.health).toBe('unknown');
    expect(kit.seams.applied).toHaveLength(1);
  });

  it.each(['page-0', 'page-0-apply-0', 'page-0-cursor'] as const)(
    'keeps a poll snapshot fenced when mode changes before %s',
    async (changeAt) => {
      const dto = await createDemo(kit, { config: { count: 1 } });
      const healthSql = `SELECT health, consecutive_failures, breaker_open_until, cursor, next_run_at,
        last_run_at, last_success_at, last_error_code, last_error_at, updated_at
        FROM connections WHERE id = ?`;
      const before = await first(kit.env.DB, healthSql, [dto.id]);
      let switched = false;
      const inner = inlineStep();
      const step: StepLike = {
        sleep: inner.sleep,
        do: async (name, fn) => {
          if (name === changeAt) {
            switched = true;
            await run(kit.env.DB, "UPDATE connections SET mode = 'manual' WHERE id = ?", [dto.id]);
          }
          return inner.do(name, fn);
        },
      };
      const { run: result, conn } = await sync(dto.id, { generation: 1 }, step);
      expect(switched).toBe(true);
      expect(result?.outcome).toBe('skipped');
      // A mode change is a bump column: the trigger moves generation with it.
      expect(conn).toMatchObject({ mode: 'manual', generation: 2, cursor: null });
      expect(await first(kit.env.DB, healthSql, [dto.id])).toEqual(before);
      expect(kit.seams.applied).toEqual([]);
      expect(kit.seams.created).toEqual([]);
      expect(kit.seams.missing).toEqual([]);
    },
  );

  it('does not let a failing stale run open the breaker', async () => {
    const dto = await createDemo(kit, { config: { count: 1, fail: 'auth' } });
    const inner = inlineStep();
    const step: StepLike = {
      sleep: inner.sleep,
      do: async (name, fn) => {
        if (name === 'finish') {
          await service.update(kit.sctx, kit.actor, dto.id, { config: { count: 1 } });
        }
        return inner.do(name, fn);
      },
    };
    const { conn } = await sync(dto.id, {}, step);
    expect(conn).toMatchObject({ consecutiveFailures: 0, generation: 2 });
  });

  it('ignores disabled and deleted connections', async () => {
    const dto = await createDemo(kit);
    const queued: SyncRunParams = {
      connectionId: dto.id,
      orgId: kit.org.id,
      generation: 1,
      credentialKeysetCommitment: kit.credentialKeysetCommitment,
      trigger: 'schedule',
      runId: 'disabled-run',
      instanceId: 'disabled-run',
    };
    await seedConnectionWorkflow(kit.sctx, queued);
    await service.update(kit.sctx, kit.actor, dto.id, { enabled: false });
    expect((await sync(dto.id, queued)).run).toMatchObject({
      outcome: 'skipped',
      error_code: 'STALE_CONTEXT',
    });
    await expect(sync(dto.id, { generation: 1 })).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    await service.remove(kit.sctx, kit.actor, dto.id);
    const step = inlineStep();
    await expect(sync(dto.id, queued, step)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    expect(step.names).toEqual([]);
    expect(kit.seams.applied).toEqual([]);
  });
});

describe('fan-out over passes (no listChanges)', () => {
  const upstream: { calls: string[]; status: number; body: object } = {
    calls: [],
    status: 200,
    body: {},
  };

  async function httpConn(over: Record<string, unknown> = {}) {
    upstream.calls = [];
    upstream.status = 200;
    upstream.body = { memberName: 'From API' };
    setDeps({
      fetchImpl: (async (url: string) => {
        upstream.calls.push(String(url));
        return new Response(JSON.stringify(upstream.body), {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    return createDemo(kit, {
      connectorType: 'http-json',
      config: { baseUrl: 'https://api.example.com/v1', recordPath: '/members/{ref}' },
      secrets: { token: 'abc' },
      maxConcurrency: 2,
      requestsPerMinute: 60,
      ...over,
    } as never);
  }

  it('fetches due passes in chunks of maxConcurrency, pacing between chunks', async () => {
    const dto = await httpConn();
    for (const ref of ['r1', 'r2', 'r3', 'r4', 'r5']) await linkedPass(kit, dto.id, ref);
    const step = inlineStep();
    const { run: r } = await sync(dto.id, {}, step);
    expect(step.names).toEqual([
      'start',
      'limits',
      'due',
      'chunk-0',
      'chunk-2',
      'chunk-4',
      'finish',
    ]);
    expect(step.sleeps).toEqual([2000, 2000]);
    expect(upstream.calls.sort()).toEqual(
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((x) => `https://api.example.com/v1/members/${x}`),
    );
    expect(kit.seams.applied).toHaveLength(5);
    expect(r).toMatchObject({ outcome: 'changed', records_seen: 5 });
  });

  it('only fetches passes whose next_sync_at has come', async () => {
    const dto = await httpConn();
    const due = await linkedPass(kit, dto.id, 'due');
    const later = await linkedPass(kit, dto.id, 'later');
    await run(kit.env.DB, 'UPDATE passes SET next_sync_at = ? WHERE id = ?', [
      kit.clock.now() + 60_000,
      later.id,
    ]);
    await sync(dto.id);
    expect(kit.seams.applied.map((a) => a.passId)).toEqual([due.id]);
    expect((await passRow(due.id))?.next_sync_at).toBe(kit.clock.now() + 900_000);
  });

  it('stops at the first upstream failure and leaves passes alone', async () => {
    const dto = await httpConn();
    for (const ref of ['r1', 'r2', 'r3']) await linkedPass(kit, dto.id, ref);
    upstream.status = 401;
    const step = inlineStep();
    const { run: r, conn } = await sync(dto.id, {}, step);
    expect(step.names.filter((s) => s.startsWith('chunk'))).toEqual(['chunk-0']);
    expect(kit.seams.applied).toEqual([]);
    expect(r).toMatchObject({ outcome: 'error', error_code: 'AUTH', http_status: 401 });
    expect(conn?.consecutiveFailures).toBe(1);
  });

  it('applies on_missing to a 404 and leaves the others', async () => {
    const dto = await httpConn({ onMissing: 'void' });
    const p = await linkedPass(kit, dto.id, 'gone');
    upstream.status = 404;
    await sync(dto.id);
    expect(kit.seams.missing).toEqual([{ passId: p.id, mode: 'void' }]);
  });

  it('never fetches private or unsafe hosts, even if the stored config was tampered with', async () => {
    const dto = await httpConn();
    await linkedPass(kit, dto.id, 'r1');
    await run(kit.env.DB, 'UPDATE connections SET config = ? WHERE id = ?', [
      JSON.stringify({ baseUrl: 'https://127.0.0.1/v1', recordPath: '/{ref}' }),
      dto.id,
    ]);
    const { run: r } = await sync(dto.id);
    expect(upstream.calls).toEqual([]);
    expect(r).toMatchObject({ outcome: 'error', error_code: 'CONFIG' });
    expect(kit.seams.applied).toEqual([]);
  });

  it('does not fetch when DNS resolves to a private address', async () => {
    const dto = await httpConn();
    await linkedPass(kit, dto.id, 'r1');
    setDeps({ resolver: { resolve: async () => ['10.1.2.3'] } });
    const { run: r } = await sync(dto.id);
    expect(upstream.calls).toEqual([]);
    expect(r?.error_code).toBe('CONFIG');
  });

  it('counts a malformed payload as a record error, not a connection failure', async () => {
    const dto = await httpConn();
    await linkedPass(kit, dto.id, 'r1');
    upstream.body = [1, 2, 3];
    const { run: r, conn } = await sync(dto.id);
    expect(r).toMatchObject({ error_code: 'RECORD_ERRORS' });
    expect(conn).toMatchObject({ consecutiveFailures: 0, health: 'degraded' });
  });

  it('fails the run with CONFIG when the stored secret no longer matches the schema', async () => {
    const dto = await httpConn({
      secrets: undefined,
      config: { baseUrl: 'https://api.example.com', auth: { type: 'bearer' } },
    });
    await linkedPass(kit, dto.id, 'r1');
    const { run: r } = await sync(dto.id);
    expect(r).toMatchObject({ outcome: 'error', error_code: 'CONFIG' });
    expect(upstream.calls).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it('never touches passes of another org that share a ref', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const mine = await linkedPass(kit, dto.id, 'm-001');
    const { makeOrg } = await import('../../../../test/helpers/index.ts');
    const other = await makeOrg(kit);
    const theirs = await linkedPass(kit, dto.id, 'm-001', other.id);
    await sync(dto.id);
    expect(kit.seams.applied.map((a) => a.passId)).toEqual([mine.id]);
    expect((await passRow(theirs.id))?.last_synced_at).toBeNull();
  });
});

describe('run history', () => {
  it('lists runs newest first', async () => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    await sync(dto.id);
    kit.clock.advance(1000);
    await sync(dto.id);
    const runs = await listRuns(kit.env.DB, dto.id, { limit: 10 });
    expect(runs).toHaveLength(2);
    expect(runs[0]?.startedAt).toBeGreaterThan(runs[1]?.startedAt ?? 0);
    expect(runs[0]?.durationMs).toBe(0);
  });
});

describe('workflow writes stay inside steps', () => {
  const params = (connectionId: string, generation: number): SyncRunParams => ({
    connectionId,
    orgId: kit.org.id,
    generation,
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    trigger: 'schedule',
    runId: `inst-guard-${connectionId.slice(-6)}`,
    instanceId: `inst-guard-${connectionId.slice(-6)}`,
  });

  it.each([
    'missing job keyset',
    'wrong job keyset',
    'run id mismatch',
    'missing tracking',
    'missing cached keyset',
    'wrong cached keyset',
    'missing cached mode',
    'invalid cached result',
  ] as const)('rejects %s before workflow effects', async (scenario) => {
    const dto = await createDemo(kit, { config: { count: 1 } });
    const pass = await linkedPass(kit, dto.id, 'm-001');
    const p = params(dto.id, 1);
    if (scenario !== 'missing tracking') await seedConnectionWorkflow(kit.sctx, p);
    const other =
      kit.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const before = {
      pass: await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]),
      connection: await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [dto.id]),
      run: await first(kit.env.DB, 'SELECT * FROM connection_runs WHERE id = ?', [p.runId]),
      workflow: await first(kit.env.DB, 'SELECT * FROM workflow_runs WHERE instance_id = ?', [
        p.instanceId,
      ]),
      outbox: await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
        kit.org.id,
      ]),
    };
    const cached = {
      ok: true,
      useList: true,
      cursor: null,
      release: null,
      startedAt: kit.clock.now(),
      mode: scenario === 'missing cached mode' ? undefined : 'poll',
      credentialKeysetCommitment:
        scenario === 'missing cached keyset'
          ? undefined
          : scenario === 'wrong cached keyset'
            ? other
            : kit.credentialKeysetCommitment,
    };
    const inner = inlineStep();
    const step: StepLike = {
      sleep: inner.sleep,
      do: async <T>(name: string, fn: () => Promise<T>) =>
        name === 'start'
          ? ((scenario === 'invalid cached result' ? null : cached) as T)
          : inner.do(name, fn),
    };
    const attempted = {
      ...p,
      ...(scenario === 'missing job keyset' ? { credentialKeysetCommitment: undefined } : {}),
      ...(scenario === 'wrong job keyset' ? { credentialKeysetCommitment: other } : {}),
      ...(scenario === 'run id mismatch' ? { runId: `${p.runId}-other` } : {}),
    };
    await expect(executeSync(kit.sctx, step, attempted as never)).rejects.toMatchObject({
      code:
        scenario === 'missing cached mode' || scenario === 'invalid cached result'
          ? 'STALE_CONTEXT'
          : 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    expect(kit.seams.applied).toEqual([]);
    expect(kit.seams.created).toEqual([]);
    expect({
      pass: await first(kit.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]),
      connection: await first(kit.env.DB, 'SELECT * FROM connections WHERE id = ?', [dto.id]),
      run: await first(kit.env.DB, 'SELECT * FROM connection_runs WHERE id = ?', [p.runId]),
      workflow: await first(kit.env.DB, 'SELECT * FROM workflow_runs WHERE instance_id = ?', [
        p.instanceId,
      ]),
      outbox: await all(kit.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
        kit.org.id,
      ]),
    }).toEqual(before);
  });

  it('fails closed when a removed connection loses its tracked run', async () => {
    const dto = await createDemo(kit);
    const p = params(dto.id, 1);
    await seedConnectionWorkflow(kit.sctx, p);
    await service.remove(kit.sctx, kit.actor, dto.id);
    const guard = guardWrites(kit.env);
    const step = guard.step(inlineStep());
    await expect(executeSync({ ...kit.sctx, env: guard.env }, step, p)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    expect(guard.violations).toEqual([]);
    expect(
      (
        await first<{ status: string }>(
          kit.env.DB,
          'SELECT status FROM workflow_runs WHERE instance_id = ?',
          [p.instanceId],
        )
      )?.status,
    ).toBe('queued');
  });

  it('records a replayed gone result in the mark-gone step', async () => {
    const dto = await createDemo(kit);
    const p = params(dto.id, 1);
    await seedConnectionWorkflow(kit.sctx, p);
    const guard = guardWrites(kit.env);
    const inner = inlineStep();
    const gone: StepLike = {
      ...inner,
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> =>
        name === 'start'
          ? ({
              ok: false,
              reason: 'GONE',
              startedAt: kit.clock.now(),
              credentialKeysetCommitment: p.credentialKeysetCommitment,
            } as T)
          : inner.do(name, fn),
    };
    await executeSync({ ...kit.sctx, env: guard.env }, guard.step(gone), p);
    expect(guard.violations).toEqual([]);
    expect(
      (
        await first<{ status: string }>(
          kit.env.DB,
          'SELECT status FROM workflow_runs WHERE instance_id = ?',
          [p.instanceId],
        )
      )?.status,
    ).toBe('complete');
  });

  it('records an aborted run in the abort-record step', async () => {
    const dto = await createDemo(kit);
    const guard = guardWrites(kit.env);
    const inner = inlineStep();
    const flaky: StepLike = {
      ...inner,
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        if (name === 'limits') throw new Error('boom');
        return inner.do(name, fn);
      },
    };
    const step = guard.step(flaky);
    const p = params(dto.id, (await getConnection(kit.env.DB, dto.id))?.generation ?? 1);
    await seedConnectionWorkflow(kit.sctx, p);
    await expect(executeSync({ ...kit.sctx, env: guard.env }, step, p)).rejects.toThrow('boom');
    expect(guard.violations).toEqual([]);
    expect(
      (
        await first<{ status: string }>(
          kit.env.DB,
          'SELECT status FROM workflow_runs WHERE instance_id = ?',
          [p.instanceId],
        )
      )?.status,
    ).toBe('errored');
  });
});
