import { beforeAll, describe, expect, it } from 'vitest';
import {
  makePass,
  makeTemplate,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';

import { validateInput } from '../../../passkit/build.ts';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import type { JobOf } from '../../jobs/types.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { createPassFromConnection } from '../passes/connection-passes-create.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { type Kit as PassKit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getDeps, resetDeps, setDeps } from './deps.ts';
import { handlePassRefresh } from './jobs.ts';
import { getConnection } from './repo.ts';
import { getPassById } from './repo-passes.ts';
import { prepare } from './runtime.ts';
import { inlineStep, seedConnectionWorkflow, startPendingTransfer } from './runtime-fixtures.ts';
import * as service from './service.ts';
import { applyChanges } from './sync-apply.ts';
import { executeSync } from './sync-runner.ts';
import { publicResolver } from './test-kit.ts';
import { processWebhook } from './webhook-process.ts';
import { loadRetainedWebhook } from './webhook-retention.ts';
import { finishRetainedWebhookItem, startRetainedWebhookItem } from './webhook-retention-items.ts';
import { receiveWebhook } from './webhooks.ts';

async function setupConnectionKit(approvedReleases = true) {
  const local = approvedReleases ? await setupKit() : await setupKit({ approvedReleases: false });
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(local.env.DB, local.env);
  const ctx = createJobContext(local.env, 'connection-test', {
    clock: local.clock,
    log: local.ctx.log,
  });
  // The credential rows reference their creator, so the actor the tests use must exist.
  await makeUser(local.fx, { id: 'admin-1' });
  return { ...local, ctx, credentialKeysetCommitment };
}
/** sync -> records.applyIncoming -> real passes seams -> publishPass -> outbox, nothing faked. */
let kit: PassKit & { credentialKeysetCommitment: string };
beforeAll(async () => {
  kit = await setupConnectionKit();
  resetDeps();
  setDeps({ sleep: async () => {}, resolver: publicResolver });
}, 60_000);

let n = 0;
async function sync(connectionId: string, generation: number) {
  const id = `int-${++n}`;
  const params = {
    connectionId,
    orgId: kit.org.id,
    generation,
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    trigger: 'schedule' as const,
    runId: id,
    instanceId: id,
  };
  await seedConnectionWorkflow(kit.ctx, params);
  await executeSync(kit.ctx, inlineStep(), params);
  return id;
}

async function stageVerified(
  local: PassKit,
  connectionId: string,
  secret: string,
  eventId: string,
  ref: string,
  refsOnly = false,
) {
  const body = JSON.stringify(
    refsOnly
      ? { id: eventId, refs: [ref] }
      : {
          id: eventId,
          records: [{ ref, record: { memberName: 'New member', email: 'holder@example.test' } }],
        },
  );
  const timestamp = Math.floor(local.clock.now() / 1000);
  await receiveWebhook(
    local.ctx,
    connectionId,
    new Request('https://wallet.test/hooks/connections/x', {
      method: 'POST',
      body,
      headers: {
        'x-wallet-timestamp': String(timestamp),
        'x-wallet-signature': await signWebhook(secret, timestamp, body),
      },
    }),
  );
  const job = local.queue.sent.find(
    (item): item is JobOf<'connection.webhook'> =>
      typeof item === 'object' &&
      item !== null &&
      'kind' in item &&
      item.kind === 'connection.webhook',
  );
  if (!job) throw new Error('Missing retained webhook job');
  return job;
}

describe('connection sync through the real pass seams', () => {
  it('creates passes, bumps versions with cause connection, queues pushes, and is idempotent', async () => {
    const actor = { type: 'user', id: 'admin-1' } as const;
    const dto = await service.create(kit.ctx, actor, {
      orgId: kit.org.id,
      connectorType: 'demo',
      name: 'Demo',
      config: { count: 2 },
      mode: 'poll',
      mapping: { memberName: { from: '/memberName' } },
      autoCreate: true,
      defaultTemplateId: kit.template.id,
    } as never);

    const created = await sync(dto.id, 1);
    await kit.settle();
    const rows = await all<{ id: string; version: number; external_ref: string }>(
      kit.env.DB,
      'SELECT id, version, external_ref FROM passes WHERE connection_id = ? ORDER BY external_ref',
      [dto.id],
    );
    expect(rows.map((r) => r.external_ref)).toEqual(['m-001', 'm-002']);
    expect(await runOf(created)).toEqual({ passes_changed: 2, outcome: 'changed' });

    // Editing the mapping and config bumps the generation and restarts the listing.
    await service.update(kit.ctx, actor, dto.id, {
      mapping: { memberName: { from: '/memberName', transform: { kind: 'upper' } } },
      config: { count: 2, revision: 1 },
    });
    const updated = await sync(dto.id, 2);
    await kit.settle();
    for (const row of rows) {
      const now = await first<{ version: number; personalization: string }>(
        kit.env.DB,
        'SELECT version, personalization FROM passes WHERE id = ?',
        [row.id],
      );
      expect(now?.version).toBe(row.version + 1);
      expect(JSON.parse(now?.personalization ?? '{}').memberName).toBe(
        `MEMBER ${row.external_ref.toUpperCase()}`,
      );
      const latest = await first<{ cause: string }>(
        kit.env.DB,
        'SELECT cause FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
        [row.id],
      );
      expect(latest?.cause).toBe('connection');
      const pushes = await all(
        kit.env.DB,
        "SELECT 1 FROM outbox WHERE pass_id = ? AND kind = 'push'",
        [row.id],
      );
      expect(pushes.length).toBeGreaterThanOrEqual(1);
    }
    expect(await runOf(updated)).toEqual({ passes_changed: 2, outcome: 'changed' });

    // Same upstream data: no further versions.
    const again = await sync(dto.id, 2);
    expect(await runOf(again)).toEqual({ passes_changed: 0, outcome: 'unchanged' });
    const after = await all<{ version: number }>(
      kit.env.DB,
      'SELECT version FROM passes WHERE connection_id = ? ORDER BY external_ref',
      [dto.id],
    );
    expect(after.map((r) => r.version)).toEqual(rows.map((r) => r.version + 1));
  });

  it.each(['poll', 'webhook'] as const)(
    'fences %s creation if connection mode changes at the real pass INSERT',
    async (path) => {
      const local = await setupConnectionKit();
      const db = local.env.DB;
      const requests: string[] = [];
      const originalMode = path === 'poll' ? 'poll' : 'hybrid';
      const changedMode = path === 'poll' ? 'hybrid' : 'webhook';
      resetDeps();
      setDeps({
        sleep: async () => {},
        resolver: publicResolver,
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          const member = { memberName: 'Fetched member', email: 'holder@example.com' };
          const body =
            path === 'poll' ? { items: [{ id: 'race-ref', ...member }], cursor: null } : member;
          return new Response(JSON.stringify(body), { status: 200 });
        }) as typeof fetch,
      });
      try {
        const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
          orgId: local.org.id,
          connectorType: 'http-json',
          name: `Mode-fenced ${path} source`,
          config: {
            baseUrl: 'https://api.example.com',
            recordPath: '/members/{ref}',
            ...(path === 'poll' ? { list: { path: '/members' } } : {}),
          },
          mode: originalMode,
          mapping: { memberName: { from: '/memberName' } },
          holderEmailField: '/email',
          autoCreate: true,
          autoEmail: true,
          defaultTemplateId: local.template.id,
        } as never);
        let webhook: JobOf<'connection.webhook'> | undefined;
        if (path === 'webhook') {
          if (!dto.webhookSecret) throw new Error('Missing webhook secret');
          const body = JSON.stringify({ id: 'mode-insert-event', refs: ['race-ref'] });
          const timestamp = Math.floor(local.clock.now() / 1000);
          await receiveWebhook(
            local.ctx,
            dto.id,
            new Request('https://wallet.test/hooks/connections/test', {
              method: 'POST',
              body,
              headers: {
                'x-wallet-timestamp': String(timestamp),
                'x-wallet-signature': await signWebhook(dto.webhookSecret, timestamp, body),
              },
            }),
          );
          webhook = (local.queue.sent as JobOf<'connection.webhook'>[]).find(
            (job) => job.kind === 'connection.webhook' && job.connectionId === dto.id,
          );
          if (!webhook) throw new Error('Missing staged webhook job');
        }
        const beforeOutbox = await all(db, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
          local.org.id,
        ]);
        const beforeEvents = await all(
          db,
          'SELECT * FROM pass_events WHERE org_id = ? ORDER BY id',
          [local.org.id],
        );
        const beforeAudit = await all(
          db,
          "SELECT * FROM audit_log WHERE org_id = ? AND target_type = 'pass' ORDER BY id",
          [local.org.id],
        );
        const beforeObjects = (await local.env.BUCKET.list({ prefix: 'passes/' })).objects
          .map((object) => object.key)
          .sort();
        const beforeQueue = [...local.queue.sent];
        const beforeEmails = local.mailer.sent.length;
        let inserts = 0;
        let fetchedAtInsert = 0;
        // The pass INSERT commits inside a batch; flip the mode just before the batch that holds it.
        const sqlOf = new WeakMap<D1PreparedStatement, string>();
        const proxy = new Proxy(db, {
          get(target, property) {
            if (property === 'prepare')
              return (sql: string) => {
                const statement = target.prepare(sql);
                sqlOf.set(statement, sql);
                const bind = statement.bind.bind(statement);
                statement.bind = (...values: unknown[]) => {
                  const bound = bind(...values);
                  sqlOf.set(bound, sql);
                  return bound;
                };
                return statement;
              };
            if (property === 'batch')
              return async (batch: D1PreparedStatement[]) => {
                if (batch.some((st) => /^\s*INSERT\s+INTO\s+passes\b/i.test(sqlOf.get(st) ?? ''))) {
                  inserts += 1;
                  fetchedAtInsert = requests.length;
                  await run(db, 'UPDATE connections SET mode = ? WHERE id = ?', [
                    changedMode,
                    dto.id,
                  ]);
                }
                return target.batch(batch);
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        Object.assign(local.env, { DB: proxy });

        if (path === 'poll') {
          const params = {
            connectionId: dto.id,
            orgId: local.org.id,
            generation: 1,
            trigger: 'schedule' as const,
            credentialKeysetCommitment: local.credentialKeysetCommitment,
            runId: 'mode-insert-poll',
            instanceId: 'mode-insert-poll',
          };
          await seedConnectionWorkflow(local.ctx, params);
          await executeSync(local.ctx, inlineStep(), params);
        } else {
          if (!webhook) throw new Error('Missing webhook job');
          await expect(processWebhook(local.ctx, webhook)).resolves.toBeUndefined();
        }
        await local.settle();
        expect(requests).toEqual([
          path === 'poll'
            ? 'https://api.example.com/members'
            : 'https://api.example.com/members/race-ref',
        ]);
        expect(inserts).toBe(1);
        expect(fetchedAtInsert).toBe(1);
        expect(
          await first(db, 'SELECT mode, generation, cursor FROM connections WHERE id = ?', [
            dto.id,
          ]),
        ).toEqual({ mode: changedMode, generation: 2, cursor: null });
        expect(await all(db, 'SELECT id FROM passes WHERE connection_id = ?', [dto.id])).toEqual(
          [],
        );
        expect(
          await all(db, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [local.org.id]),
        ).toEqual(beforeOutbox);
        expect(
          await all(db, 'SELECT * FROM pass_events WHERE org_id = ? ORDER BY id', [local.org.id]),
        ).toEqual(beforeEvents);
        expect(
          await all(
            db,
            "SELECT * FROM audit_log WHERE org_id = ? AND target_type = 'pass' ORDER BY id",
            [local.org.id],
          ),
        ).toEqual(beforeAudit);
        expect(
          (await local.env.BUCKET.list({ prefix: 'passes/' })).objects
            .map((object) => object.key)
            .sort(),
        ).toEqual(beforeObjects);
        expect(local.queue.sent).toEqual(beforeQueue);
        expect(local.mailer.sent).toHaveLength(beforeEmails);
        if (path === 'poll') {
          expect(
            await first(db, 'SELECT outcome, error_code FROM connection_runs WHERE id = ?', [
              'mode-insert-poll',
            ]),
          ).toEqual({ outcome: 'skipped', error_code: 'STALE_CONTEXT' });
        } else {
          expect(
            await first(
              db,
              'SELECT state, error_code FROM connection_webhook_retention WHERE connection_id = ? AND event_id = ?',
              [dto.id, 'mode-insert-event'],
            ),
          ).toEqual({ state: 'ignored', error_code: 'WEBHOOK_STALE_CONTEXT' });
        }
      } finally {
        Object.assign(local.env, { DB: db });
        resetDeps();
        setDeps({ sleep: async () => {}, resolver: publicResolver });
      }
    },
    120_000,
  );

  it('creates against the approved release when the active draft has incompatible inputs', async () => {
    const draft = makeTemplate({ id: kit.template.id, version: 'unapproved-v2' }).resolved;
    draft.manifest.inputs = {
      type: 'object',
      required: ['draftOnly'],
      properties: { draftOnly: { type: 'string' } },
    };
    await persistTemplate(kit.fx, draft);
    await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      draft.version,
      kit.template.id,
    ]);
    expect(() => validateInput(draft, { memberName: 'Member M-001' })).toThrow();

    try {
      const dto = await service.create(kit.ctx, { type: 'user', id: 'admin-1' }, {
        orgId: kit.org.id,
        connectorType: 'demo',
        name: 'Draft differs from release',
        config: { count: 1 },
        mode: 'poll',
        mapping: { memberName: { from: '/memberName' } },
        autoCreate: true,
        defaultTemplateId: kit.template.id,
      } as never);
      const created = await sync(dto.id, 1);
      const passes = await all<{ template_version: string; personalization: string }>(
        kit.env.DB,
        'SELECT template_version, personalization FROM passes WHERE connection_id = ?',
        [dto.id],
      );
      expect(passes).toHaveLength(1);
      expect(passes[0]?.template_version).toBe(kit.template.version);
      expect(JSON.parse(passes[0]?.personalization ?? '{}')).toMatchObject({
        memberName: 'Member M-001',
      });
      expect(await runOf(created)).toEqual({ passes_changed: 1, outcome: 'changed' });
      expect(
        (
          await first<{ cursor: string | null }>(
            kit.env.DB,
            'SELECT cursor FROM connections WHERE id = ?',
            [dto.id],
          )
        )?.cursor,
      ).toBe('0:1');
    } finally {
      await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        kit.template.version,
        kit.template.id,
      ]);
    }
  });

  it('retains a blocked cursor until a real Apple release is approved, then resumes', async () => {
    const unreleased = await setupConnectionKit(false);
    const dto = await service.create(unreleased.ctx, { type: 'user', id: 'admin-1' }, {
      orgId: unreleased.org.id,
      connectorType: 'demo',
      name: 'Awaiting approval',
      config: { count: 1 },
      mode: 'poll',
      mapping: { memberName: { from: '/memberName' } },
      autoCreate: true,
      defaultTemplateId: unreleased.template.id,
    } as never);
    const params = {
      connectionId: dto.id,
      orgId: unreleased.org.id,
      generation: 1,
      credentialKeysetCommitment: unreleased.credentialKeysetCommitment,
      trigger: 'schedule' as const,
    };
    await seedConnectionWorkflow(unreleased.ctx, {
      ...params,
      runId: 'approval-blocked',
      instanceId: 'approval-blocked',
    });

    await executeSync(unreleased.ctx, inlineStep(), {
      ...params,
      runId: 'approval-blocked',
      instanceId: 'approval-blocked',
    });
    expect(
      await first(
        unreleased.env.DB,
        'SELECT outcome, error_code FROM connection_runs WHERE id = ?',
        ['approval-blocked'],
      ),
    ).toEqual({ outcome: 'error', error_code: 'TEMPLATE_RELEASE_REQUIRED' });
    expect(
      await first(unreleased.env.DB, 'SELECT cursor, next_run_at FROM connections WHERE id = ?', [
        dto.id,
      ]),
    ).toEqual({ cursor: null, next_run_at: unreleased.clock.now() + 60_000 });
    expect(
      await all(unreleased.env.DB, 'SELECT id FROM passes WHERE connection_id = ?', [dto.id]),
    ).toEqual([]);

    await approveAppleRelease(unreleased);
    unreleased.clock.advance(60_000);
    await seedConnectionWorkflow(unreleased.ctx, {
      ...params,
      runId: 'approval-resumed',
      instanceId: 'approval-resumed',
    });
    await executeSync(unreleased.ctx, inlineStep(), {
      ...params,
      runId: 'approval-resumed',
      instanceId: 'approval-resumed',
    });
    await unreleased.settle();
    expect(
      await first(
        unreleased.env.DB,
        'SELECT outcome, error_code FROM connection_runs WHERE id = ?',
        ['approval-resumed'],
      ),
    ).toEqual({ outcome: 'changed', error_code: null });
    expect(
      await first(
        unreleased.env.DB,
        'SELECT template_version FROM passes WHERE connection_id = ?',
        [dto.id],
      ),
    ).toEqual({ template_version: unreleased.template.version });
    expect(
      (
        await first<{ cursor: string | null }>(
          unreleased.env.DB,
          'SELECT cursor FROM connections WHERE id = ?',
          [dto.id],
        )
      )?.cursor,
    ).toBe('0:1');
  }, 120_000);

  it.each(['missing', 'mismatched'] as const)(
    'rejects %s keyset proof for an already verified webhook',
    async (scenario) => {
      const local = await setupConnectionKit();
      const release = local.liveRelease;
      if (!release) throw new Error('Missing approved release');
      resetDeps();
      const requests: string[] = [];
      setDeps({
        sleep: async () => {},
        resolver: publicResolver,
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Should not apply' }));
        }) as typeof fetch,
      });
      try {
        const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
          orgId: local.org.id,
          connectorType: 'http-json',
          name: 'Webhook proof',
          config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
          mode: 'hybrid',
          mapping: { memberName: { from: '/memberName' } },
          autoCreate: true,
          defaultTemplateId: local.template.id,
        } as never);
        const pass = await createPassFromConnection(local.ctx, {
          orgId: local.org.id,
          credentialKeysetCommitment: local.credentialKeysetCommitment,
          mode: 'live',
          templateId: local.template.id,
          expectedRelease: {
            id: release.id,
            generation: release.generation,
            version: release.version,
          },
          connectionId: dto.id,
          generation: 1,
          externalRef: 'm-001',
          expectedConnectionMode: 'hybrid',
          fields: { memberName: 'Original' },
          sendEmail: false,
        });
        await local.settle();
        const job = await stageVerified(
          local,
          dto.id,
          dto.webhookSecret as string,
          `keyset-${scenario}`,
          'm-001',
          true,
        );
        const state = async () => ({
          pass: await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.passId]),
          versions: await all(
            local.env.DB,
            'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
            [pass.passId],
          ),
          outbox: await all(local.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
            local.org.id,
          ]),
          runs: await all(
            local.env.DB,
            'SELECT * FROM connection_runs WHERE connection_id = ? ORDER BY id',
            [dto.id],
          ),
          retention: await all(
            local.env.DB,
            'SELECT * FROM connection_webhook_retention WHERE connection_id = ?',
            [dto.id],
          ),
          items: await all(
            local.env.DB,
            `SELECT i.* FROM connection_webhook_items i
            JOIN connection_webhook_retention r ON r.id = i.retention_id WHERE r.connection_id = ? ORDER BY i.ordinal`,
            [dto.id],
          ),
        });
        const before = await state();
        const wrong =
          local.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
        await expect(
          processWebhook(local.ctx, {
            ...job,
            credentialKeysetCommitment: scenario === 'missing' ? undefined : wrong,
          }),
        ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
        expect(requests).toEqual([]);
        expect(await state()).toEqual(before);
      } finally {
        resetDeps();
        setDeps({ sleep: async () => {}, resolver: publicResolver });
      }
    },
    120_000,
  );

  it.each([
    'missing identity',
    'missing epoch',
    'missing keyset',
    'mismatched keyset',
    'missing mode',
    'mismatched mode',
  ] as const)(
    'rejects a refresh job with %s before fetching or publishing',
    async (scenario) => {
      const local = await setupConnectionKit();
      const release = local.liveRelease;
      if (!release) throw new Error('Missing approved release');
      resetDeps();
      const requests: string[] = [];
      setDeps({
        sleep: async () => {},
        resolver: publicResolver,
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Should not apply' }));
        }) as typeof fetch,
      });
      try {
        const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
          orgId: local.org.id,
          connectorType: 'http-json',
          name: 'Refresh proof',
          config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
          mode: 'manual',
          mapping: { memberName: { from: '/memberName' } },
          autoCreate: true,
          defaultTemplateId: local.template.id,
        } as never);
        const created = await createPassFromConnection(local.ctx, {
          orgId: local.org.id,
          credentialKeysetCommitment: local.credentialKeysetCommitment,
          mode: 'live',
          templateId: local.template.id,
          expectedRelease: {
            id: release.id,
            generation: release.generation,
            version: release.version,
          },
          connectionId: dto.id,
          generation: 1,
          externalRef: 'm-001',
          expectedConnectionMode: 'manual',
          fields: { memberName: 'Original' },
          sendEmail: false,
        });
        await local.settle();
        const pass = await getPassById(local.env.DB, created.passId);
        if (!pass) throw new Error('Missing bound pass');
        const job: JobOf<'pass.refresh'> = {
          kind: 'pass.refresh',
          passId: pass.id,
          orgId: pass.orgId,
          identityId: pass.identityId,
          mode: 'live',
          status: 'active',
          passVersion: pass.version,
          templateId: pass.templateId,
          templateVersion: pass.templateVersion,
          releaseId: pass.releaseId,
          ownerUserId: pass.ownerUserId,
          linkGeneration: pass.linkGeneration,
          credentialGeneration: pass.credentialGeneration,
          lifecycleGeneration: pass.lifecycleGeneration,
          credentialKeysetCommitment: pass.credentialKeysetCommitment,
          connectionId: dto.id,
          connectionMode: 'manual',
          externalRef: 'm-001',
          generation: 1,
          trigger: 'user',
          actorId: 'u1',
        };
        const state = async () => ({
          pass: await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]),
          versions: await all(
            local.env.DB,
            'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
            [pass.id],
          ),
          outbox: await all(local.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
            local.org.id,
          ]),
          runs: await all(
            local.env.DB,
            'SELECT * FROM connection_runs WHERE connection_id = ? ORDER BY id',
            [dto.id],
          ),
        });
        const before = await state();
        const wrong =
          local.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
        const attempted = {
          ...job,
          ...(scenario === 'missing identity' ? { identityId: undefined } : {}),
          ...(scenario === 'missing epoch' ? { lifecycleGeneration: undefined } : {}),
          ...(scenario === 'missing keyset' ? { credentialKeysetCommitment: undefined } : {}),
          ...(scenario === 'mismatched keyset' ? { credentialKeysetCommitment: wrong } : {}),
          ...(scenario === 'missing mode' ? { connectionMode: undefined } : {}),
          ...(scenario === 'mismatched mode' ? { connectionMode: 'hybrid' } : {}),
        } as JobOf<'pass.refresh'>;
        await handlePassRefresh(attempted, local.ctx);
        expect(requests).toEqual([]);
        expect(await state()).toEqual(before);
      } finally {
        resetDeps();
        setDeps({ sleep: async () => {}, resolver: publicResolver });
      }
    },
    120_000,
  );

  it.each(['stable', 'release drift'] as const)(
    'records exactly one real publish push and fences completion on %s',
    async (race) => {
      const local = await setupConnectionKit();
      const release = local.liveRelease;
      if (!release) throw new Error('Missing approved release');
      resetDeps();
      setDeps({ sleep: async () => {}, resolver: publicResolver });
      let trigger: string | undefined;
      try {
        const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
          orgId: local.org.id,
          connectorType: 'http-json',
          name: 'Refresh publish push',
          config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
          mode: 'manual',
          mapping: { memberName: { from: '/memberName' } },
          autoCreate: true,
          defaultTemplateId: local.template.id,
        } as never);
        const created = await createPassFromConnection(local.ctx, {
          orgId: local.org.id,
          mode: 'live',
          templateId: local.template.id,
          credentialKeysetCommitment: local.credentialKeysetCommitment,
          expectedRelease: {
            id: release.id,
            generation: release.generation,
            version: release.version,
          },
          connectionId: dto.id,
          generation: 1,
          externalRef: 'm-001',
          expectedConnectionMode: 'manual',
          fields: { memberName: 'Original' },
          sendEmail: false,
        });
        await local.settle();
        const pass = await getPassById(local.env.DB, created.passId);
        if (!pass) throw new Error('Missing bound pass');
        const job: JobOf<'pass.refresh'> = {
          kind: 'pass.refresh',
          passId: pass.id,
          orgId: pass.orgId,
          identityId: pass.identityId,
          mode: 'live',
          status: 'active',
          passVersion: pass.version,
          templateId: pass.templateId,
          templateVersion: pass.templateVersion,
          releaseId: pass.releaseId,
          ownerUserId: pass.ownerUserId,
          linkGeneration: pass.linkGeneration,
          credentialGeneration: pass.credentialGeneration,
          lifecycleGeneration: pass.lifecycleGeneration,
          credentialKeysetCommitment: pass.credentialKeysetCommitment,
          connectionId: dto.id,
          connectionMode: 'manual',
          externalRef: 'm-001',
          generation: 1,
          trigger: 'user',
          actorId: 'u1',
        };
        await run(
          local.env.DB,
          "UPDATE outbox SET state = 'sent' WHERE pass_id = ? AND kind = 'push'",
          [pass.id],
        );
        const before = await all<{ id: string }>(
          local.env.DB,
          "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'",
          [pass.id],
        );
        if (race === 'release drift') {
          trigger = `release_race_${local.ctx.ids.id().replaceAll('-', '')}`;
          await run(
            local.env.DB,
            `CREATE TRIGGER ${trigger} AFTER UPDATE OF last_synced_at ON passes
            BEGIN UPDATE passes SET release_id = NULL WHERE id = NEW.id; END`,
          );
        }
        const enqueue = getDeps().enqueueRefreshPush;
        let catchUps = 0;
        setDeps({
          fetchImpl: (async () =>
            new Response(JSON.stringify({ memberName: 'Changed upstream' }), {
              status: 200,
            })) as typeof fetch,
          enqueueRefreshPush: async (ctx, snapshot) => {
            catchUps += 1;
            return enqueue(ctx, snapshot);
          },
        });
        await handlePassRefresh(job, local.ctx);
        await local.settle();
        const after = await first<{
          version: number;
          release_id: string | null;
          last_synced_at: number | null;
          last_refreshed_at: number | null;
        }>(
          local.env.DB,
          'SELECT version, release_id, last_synced_at, last_refreshed_at FROM passes WHERE id = ?',
          [pass.id],
        );
        expect(after).toEqual({
          version: pass.version + 1,
          release_id: race === 'stable' ? pass.releaseId : null,
          last_synced_at: local.clock.now(),
          last_refreshed_at: race === 'stable' ? local.clock.now() : null,
        });
        expect(catchUps).toBe(0);
        expect(
          await all(local.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'push'", [
            pass.id,
          ]),
        ).toHaveLength(before.length + 1);
      } finally {
        if (trigger) await run(local.env.DB, `DROP TRIGGER ${trigger}`);
        resetDeps();
        setDeps({ sleep: async () => {}, resolver: publicResolver });
      }
    },
    120_000,
  );

  it.each([
    ['completed credential transfer', 'changed'],
    ['lifecycle generation', 'changed'],
    ['pending transfer', 'changed'],
    ['release binding', 'changed'],
    ['completed credential transfer', 'invalid email'],
    ['lifecycle generation', 'invalid email'],
    ['pending transfer', 'invalid email'],
    ['release binding', 'invalid email'],
  ] as const)(
    'does not mutate or enqueue after %s during fetch (%s)',
    async (race, payload) => {
      const local = await setupConnectionKit();
      const release = local.liveRelease;
      if (!release) throw new Error('Missing approved release');
      resetDeps();
      setDeps({ sleep: async () => {}, resolver: publicResolver });
      try {
        const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
          orgId: local.org.id,
          connectorType: 'http-json',
          name: 'Refresh epoch race',
          config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
          mode: 'manual',
          mapping: { memberName: { from: '/memberName' } },
          holderEmailField: '/email',
          autoCreate: true,
          defaultTemplateId: local.template.id,
        } as never);
        const created = await createPassFromConnection(local.ctx, {
          orgId: local.org.id,
          credentialKeysetCommitment: local.credentialKeysetCommitment,
          mode: 'live',
          templateId: local.template.id,
          expectedRelease: {
            id: release.id,
            generation: release.generation,
            version: release.version,
          },
          connectionId: dto.id,
          expectedConnectionMode: 'manual',
          generation: 1,
          externalRef: 'm-001',
          fields: { memberName: 'Original' },
          sendEmail: false,
        });
        await local.settle();
        const pass = await getPassById(local.env.DB, created.passId);
        if (!pass) throw new Error('Missing bound pass');
        const job: JobOf<'pass.refresh'> = {
          kind: 'pass.refresh',
          passId: pass.id,
          orgId: pass.orgId,
          identityId: pass.identityId,
          mode: 'live',
          status: 'active',
          passVersion: pass.version,
          templateId: pass.templateId,
          templateVersion: pass.templateVersion,
          releaseId: pass.releaseId,
          ownerUserId: pass.ownerUserId,
          linkGeneration: pass.linkGeneration,
          credentialGeneration: pass.credentialGeneration,
          lifecycleGeneration: pass.lifecycleGeneration,
          credentialKeysetCommitment: pass.credentialKeysetCommitment,
          connectionId: dto.id,
          externalRef: 'm-001',
          generation: 1,
          connectionMode: 'manual',
          trigger: 'user',
          actorId: 'u1',
        };
        const state = async () => ({
          pass: await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.id]),
          versions: await all(
            local.env.DB,
            'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
            [pass.id],
          ),
          outbox: await all(local.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
            pass.id,
          ]),
        });
        let afterRace: unknown;
        let fetches = 0;
        setDeps({
          fetchImpl: (async () => {
            fetches += 1;
            if (race === 'completed credential transfer') {
              const holder = await getHolderPass(local.env.DB, pass.id, null);
              if (!holder) throw new Error('Missing holder');
              await startCredentialTransfer(
                jobCtxOf(local),
                { type: 'system', id: null },
                pass.id,
                { holderEmail: 'next@example.test', ownerUserId: null },
                null,
                { kind: 'tenant-holder', expected: holder },
              );
              await local.settle();
            } else if (race === 'pending transfer') {
              await startPendingTransfer(local.ctx, pass.id);
            } else if (race === 'release binding') {
              await run(local.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [
                pass.id,
              ]);
            } else {
              await run(
                local.env.DB,
                'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
                [pass.id],
              );
            }
            const current = await getPassById(local.env.DB, pass.id);
            if (!current) throw new Error('Missing raced pass');
            if (race === 'completed credential transfer') {
              expect(current.credentialGeneration).toBeGreaterThan(pass.credentialGeneration);
              expect(current.transferPending).toBe(false);
            } else if (race === 'pending transfer') {
              expect(current.transferPending).toBe(true);
            } else if (race === 'release binding') {
              expect(pass.releaseId).not.toBeNull();
              expect(current.releaseId).toBeNull();
            } else {
              expect(current.lifecycleGeneration).toBe(pass.lifecycleGeneration + 1);
            }
            afterRace = await state();
            return new Response(
              JSON.stringify({
                memberName: 'Changed upstream',
                email: payload === 'invalid email' ? 'invalid-email' : null,
              }),
              { status: 200 },
            );
          }) as typeof fetch,
        });
        await handlePassRefresh(job, local.ctx);
        await local.settle();
        expect(fetches).toBe(1);
        expect(afterRace).toBeDefined();
        expect(await state()).toEqual(afterRace);
      } finally {
        resetDeps();
        setDeps({ sleep: async () => {}, resolver: publicResolver });
      }
    },
    120_000,
  );

  it.each([
    'valid',
    'missing claim',
    'wrong token',
    'wrong revision',
    'wrong retention id',
    'wrong pass id',
    'wrong keyset',
    'different winner',
  ] as const)(
    'uses the persisted reservation for a new verified item (%s)',
    async (scenario) => {
      const local = await setupConnectionKit();
      const release = local.liveRelease;
      if (!release) throw new Error('Missing approved release');
      resetDeps();
      setDeps({ sleep: async () => {}, resolver: publicResolver });
      try {
        const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
          orgId: local.org.id,
          connectorType: 'webhook-push',
          name: 'Reserved pass',
          config: {},
          mode: 'webhook',
          mapping: { memberName: { from: '/memberName' } },
          holderEmailField: '/email',
          autoCreate: true,
          autoEmail: true,
          defaultTemplateId: local.template.id,
        } as never);
        const job = await stageVerified(
          local,
          dto.id,
          dto.webhookSecret as string,
          `reserved-${scenario}`,
          'new-ref',
        );
        const beforeOutbox = await all(
          local.env.DB,
          'SELECT * FROM outbox WHERE org_id = ? ORDER BY id',
          [local.org.id],
        );
        let reservedId: string | undefined;
        let winningId: string | undefined;
        let winnerBefore: unknown;
        let attempts = 0;
        setDeps({
          createPassFromConnection: async (ctx, input) => {
            attempts += 1;
            const claim = input.retainedClaim;
            if (!input.reservedPassId || !claim) throw new Error('Missing reserved claim');
            reservedId = input.reservedPassId;
            const persisted = await first<{ state: string; claim_pass_id: string | null }>(
              local.env.DB,
              `SELECT i.state, i.claim_pass_id FROM connection_webhook_items i
               JOIN connection_webhook_retention r ON r.id = i.retention_id
               WHERE r.connection_id = ? AND r.event_id = ? AND i.ordinal = 0`,
              [dto.id, job.eventId],
            );
            expect(persisted).toEqual({ state: 'started', claim_pass_id: reservedId });
            expect(claim).toMatchObject({
              ordinal: 0,
              token: expect.any(String),
              refHash: expect.any(String),
              credentialKeysetCommitment: local.credentialKeysetCommitment,
            });
            if (scenario === 'different winner') {
              const winner = await makePass(local.fx, {
                orgId: local.org.id,
                template: local.template,
              });
              winningId = winner.id;
              await run(
                local.env.DB,
                'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?',
                [dto.id, 'new-ref', winner.id],
              );
              winnerBefore = await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [
                winner.id,
              ]);
              return createPassFromConnection(ctx, input);
            }
            if (scenario === 'missing claim') {
              return createPassFromConnection(ctx, { ...input, retainedClaim: undefined } as never);
            }
            if (scenario === 'wrong pass id') {
              return createPassFromConnection(ctx, {
                ...input,
                reservedPassId: `${reservedId}-other`,
              });
            }
            const forged = {
              ...claim,
              ...(scenario === 'wrong token' ? { token: `${claim.token}-other` } : {}),
              ...(scenario === 'wrong revision' ? { revision: claim.revision + 1 } : {}),
              ...(scenario === 'wrong retention id'
                ? { retentionId: `${claim.retentionId}-other` }
                : {}),
              ...(scenario === 'wrong keyset'
                ? {
                    credentialKeysetCommitment:
                      local.credentialKeysetCommitment === '0'.repeat(64)
                        ? '1'.repeat(64)
                        : '0'.repeat(64),
                  }
                : {}),
            };
            return createPassFromConnection(ctx, { ...input, retainedClaim: forged });
          },
        });
        await processWebhook(local.ctx, job);
        await local.settle();
        expect(attempts).toBe(1);
        expect(reservedId).toBeTruthy();
        const item = await first<{ state: string; claim_pass_id: string | null }>(
          local.env.DB,
          `SELECT i.state, i.claim_pass_id FROM connection_webhook_items i
           JOIN connection_webhook_retention r ON r.id = i.retention_id
           WHERE r.connection_id = ? AND r.event_id = ? AND i.ordinal = 0`,
          [dto.id, job.eventId],
        );
        expect(item).toEqual({
          state: scenario === 'valid' ? 'success' : 'uncertain',
          claim_pass_id: reservedId,
        });
        const passes = await all<{ id: string }>(
          local.env.DB,
          'SELECT id FROM passes WHERE connection_id = ?',
          [dto.id],
        );
        if (scenario === 'valid') {
          expect(passes).toEqual([{ id: reservedId }]);
          const after = await all(
            local.env.DB,
            'SELECT * FROM outbox WHERE org_id = ? ORDER BY id',
            [local.org.id],
          );
          await processWebhook(local.ctx, job);
          await local.settle();
          expect(
            await all(local.env.DB, 'SELECT id FROM passes WHERE connection_id = ?', [dto.id]),
          ).toEqual(passes);
          expect(
            await all(local.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
              local.org.id,
            ]),
          ).toEqual(after);
        } else {
          expect(passes).toEqual(winningId ? [{ id: winningId }] : []);
          expect(winningId).not.toBe(reservedId);
          if (winningId)
            expect(
              await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [winningId]),
            ).toEqual(winnerBefore);
          expect(
            await all(local.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
              local.org.id,
            ]),
          ).toEqual(beforeOutbox);
        }
      } finally {
        resetDeps();
        setDeps({ sleep: async () => {}, resolver: publicResolver });
      }
    },
    120_000,
  );

  it.each([
    'version',
    'owner',
    'link',
    'release',
    'unbound',
    'replaced',
    'completed credential transfer',
    'lifecycle generation',
    'pending transfer',
    'already pending',
  ] as const)(
    'atomically binds an existing pass before fetching when %s races the claim',
    async (race) => {
      const local = await setupConnectionKit();
      const release = local.liveRelease;
      if (!release) throw new Error('Missing approved release');
      resetDeps();
      setDeps({ sleep: async () => {}, resolver: publicResolver });
      try {
        const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
          orgId: local.org.id,
          connectorType: 'http-json',
          name: 'Existing claim race',
          config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
          mode: 'hybrid',
          mapping: { memberName: { from: '/memberName' } },
          autoCreate: true,
          defaultTemplateId: local.template.id,
        } as never);
        const createBound = () =>
          createPassFromConnection(local.ctx, {
            orgId: local.org.id,
            credentialKeysetCommitment: local.credentialKeysetCommitment,
            mode: 'live',
            templateId: local.template.id,
            expectedRelease: {
              id: release.id,
              generation: release.generation,
              version: release.version,
            },
            connectionId: dto.id,
            expectedConnectionMode: 'hybrid',
            generation: 1,
            externalRef: 'm-001',
            fields: { memberName: 'Original' },
            sendEmail: false,
          });
        const created = await createBound();
        await local.settle();
        const original = await getPassById(local.env.DB, created.passId);
        if (!original) throw new Error('Missing bound pass');
        const job = await stageVerified(
          local,
          dto.id,
          dto.webhookSecret as string,
          `binding-${race}`,
          'm-001',
          true,
        );
        const retained = await loadRetainedWebhook(local.ctx, job);
        const conn = await getConnection(local.env.DB, dto.id);
        if (!retained || !conn) throw new Error('Missing retained webhook or connection');
        if (race === 'already pending') await startPendingTransfer(local.ctx, original.id);
        const captured = await getPassById(local.env.DB, original.id);
        if (!captured) throw new Error('Missing claim candidate pass');
        const requests: string[] = [];
        setDeps({
          fetchImpl: (async (input: RequestInfo | URL) => {
            requests.push(String(input));
            return new Response(JSON.stringify({ memberName: 'Should not apply' }), {
              status: 200,
            });
          }) as typeof fetch,
        });
        const prep = await prepare(local.ctx, conn);
        const state = async () => ({
          passes: await all(local.env.DB, 'SELECT * FROM passes WHERE org_id = ? ORDER BY id', [
            local.org.id,
          ]),
          versions: await all(
            local.env.DB,
            'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
            [original.id],
          ),
          outbox: await all(local.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
            local.org.id,
          ]),
        });
        let afterRace: unknown;
        let began = 0;
        await applyChanges(
          local.ctx,
          conn,
          prep,
          [{ ref: 'm-001' }],
          {
            kind: 'approved',
            id: release.id,
            generation: release.generation,
            version: release.version,
          },
          {
            begin: async (index, candidate) => {
              began += 1;
              expect(candidate.kind).toBe('existing');
              if (candidate.kind !== 'existing') throw new Error('Missing existing candidate');
              expect(candidate).toMatchObject({
                credentialKeysetCommitment: local.credentialKeysetCommitment,
                templateId: original.templateId,
                releaseId: original.releaseId,
                templateVersion: original.templateVersion,
                snapshot: {
                  passId: original.id,
                  orgId: original.orgId,
                  identityId: original.identityId,
                  mode: 'live',
                  status: 'active',
                  expectedVersion: original.version,
                  expectedRowVersion: captured.rowVersion,
                  ownerUserId: original.ownerUserId,
                  connectionId: dto.id,
                  externalRef: 'm-001',
                  generation: 1,
                  expectedConnectionMode: 'hybrid',
                  linkGeneration: captured.linkGeneration,
                  credentialGeneration: captured.credentialGeneration,
                  credentialKeysetCommitment: captured.credentialKeysetCommitment,
                  lifecycleGeneration: captured.lifecycleGeneration,
                  transferPending: captured.transferPending,
                },
              });
              if (race === 'version')
                await run(local.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [
                  original.id,
                ]);
              if (race === 'owner') {
                const owner = await makeUser(local.fx);
                const holder = await getHolderPass(local.env.DB, original.id, null);
                if (!holder) throw new Error('Missing holder');
                await startCredentialTransfer(
                  jobCtxOf(local),
                  { type: 'system', id: null },
                  original.id,
                  { holderEmail: owner.primaryEmail, ownerUserId: owner.id },
                  null,
                  { kind: 'tenant-holder', expected: holder },
                );
                await local.settle();
              }
              if (race === 'link')
                await run(
                  local.env.DB,
                  'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?',
                  [original.id],
                );
              if (race === 'release')
                await run(local.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [
                  original.id,
                ]);
              if (race === 'unbound' || race === 'replaced') {
                await run(
                  local.env.DB,
                  'UPDATE passes SET connection_id = NULL, external_ref = NULL WHERE id = ?',
                  [original.id],
                );
                if (race === 'replaced') {
                  await createBound();
                  await local.settle();
                }
              }
              if (race === 'completed credential transfer') {
                const holder = await getHolderPass(local.env.DB, original.id, null);
                if (!holder) throw new Error('Missing holder');
                await startCredentialTransfer(
                  jobCtxOf(local),
                  { type: 'system', id: null },
                  original.id,
                  { holderEmail: 'next@example.test', ownerUserId: null },
                  null,
                  { kind: 'tenant-holder', expected: holder },
                );
                await local.settle();
              }
              if (race === 'lifecycle generation') {
                await run(
                  local.env.DB,
                  'UPDATE passes SET lifecycle_generation = lifecycle_generation + 1 WHERE id = ?',
                  [original.id],
                );
              }
              if (race === 'pending transfer') await startPendingTransfer(local.ctx, original.id);
              afterRace = await state();
              const claim = await startRetainedWebhookItem(
                local.ctx,
                job,
                retained.revision,
                index,
                candidate,
              );
              expect(claim).toBeNull();
              return claim;
            },
            finish: (index, token, outcome, code) =>
              finishRetainedWebhookItem(
                local.ctx,
                job,
                retained.revision,
                index,
                token,
                outcome,
                code,
              ),
          },
          local.credentialKeysetCommitment,
        );
        expect(began).toBe(1);
        expect(requests).toEqual([]);
        expect(afterRace).toBeDefined();
        expect(await state()).toEqual(afterRace);
        const item = await first<{ state: string; claim_pass_id: string; claim_snapshot: string }>(
          local.env.DB,
          `SELECT i.state, i.claim_pass_id, i.claim_snapshot FROM connection_webhook_items i
           JOIN connection_webhook_retention r ON r.id = i.retention_id
           WHERE r.connection_id = ? AND r.event_id = ? AND i.ordinal = 0`,
          [dto.id, job.eventId],
        );
        expect(item).toMatchObject({ state: 'uncertain', claim_pass_id: original.id });
        expect(JSON.parse(item?.claim_snapshot ?? 'null')).toMatchObject({
          passId: original.id,
          orgId: original.orgId,
          identityId: original.identityId,
          connectionId: dto.id,
          generation: 1,
          mode: 'live',
          status: 'active',
          rowVersion: captured.rowVersion,
          ownerUserId: captured.ownerUserId,
          linkGeneration: captured.linkGeneration,
          credentialGeneration: captured.credentialGeneration,
          lifecycleGeneration: captured.lifecycleGeneration,
          credentialKeysetCommitment: local.credentialKeysetCommitment,
          refHash: expect.any(String),
          templateId: original.templateId,
          releaseId: original.releaseId,
          templateVersion: original.templateVersion,
        });
      } finally {
        resetDeps();
        setDeps({ sleep: async () => {}, resolver: publicResolver });
      }
    },
    120_000,
  );

  it.each(['new', 'no-effect'] as const)(
    'parks a %s claim when another pass appears after prefetch',
    async (kind) => {
      const local = await setupConnectionKit();
      const release = local.liveRelease;
      if (!release) throw new Error('Missing approved release');
      resetDeps();
      setDeps({ sleep: async () => {}, resolver: publicResolver });
      try {
        const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
          orgId: local.org.id,
          connectorType: 'http-json',
          name: 'Previously unbound race',
          config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
          mode: 'hybrid',
          mapping: { memberName: { from: '/memberName' } },
          autoCreate: kind === 'new',
          defaultTemplateId: local.template.id,
        } as never);
        const job = await stageVerified(
          local,
          dto.id,
          dto.webhookSecret as string,
          `appeared-${kind}`,
          'm-001',
          true,
        );
        const retained = await loadRetainedWebhook(local.ctx, job);
        const conn = await getConnection(local.env.DB, dto.id);
        if (!retained || !conn) throw new Error('Missing retained webhook or connection');
        const requests: string[] = [];
        setDeps({
          fetchImpl: (async (input: RequestInfo | URL) => {
            requests.push(String(input));
            return new Response(JSON.stringify({ memberName: 'Should not apply' }), {
              status: 200,
            });
          }) as typeof fetch,
        });
        const prep = await prepare(local.ctx, conn);
        const outbox = await all(
          local.env.DB,
          'SELECT * FROM outbox WHERE org_id = ? ORDER BY id',
          [local.org.id],
        );
        let winnerId: string | undefined;
        let winnerBefore: unknown;
        let reservedId: string | undefined;
        await applyChanges(
          local.ctx,
          conn,
          prep,
          [{ ref: 'm-001' }],
          {
            kind: 'approved',
            id: release.id,
            generation: release.generation,
            version: release.version,
          },
          {
            begin: async (index, candidate) => {
              expect(candidate.kind).toBe(kind);
              if (candidate.kind === 'new') reservedId = candidate.reservedPassId;
              const winner = await makePass(local.fx, {
                orgId: local.org.id,
                template: local.template,
              });
              winnerId = winner.id;
              await run(
                local.env.DB,
                'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?',
                [dto.id, 'm-001', winner.id],
              );
              winnerBefore = await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [
                winner.id,
              ]);
              const claim = await startRetainedWebhookItem(
                local.ctx,
                job,
                retained.revision,
                index,
                candidate,
              );
              expect(claim).toBeNull();
              return claim;
            },
            finish: (index, token, outcome, code) =>
              finishRetainedWebhookItem(
                local.ctx,
                job,
                retained.revision,
                index,
                token,
                outcome,
                code,
              ),
          },
          local.credentialKeysetCommitment,
        );
        expect(winnerId).toBeTruthy();
        if (kind === 'new') {
          expect(reservedId).toBeTruthy();
          expect(reservedId).not.toBe(winnerId);
        }
        expect(requests).toEqual([]);
        expect(await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [winnerId])).toEqual(
          winnerBefore,
        );
        expect(
          await all(local.env.DB, 'SELECT id FROM passes WHERE connection_id = ?', [dto.id]),
        ).toEqual([{ id: winnerId }]);
        expect(
          await all(local.env.DB, 'SELECT * FROM outbox WHERE org_id = ? ORDER BY id', [
            local.org.id,
          ]),
        ).toEqual(outbox);
        expect(
          await first(
            local.env.DB,
            `SELECT i.state, i.claim_pass_id FROM connection_webhook_items i
           JOIN connection_webhook_retention r ON r.id = i.retention_id
           WHERE r.connection_id = ? AND r.event_id = ? AND i.ordinal = 0`,
            [dto.id, job.eventId],
          ),
        ).toEqual({ state: 'uncertain', claim_pass_id: winnerId });
      } finally {
        resetDeps();
        setDeps({ sleep: async () => {}, resolver: publicResolver });
      }
    },
    120_000,
  );

  it('never exempts the initiating item from transfer START while its claim is started or uncertain', async () => {
    const local = await setupConnectionKit();
    const release = local.liveRelease;
    if (!release) throw new Error('Missing approved release');
    resetDeps();
    setDeps({ sleep: async () => {}, resolver: publicResolver });
    try {
      const dto = await service.create(local.ctx, { type: 'user', id: 'admin-1' }, {
        orgId: local.org.id,
        connectorType: 'http-json',
        name: 'Claim versus transfer',
        config: { baseUrl: 'https://api.example.com', recordPath: '/m/{ref}' },
        mode: 'hybrid',
        mapping: { memberName: { from: '/memberName' } },
        autoCreate: true,
        defaultTemplateId: local.template.id,
      } as never);
      const pass = await createPassFromConnection(local.ctx, {
        orgId: local.org.id,
        mode: 'live',
        templateId: local.template.id,
        credentialKeysetCommitment: local.credentialKeysetCommitment,
        expectedRelease: {
          id: release.id,
          generation: release.generation,
          version: release.version,
        },
        connectionId: dto.id,
        generation: 1,
        externalRef: 'm-001',
        expectedConnectionMode: 'hybrid',
        fields: { memberName: 'Original' },
        sendEmail: false,
      });
      await local.settle();
      const job = await stageVerified(
        local,
        dto.id,
        dto.webhookSecret as string,
        'own-item',
        'm-001',
        true,
      );
      const retained = await loadRetainedWebhook(local.ctx, job);
      const conn = await getConnection(local.env.DB, dto.id);
      if (!retained || !conn) throw new Error('Missing retained webhook or connection');
      const requests: string[] = [];
      setDeps({
        fetchImpl: (async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return new Response(JSON.stringify({ memberName: 'Should not apply' }), { status: 200 });
        }) as typeof fetch,
      });
      const prep = await prepare(local.ctx, conn);
      const before = await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.passId]);
      const outbox = await all(local.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
        pass.passId,
      ]);
      let attempted = 0;
      await applyChanges(
        local.ctx,
        conn,
        prep,
        [{ ref: 'm-001' }],
        {
          kind: 'approved',
          id: release.id,
          generation: release.generation,
          version: release.version,
        },
        {
          begin: async (index, candidate) => {
            expect(candidate.kind).toBe('existing');
            const claim = await startRetainedWebhookItem(
              local.ctx,
              job,
              retained.revision,
              index,
              candidate,
            );
            if (!claim) throw new Error('Missing started claim');
            for (const state of ['started', 'uncertain'] as const) {
              if (state === 'uncertain') {
                await finishRetainedWebhookItem(
                  local.ctx,
                  job,
                  retained.revision,
                  index,
                  claim.token,
                  'uncertain',
                );
              }
              const item = await first<{ state: string; claim_pass_id: string }>(
                local.env.DB,
                `SELECT i.state, i.claim_pass_id FROM connection_webhook_items i
                 JOIN connection_webhook_retention r ON r.id = i.retention_id
                 WHERE r.connection_id = ? AND r.event_id = ? AND i.ordinal = ?`,
                [dto.id, job.eventId, index],
              );
              expect(item).toEqual({ state, claim_pass_id: pass.passId });
              const holder = await getHolderPass(local.env.DB, pass.passId, null);
              if (!holder) throw new Error('Missing holder');
              await expect(
                startCredentialTransfer(
                  jobCtxOf(local),
                  { type: 'system', id: null },
                  pass.passId,
                  { holderEmail: 'next@example.test', ownerUserId: null },
                  null,
                  { kind: 'tenant-holder', expected: holder },
                ),
              ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
              attempted += 1;
            }
            return null;
          },
          finish: (index, token, outcome, code) =>
            finishRetainedWebhookItem(
              local.ctx,
              job,
              retained.revision,
              index,
              token,
              outcome,
              code,
            ),
        },
        local.credentialKeysetCommitment,
      );
      expect(attempted).toBe(2);
      expect(requests).toEqual([]);
      expect(await first(local.env.DB, 'SELECT * FROM passes WHERE id = ?', [pass.passId])).toEqual(
        before,
      );
      expect(
        await all(local.env.DB, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [
          pass.passId,
        ]),
      ).toEqual(outbox);
      expect(
        await all(local.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
          pass.passId,
        ]),
      ).toEqual([]);
    } finally {
      resetDeps();
      setDeps({ sleep: async () => {}, resolver: publicResolver });
    }
  }, 120_000);
});

const runOf = (id: string) =>
  first<{ passes_changed: number; outcome: string }>(
    kit.env.DB,
    'SELECT passes_changed, outcome FROM connection_runs WHERE id = ?',
    [id],
  );
