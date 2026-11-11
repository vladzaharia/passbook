import { beforeAll, describe, expect, it } from 'vitest';
import { makeTemplate, persistTemplate } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { applyConnectionRecord, markPassMissing } from './connection-passes.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import type { ConnectionPassContext } from './repo.ts';
import { getPass, getPassBySerial } from './repo-read-pass.ts';

let kit: Kit;
let oldReleaseId: string;
const otherVersion = 'retained-race-other-version';
type Operation = 'change' | 'no-op' | 'flag' | 'void';
const operations: Operation[] = ['change', 'no-op', 'flag', 'void'];
interface PassSnapshot {
  pass: unknown;
  versions: unknown[];
  outbox: unknown[];
  events: unknown[];
  audit: unknown[];
}

beforeAll(async () => {
  kit = await setupKit();
  if (!kit.liveRelease) throw new Error('Missing initial Apple release');
  oldReleaseId = kit.liveRelease.id;
  // Keep an earlier real release of this same scope and version for the pass-identity races.
  await approveAppleRelease(kit);
  await run(
    kit.env.DB,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, report, build_key, created_by, created_at)
     SELECT template_id, ?, manifest, pass_json, assets, report, build_key, created_by, created_at
     FROM template_versions WHERE template_id = ? AND version = ?`,
    [otherVersion, kit.template.id, kit.template.version],
  );
}, 60_000);

async function linked() {
  const pass = await kit.pass();
  const release = await requireApprovedRelease(
    kit.ctx,
    pass.templateId,
    pass.orgId,
    'live',
    'apple',
  );
  const connectionId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, mode, generation, created_at, updated_at)
     VALUES (?, ?, 'demo', 'retained race', 'webhook', 1, 1, 1)`,
    [connectionId, pass.orgId],
  );
  await run(
    kit.env.DB,
    `UPDATE passes SET connection_id = ?, external_ref = 'ref', field_sources = '{}',
       sync_error_code = 'PREVIOUS_ERROR' WHERE id = ?`,
    [connectionId, pass.id],
  );
  const current = await getPass(kit.env.DB, pass.id);
  if (!current) throw new Error('Missing fixture pass');
  expect(current).toMatchObject({ releaseId: release.id, templateVersion: release.version });
  const context: ConnectionPassContext = {
    passId: current.id,
    orgId: current.orgId,
    mode: 'live',
    status: 'active',
    expectedVersion: current.version,
    ownerUserId: current.ownerUserId,
    linkGeneration: current.linkGeneration,
    connectionId,
    externalRef: 'ref',
    generation: 1,
    identityId: current.identityId,
    credentialGeneration: current.credentialGeneration,
    lifecycleGeneration: current.lifecycleGeneration,
    credentialKeysetCommitment: await ensureCredentialRefKeyset(kit.env.DB, kit.env),
    transferPending: false,
    expectedConnectionMode: 'webhook',
    retainedReleaseProof: {
      id: release.id,
      generation: release.generation,
      version: release.version,
    },
  };
  await kit.settle();
  return { pass: current, context };
}

function apply(operation: Operation, context: ConnectionPassContext) {
  if (operation === 'flag' || operation === 'void')
    return markPassMissing(jobCtxOf(kit), context, operation);
  return applyConnectionRecord(jobCtxOf(kit), {
    ...context,
    cause: 'connection',
    fields: operation === 'change' ? { memberName: 'Changed member' } : {},
  });
}

async function snapshot(db: D1Database, id: string): Promise<PassSnapshot> {
  return {
    pass: await first(db, 'SELECT * FROM passes WHERE id = ?', [id]),
    versions: await all(db, 'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version', [id]),
    outbox: await all(db, 'SELECT * FROM outbox WHERE pass_id = ? ORDER BY id', [id]),
    events: await all(db, 'SELECT * FROM pass_events WHERE pass_id = ? ORDER BY id', [id]),
    audit: await all(
      db,
      "SELECT * FROM audit_log WHERE target_type = 'pass' AND target_id = ? ORDER BY id",
      [id],
    ),
  };
}

async function objectKeys(id: string) {
  return (await kit.env.BUCKET.list({ prefix: `passes/${id}/` })).objects
    .map((object) => object.key)
    .sort();
}

/** Interleave a mutation before a selected real D1 statement, including batched statements. */
async function atPassStatement<T>(
  matches: (sql: string) => boolean,
  occurrence: number,
  change: (db: D1Database) => Promise<void>,
  call: () => Promise<T>,
): Promise<T> {
  const db = kit.env.DB;
  const statements = new WeakMap<
    D1PreparedStatement,
    { sql: string; native: D1PreparedStatement }
  >();
  let matched = 0;
  const intervene = async (sql: string) => {
    if (matches(sql) && ++matched === occurrence) await change(db);
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === 'first')
          return async (column?: string) => {
            await intervene(sql);
            return column === undefined ? target.first() : target.first(column);
          };
        if (prop === 'run')
          return async () => {
            await intervene(sql);
            return target.run();
          };
        if (prop === 'all')
          return async () => {
            await intervene(sql);
            return target.all();
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    statements.set(wrapped, { sql, native: statement });
    return wrapped;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === 'batch')
        return async (batch: D1PreparedStatement[]) => {
          for (const statement of batch) await intervene(statements.get(statement)?.sql ?? '');
          return target.batch(
            batch.map((statement) => statements.get(statement)?.native ?? statement),
          );
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.assign(kit.env, { DB: proxy });
  try {
    return await call();
  } finally {
    Object.assign(kit.env, { DB: db });
    expect(matched, 'the selected pass statement was reached').toBeGreaterThanOrEqual(occurrence);
  }
}

describe('retained connection release proof', () => {
  it.each(operations)(
    'permits an exact active proof for %s',
    async (operation) => {
      const { pass, context } = await linked();
      const result = await apply(operation, context);
      const updated = await getPass(kit.env.DB, pass.id);
      expect(result.pushQueued).toBe(operation === 'change' || operation === 'void');
      if (operation === 'change') {
        expect(result).toMatchObject({ changed: true, version: pass.version + 1 });
        expect(updated?.personalization.memberName).toBe('Changed member');
        expect(updated?.syncErrorCode).toBeNull();
      } else if (operation === 'no-op') {
        expect(result).toMatchObject({ changed: false, version: pass.version });
        expect(updated?.syncErrorCode).toBeNull();
      } else {
        expect(updated?.syncErrorCode).toBe('RECORD_MISSING');
        expect(updated?.status).toBe(operation === 'void' ? 'voided' : 'active');
        expect(updated?.version).toBe(pass.version + (operation === 'void' ? 1 : 0));
      }
    },
    60_000,
  );

  it('reports a metadata-only sync as not having queued a push', async () => {
    const { pass, context } = await linked();
    const before = await all(kit.env.DB, 'SELECT id FROM outbox WHERE pass_id = ? ORDER BY id', [
      pass.id,
    ]);
    const result = await applyConnectionRecord(jobCtxOf(kit), {
      ...context,
      cause: 'connection',
      fields: { memberName: pass.personalization.memberName! },
    });
    expect(result).toMatchObject({ changed: false, pushQueued: false, version: pass.version + 1 });
    expect(
      await all(kit.env.DB, 'SELECT id FROM outbox WHERE pass_id = ? ORDER BY id', [pass.id]),
    ).toEqual(before);
  }, 60_000);

  it('commits mapped content only with the completed credential rotation under the exact retained proof', async () => {
    const { pass, context } = await linked();
    const result = await applyConnectionRecord(jobCtxOf(kit), {
      ...context,
      holderEmail: 'replacement@example.test',
      fields: { memberName: 'Replacement member' },
      cause: 'connection',
    });
    const changed = await getPass(kit.env.DB, pass.id);
    expect(result).toMatchObject({
      changed: true,
      version: pass.version + 1,
      linkGeneration: pass.linkGeneration + 1,
      credentialGeneration: pass.credentialGeneration + 1,
      transferPending: false,
    });
    expect(changed).toMatchObject({
      holderEmail: 'replacement@example.test',
      personalization: { ...pass.personalization, memberName: 'Replacement member' },
    });
    expect(changed?.serial).not.toBe(pass.serial);
    expect(changed?.authToken).not.toBe(pass.authToken);
    expect(changed?.scanCode).not.toBe(pass.scanCode);
    expect(await getPassBySerial(kit.env.DB, pass.identityId, pass.serial)).toBeNull();
  }, 60_000);

  it.each(['head', 'mode', 'generation'] as const)(
    'does not start a retained holder transfer when the %s changes at reservation',
    async (change) => {
      const { pass, context } = await linked();
      const objects = await objectKeys(pass.id);
      let raced: PassSnapshot | undefined;
      await atPassStatement(
        (sql) => /^\s*INSERT\s+INTO\s+pass_credential_transfers\b/i.test(sql),
        1,
        async (db) => {
          if (change === 'head') await approveAppleRelease(kit, { db });
          else if (change === 'mode')
            await run(db, "UPDATE connections SET mode = 'hybrid' WHERE id = ?", [
              context.connectionId,
            ]);
          else
            await run(db, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
              context.connectionId,
            ]);
          raced = await snapshot(db, pass.id);
        },
        async () => {
          await expect(
            applyConnectionRecord(jobCtxOf(kit), {
              ...context,
              holderEmail: 'replacement@example.test',
              fields: { memberName: 'Replacement member' },
              cause: 'connection',
            }),
          ).rejects.toMatchObject({
            code: change === 'head' ? 'TEMPLATE_RELEASE_CONFLICT' : 'PASS_CONFLICT',
          });
        },
      );
      expect(raced).toBeDefined();
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(raced);
      expect(await objectKeys(pass.id)).toEqual(objects);
      expect(
        await first(kit.env.DB, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [
          pass.id,
        ]),
      ).toBeNull();
    },
    120_000,
  );

  it.each(
    operations.flatMap((operation) =>
      (['template', 'release', 'version'] as const).map((field) => ({ operation, field })),
    ),
  )(
    'fences retained binding $field changes independently of an active-head proof for $operation',
    async ({ operation, field }) => {
      const { pass, context } = await linked();
      const { retainedReleaseProof: _proof, ...ordinary } = context;
      const admitted: ConnectionPassContext = {
        ...ordinary,
        retainedBinding: {
          templateId: pass.templateId,
          releaseId: pass.releaseId,
          templateVersion: pass.templateVersion,
          credentialKeysetCommitment: context.credentialKeysetCommitment,
        },
      };
      if (field === 'template') {
        const other = makeTemplate({
          id: `retained-${kit.fx.ids.token(6)}`,
          version: pass.templateVersion,
        });
        await persistTemplate(kit.fx, other.resolved, { registry: other.registry });
        await run(kit.env.DB, 'UPDATE passes SET template_id = ? WHERE id = ?', [
          other.resolved.id,
          pass.id,
        ]);
      } else {
        await run(
          kit.env.DB,
          field === 'release'
            ? 'UPDATE passes SET release_id = ? WHERE id = ?'
            : 'UPDATE passes SET template_version = ? WHERE id = ?',
          [field === 'release' ? oldReleaseId : otherVersion, pass.id],
        );
      }
      const before = await snapshot(kit.env.DB, pass.id);
      await expect(apply(operation, admitted)).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
    },
    60_000,
  );

  it.each(operations)(
    'rejects malformed and wrong-generation proofs for %s',
    async (operation) => {
      const { pass, context } = await linked();
      const proof = context.retainedReleaseProof!;
      const before = await snapshot(kit.env.DB, pass.id);
      const objects = await objectKeys(pass.id);
      const invalid = [
        null,
        {},
        { ...proof, id: '' },
        { ...proof, id: 5 },
        { ...proof, generation: 0 },
        { ...proof, generation: 1.5 },
        { ...proof, generation: Number.MAX_SAFE_INTEGER + 1 },
        { ...proof, version: '' },
        { ...proof, version: null },
      ];
      for (const retainedReleaseProof of invalid) {
        await expect(
          apply(operation, { ...context, retainedReleaseProof } as ConnectionPassContext),
        ).rejects.toMatchObject({ status: 409 });
        expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
        expect(await objectKeys(pass.id)).toEqual(objects);
      }
      await expect(
        apply(operation, { ...context, expectedConnectionMode: 'poll' }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      await expect(
        apply(operation, {
          ...context,
          retainedReleaseProof: { ...proof, generation: proof.generation + 1 },
        }),
      ).rejects.toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
      expect(await objectKeys(pass.id)).toEqual(objects);
    },
    60_000,
  );

  it.each(operations)(
    'rejects a retained %s without its admitted webhook mode',
    async (operation) => {
      const { pass, context } = await linked();
      const { expectedConnectionMode: _mode, ...missingMode } = context;
      const before = await snapshot(kit.env.DB, pass.id);
      await expect(apply(operation, missingMode as ConnectionPassContext)).rejects.toMatchObject({
        code: 'PASS_CONFLICT',
      });
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
    },
    60_000,
  );

  it.each(operations)(
    'rejects a same-generation connection mode race during %s',
    async (operation) => {
      const { pass, context } = await linked();
      const before = await snapshot(kit.env.DB, pass.id);
      const objects = await objectKeys(pass.id);
      await atPassStatement(
        (sql) => /^\s*UPDATE\s+passes\s+SET\b/i.test(sql),
        1,
        async (db) => {
          await run(db, "UPDATE connections SET mode = 'hybrid' WHERE id = ?", [
            context.connectionId,
          ]);
        },
        async () => {
          await expect(apply(operation, context)).rejects.toMatchObject({ status: 409 });
        },
      );
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
      expect(await objectKeys(pass.id)).toEqual(objects);
    },
    60_000,
  );

  it.each(operations)(
    'rejects a superseded release before %s',
    async (operation) => {
      const { pass, context } = await linked();
      const before = await snapshot(kit.env.DB, pass.id);
      const objects = await objectKeys(pass.id);
      await approveAppleRelease(kit);
      await expect(apply(operation, context)).rejects.toMatchObject({
        code: 'TEMPLATE_RELEASE_CONFLICT',
      });
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
      expect(await objectKeys(pass.id)).toEqual(objects);
    },
    60_000,
  );

  it.each(
    operations.flatMap((operation) =>
      (['release', 'version'] as const).map((field) => ({ operation, field })),
    ),
  )(
    'rejects a pass $field change after admission before $operation starts',
    async ({ operation, field }) => {
      const { pass, context } = await linked();
      await run(
        kit.env.DB,
        field === 'release'
          ? 'UPDATE passes SET release_id = ? WHERE id = ?'
          : 'UPDATE passes SET template_version = ? WHERE id = ?',
        [field === 'release' ? oldReleaseId : otherVersion, pass.id],
      );
      const before = await snapshot(kit.env.DB, pass.id);
      const objects = await objectKeys(pass.id);
      await expect(apply(operation, context)).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
      expect(await objectKeys(pass.id)).toEqual(objects);
    },
    60_000,
  );

  it.each(
    operations.flatMap((operation) =>
      (['release', 'version'] as const).flatMap((field) =>
        // The pass is read and fenced in its one guarded write, so there is a single window.
        [1].map((occurrence) => ({
          operation,
          field,
          occurrence,
        })),
      ),
    ),
  )(
    'rejects a $field race at the guarded pass write for $operation',
    async ({ operation, field, occurrence }) => {
      const { pass, context } = await linked();
      const objects = await objectKeys(pass.id);
      let raced: PassSnapshot | undefined;
      await atPassStatement(
        (sql) => /^\s*UPDATE\s+passes\s+SET\b/i.test(sql),
        occurrence,
        async (db) => {
          await run(
            db,
            field === 'release'
              ? 'UPDATE passes SET release_id = ? WHERE id = ?'
              : 'UPDATE passes SET template_version = ? WHERE id = ?',
            [field === 'release' ? oldReleaseId : otherVersion, pass.id],
          );
          raced = await snapshot(db, pass.id);
        },
        async () => {
          await expect(apply(operation, context)).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
        },
      );
      expect(raced).toBeDefined();
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(raced);
      expect(await objectKeys(pass.id)).toEqual(objects);
    },
    60_000,
  );

  it.each(operations)(
    'rejects an ineligible release before %s',
    async (operation) => {
      const { pass, context } = await linked();
      const before = await snapshot(kit.env.DB, pass.id);
      const objects = await objectKeys(pass.id);
      await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [
        pass.templateId,
      ]);
      try {
        await expect(apply(operation, context)).rejects.toMatchObject({
          code: 'TEMPLATE_RELEASE_CONFLICT',
        });
        expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
        expect(await objectKeys(pass.id)).toEqual(objects);
      } finally {
        await run(kit.env.DB, "UPDATE templates SET status = 'active' WHERE id = ?", [
          pass.templateId,
        ]);
      }
    },
    60_000,
  );

  it.each(
    operations.flatMap((operation) =>
      (['release', 'version', 'head', 'ineligible'] as const).map((field) => ({
        operation,
        field,
      })),
    ),
  )(
    'atomically rejects a $field race at the final $operation update',
    async ({ operation, field }) => {
      const { pass, context } = await linked();
      const objects = await objectKeys(pass.id);
      const emails = kit.mailer.sent.length;
      const queue = kit.queue.sent.length;
      let raced: PassSnapshot | undefined;
      try {
        await atPassStatement(
          (sql) => /^\s*UPDATE\s+passes\s+SET\b/i.test(sql),
          1,
          async (db) => {
            if (field === 'head') {
              const superseding = await approveAppleRelease(kit, { db });
              expect(superseding.generation).toBe(context.retainedReleaseProof!.generation + 1);
              expect(superseding.id).not.toBe(context.retainedReleaseProof!.id);
            } else if (field === 'ineligible') {
              await run(db, "UPDATE templates SET status = 'archived' WHERE id = ?", [
                pass.templateId,
              ]);
            } else {
              await run(
                db,
                field === 'release'
                  ? 'UPDATE passes SET release_id = ? WHERE id = ?'
                  : 'UPDATE passes SET template_version = ? WHERE id = ?',
                [field === 'release' ? oldReleaseId : otherVersion, pass.id],
              );
            }
            raced = await snapshot(db, pass.id);
          },
          async () => {
            await expect(apply(operation, context)).rejects.toMatchObject({
              code:
                field === 'head' || field === 'ineligible'
                  ? 'TEMPLATE_RELEASE_CONFLICT'
                  : 'PASS_CONFLICT',
            });
          },
        );
        expect(raced).toBeDefined();
        expect(await snapshot(kit.env.DB, pass.id)).toEqual(raced);
        expect(await objectKeys(pass.id)).toEqual(objects);
        expect(kit.mailer.sent).toHaveLength(emails);
        expect(kit.queue.sent).toHaveLength(queue);
      } finally {
        if (field === 'ineligible')
          await run(kit.env.DB, "UPDATE templates SET status = 'active' WHERE id = ?", [
            pass.templateId,
          ]);
      }
    },
    60_000,
  );

  it('fences the no-publish path when an already-voided pass is marked missing', async () => {
    const { pass, context } = await linked();
    await markPassMissing(jobCtxOf(kit), context, 'void');
    await run(kit.env.DB, "UPDATE passes SET sync_error_code = 'PREVIOUS_ERROR' WHERE id = ?", [
      pass.id,
    ]);
    const voided = await getPass(kit.env.DB, pass.id);
    if (!voided) throw new Error('Missing voided pass');
    const admitted: ConnectionPassContext = {
      ...context,
      status: 'voided',
      expectedVersion: voided.version,
      ownerUserId: voided.ownerUserId,
      linkGeneration: voided.linkGeneration,
      identityId: voided.identityId,
      credentialGeneration: voided.credentialGeneration,
      lifecycleGeneration: voided.lifecycleGeneration,
      transferPending: false,
    };
    const before = await snapshot(kit.env.DB, pass.id);
    const objects = await objectKeys(pass.id);
    await atPassStatement(
      (sql) => /^\s*UPDATE\s+passes\s+SET\b/i.test(sql),
      1,
      async (db) => {
        await approveAppleRelease(kit, { db });
      },
      async () => {
        await expect(markPassMissing(jobCtxOf(kit), admitted, 'void')).rejects.toMatchObject({
          code: 'TEMPLATE_RELEASE_CONFLICT',
        });
      },
    );
    expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
    expect(await objectKeys(pass.id)).toEqual(objects);
  }, 60_000);

  it('preserves content-corruption errors on the retained flag path', async () => {
    const { pass, context } = await linked();
    const version = await first<{ assets: string }>(
      kit.env.DB,
      'SELECT assets FROM template_versions WHERE template_id = ? AND version = ?',
      [pass.templateId, pass.templateVersion],
    );
    if (!version) throw new Error('Missing approved template version');
    const assets = JSON.parse(version.assets) as { source: { kind: string; key?: string } }[];
    const key = assets.find((asset) => asset.source.kind === 'r2')?.source.key;
    if (!key) throw new Error('Missing approved template asset');
    const object = await kit.env.BUCKET.get(key);
    if (!object) throw new Error('Missing approved asset bytes');
    const bytes = await object.arrayBuffer();
    const before = await snapshot(kit.env.DB, pass.id);
    const objects = await objectKeys(pass.id);
    await kit.env.BUCKET.put(key, new Uint8Array([0]));
    try {
      await expect(markPassMissing(jobCtxOf(kit), context, 'flag')).rejects.toMatchObject({
        code: 'TEMPLATE_CONTENT_CHANGED',
      });
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
      expect(await objectKeys(pass.id)).toEqual(objects);
    } finally {
      await kit.env.BUCKET.put(key, bytes);
    }
  }, 60_000);

  it.each(operations)(
    'keeps ordinary %s syncs working without a retained proof after supersession',
    async (operation) => {
      const { pass, context } = await linked();
      await approveAppleRelease(kit);
      const { retainedReleaseProof: _proof, ...ordinary } = context;
      await apply(operation, ordinary);
      const updated = await getPass(kit.env.DB, pass.id);
      expect(updated?.syncErrorCode).toBe(
        operation === 'flag' || operation === 'void' ? 'RECORD_MISSING' : null,
      );
      expect(updated?.status).toBe(operation === 'void' ? 'voided' : 'active');
      expect(updated?.version).toBe(
        pass.version + (operation === 'change' || operation === 'void' ? 1 : 0),
      );
    },
    60_000,
  );

  it.each(operations)(
    'still fences obsolete connection generations for ordinary %s syncs',
    async (operation) => {
      const { pass, context } = await linked();
      const { retainedReleaseProof: _proof, ...ordinary } = context;
      await run(kit.env.DB, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
        context.connectionId,
      ]);
      const before = await snapshot(kit.env.DB, pass.id);
      const objects = await objectKeys(pass.id);
      await expect(apply(operation, ordinary)).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
      expect(await snapshot(kit.env.DB, pass.id)).toEqual(before);
      expect(await objectKeys(pass.id)).toEqual(objects);
    },
    60_000,
  );
});
