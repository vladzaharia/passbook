import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { scannerActor, withRole } from './actor.ts';
import { candidateAuthority } from './candidate-authority-test-fixtures.ts';
import {
  planPendingDisplayHistorySource,
  preparePlannedDisplayHistoryProof,
} from './display-history-pending.ts';
import {
  consumeDisplayHistoryRead,
  planDisplayHistoryRead,
  rebindDisplayHistoryRead,
} from './display-history-plan.ts';
import { RACE_HISTORY_PAGE } from './race-tags.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { claimScanStmt } from './repo-scans-test-support.ts';
import { readScannerScope } from './repo-scope.ts';
import { foundOf } from './resolve.ts';
import { prepareDisplayHistory } from './scan-display-history.ts';
import { codeOf, key, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

async function scenario(copyCredential = true) {
  const walletSecret = 'wallet-private-value-🪪';
  const externalId = 'external-private-value';
  const holderEmail = 'private-holder@example.test';
  const templateId = await kit.scanTemplate(
    'History secret fence',
    {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    },
    { passStyle: { userInfo: { nested: [{ value: walletSecret }, { count: 12, flag: true }] } } },
  );
  const pass = await kit.scanPass(templateId, {}, { holderEmail });
  const scanner = await kit.scanner({ templateIds: [templateId] });
  await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [externalId, pass.id]);
  const response = await kit.post(scanner.headers, '/actions', {
    input: codeOf(pass),
    idempotencyKey: key(),
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { kind: string; scanId: string | null };
  expect(result.kind).toBe('ok');
  if (!result.scanId || !pass.scanCode) throw new Error('Missing scan or pass credential');
  // A private input can repeat a credential; its JSON must not be packed either.
  if (copyCredential)
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization=json_set(personalization,'$.credentialCopy',?) WHERE id=?",
      [pass.authToken, pass.id],
    );
  return { pass, scanner, scanId: result.scanId, walletSecret, externalId, holderEmail };
}

function recordingDb(db: D1Database) {
  const prepared: { sql: string; values: unknown[] }[] = [];
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(bound, member) {
              if (member === 'bind')
                return (...values: unknown[]) => {
                  prepared.push({ sql, values });
                  return bound.bind(...values);
                };
              const value = Reflect.get(bound, member, bound);
              return typeof value === 'function' ? value.bind(bound) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, prepared };
}

describe('display history read', () => {
  it('batches proof discovery with caller reads and retains the zero-history fast path', async () => {
    const s = await scenario(false);
    const scanner = await getScanner(kit.env.DB, s.scanner.id);
    if (!scanner) throw new Error('Missing scanner');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(
          kit.ctx,
          scanner,
          scanner.mode,
          'cookie',
          await readScannerScope(kit.env.DB, scanner, null),
        ),
        null,
      ),
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!candidate) throw new Error('Missing candidate');
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing authorized pass');
    const recorder = recordingDb(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: recorder.db } };
    const needs = { history: ['visits', 'scans'], ledger: [] };
    const plan = planDisplayHistoryRead(ctx, actor, found, needs);
    expect(plan.stmts).toHaveLength(1);
    expect(
      recorder.prepared.some(
        (entry) => entry.sql.includes(RACE_HISTORY_PAGE) && entry.values.length <= 100,
      ),
    ).toBe(true);
    const preloaded = await plan.finish(await recorder.db.batch(plan.stmts));
    if (!preloaded) throw new Error('Missing preloaded history');
    expect(JSON.stringify(preloaded)).not.toContain(s.pass.authToken);
    const display = await prepareDisplayHistory(ctx, actor, found, needs, preloaded);
    const now = kit.clock.now();
    const authority = candidateAuthority(actor, candidate, now, actor.event);
    const bound = display.bind(now, authority);
    const history = bound.finalize(await recorder.db.batch(bound.stmts));
    expect(history?.value).toMatchObject({
      scans: { total: 1 },
      visits: { total: 1 },
      list: { scans: [{ label: 'Check in' }] },
    });
    expect(bound.finalize([])).toBeNull();
    const missing = planDisplayHistoryRead(ctx, actor, found, needs);
    expect(await missing.finish([])).toBeNull();
    const empty = planDisplayHistoryRead(ctx, actor, found, { history: [], ledger: [] });
    expect(empty.stmts).toHaveLength(0);
    expect(await empty.finish([])).not.toBeNull();
    const scoped = planDisplayHistoryRead(ctx, actor, found, needs, 0, 'planned-event');
    const scopedPreload = await scoped.finish(await recorder.db.batch(scoped.stmts));
    if (!scopedPreload) throw new Error('Missing scoped preload');
    const selected = {
      ...actor,
      event: { id: 'planned-event', updatedAt: 1 } as NonNullable<typeof actor.event>,
    };
    const other = {
      ...actor,
      event: { id: 'wrong-event', updatedAt: 1 } as NonNullable<typeof actor.event>,
    };
    expect(rebindDisplayHistoryRead(scopedPreload, other, found)).toBe(false);
    expect(
      rebindDisplayHistoryRead(scopedPreload, selected, {
        ...found,
        pass: { ...found.pass, imageGeneration: found.pass.imageGeneration + 1 },
      }),
    ).toBe(false);
    expect(rebindDisplayHistoryRead(scopedPreload, selected, found)).toBe(true);
    expect((await consumeDisplayHistoryRead(scopedPreload, selected, found, needs))?.total).toBe(0);
  });

  it('loads every bounded page in one follow-on batch without trusting unsigned scans', async () => {
    const s = await scenario(false);
    const scanner = await getScanner(kit.env.DB, s.scanner.id);
    if (!scanner) throw new Error('Missing scanner');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(
          kit.ctx,
          scanner,
          scanner.mode,
          'cookie',
          await readScannerScope(kit.env.DB, scanner, null),
        ),
        null,
      ),
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!candidate) throw new Error('Missing candidate');
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing authorized pass');
    const prefix = key();
    await run(
      kit.env.DB,
      `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<101)
      INSERT INTO scans (id,org_id,mode,pass_id,template_id,scanner_id,actor_type,actor_id,actor_key,
        idempotency_key,request_hash,method,state,outcome,action_id,action_kind,pass_version,at)
      SELECT ? || printf('-%03d',seq.n),source.org_id,source.mode,source.pass_id,source.template_id,
        source.scanner_id,source.actor_type,source.actor_id,source.actor_key,
        ? || printf('-%03d',seq.n),source.request_hash,source.method,'done','ok',
        source.action_id,'check_in',source.pass_version,source.at
      FROM scans source CROSS JOIN seq WHERE source.id=?`,
      [prefix, prefix, s.scanId],
    );
    const recorder = recordingDb(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: recorder.db } };
    const needs = { history: ['visits'], ledger: [] };
    const first = planDisplayHistoryRead(ctx, actor, found, needs);
    const preloaded = await first.finish(await recorder.db.batch(first.stmts));
    if (!preloaded) throw new Error('Missing first history page');
    const complete = await consumeDisplayHistoryRead(preloaded, actor, found, needs);
    expect(complete?.total).toBe(102);
    expect(complete?.ids).toHaveLength(102);
    expect(complete?.rows.size).toBe(1);
    expect(complete?.rows.has(s.scanId)).toBe(true);
    expect(recorder.prepared.filter((entry) => entry.sql.includes(RACE_HISTORY_PAGE))).toHaveLength(
      2,
    );
    const batched = planDisplayHistoryRead(ctx, actor, found, needs, 102);
    expect(batched.stmts).toHaveLength(2);
    const allPages = await batched.finish(await recorder.db.batch(batched.stmts));
    if (!allPages) throw new Error('Missing batched history pages');
    const combined = await consumeDisplayHistoryRead(allPages, actor, found, needs);
    expect(combined?.ids).toHaveLength(102);
    expect(combined?.rows.size).toBe(1);
  });

  it('captures pending scan sources opaquely and rejects an unowned planned proof', async () => {
    const s = await scenario(false);
    const scanner = await getScanner(kit.env.DB, s.scanner.id);
    if (!scanner) throw new Error('Missing scanner');
    const actor = await proofedScanActor(
      kit.ctx,
      withRole(
        scannerActor(
          kit.ctx,
          scanner,
          scanner.mode,
          'cookie',
          await readScannerScope(kit.env.DB, scanner, null),
        ),
        null,
      ),
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, s.pass.id);
    if (!candidate) throw new Error('Missing candidate');
    const found = await foundOf(kit.ctx, candidate, actor);
    if (!found) throw new Error('Missing authorized pass');
    const id = kit.fx.ids.id();
    const now = kit.clock.now();
    await kit.env.DB.batch([
      claimScanStmt(kit.env.DB, {
        id,
        orgId: actor.orgId,
        mode: actor.mode,
        scannerId: scanner.id,
        eventId: null,
        actorType: 'scanner',
        actorId: scanner.id,
        actorKey: actor.actorKey,
        staffId: null,
        idempotencyKey: key(),
        requestHash: 'pending-history-request',
        method: 'manual',
        clientTs: now,
        now,
      }),
    ]);
    const recorder = recordingDb(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: recorder.db } };
    const plan = planPendingDisplayHistorySource(ctx, actor, found, id, {
      history: ['visits'],
      ledger: [],
    });
    expect(plan.stmts).toHaveLength(1);
    const source = plan.finish(await recorder.db.batch(plan.stmts));
    if (!source) throw new Error('Missing pending source');
    expect(JSON.stringify(source)).not.toContain(s.pass.authToken);
    expect(JSON.stringify(source)).not.toContain(s.pass.serial);
    expect(JSON.stringify(source)).not.toContain(s.walletSecret);
    expect(
      recorder.prepared.some(
        (entry) => entry.sql.includes("s.state = 'pending'") && entry.values.length <= 100, // sql-shape
      ),
    ).toBe(true);
    expect(
      await preparePlannedDisplayHistoryProof({} as never, actor, found, {} as never, {} as never),
    ).toBeNull();
  });
});
