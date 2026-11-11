import { beforeAll, describe, expect, it } from 'vitest';
import { first, run, stmt } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { scannerActor, withRole } from './actor.ts';
import { historyProofPolicySources, historyProofSnapshotsForOrg } from './history-proof.ts';
import {
  planPendingDisplayHistorySource,
  preparePlannedDisplayHistoryProof,
} from './history-proof-pending.ts';
import {
  consumeDisplayHistoryRead,
  planDisplayHistoryRead,
  rebindDisplayHistoryRead,
} from './history-proof-plan.ts';
import { getScanner } from './repo-device.ts';
import { historyProofSnapshotPredicates } from './repo-history-proof-cas.ts';
import { candidateById } from './repo-lookup.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { claimScanStmt } from './repo-scans.ts';
import { readScannerScope } from './repo-scope.ts';
import { packScanPredicate, scanSecretSlots } from './repo-secret-binds.ts';
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
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const scope = { orgId: kit.org.id, mode: 'live' as const, credentialKeysetCommitment };
  return { pass, scanner, scanId: result.scanId, scope, walletSecret, externalId, holderEmail };
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

describe('history proof secret bindings', () => {
  it('keeps private values out of snapshots and prepared JSON while retaining exact CAS', async () => {
    const s = await scenario();
    const recorder = recordingDb(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.ctx.env, DB: recorder.db } };
    const proofs = await historyProofSnapshotsForOrg(ctx, s.scope, [s.scanId], new Map());
    const proof = proofs.get(s.scanId);
    if (!proof) throw new Error('Missing verified history proof');
    expect(proof.projectionCurrent).toBe(true);
    const sources = historyProofPolicySources(proof);
    if (!sources) throw new Error('Missing opaque history policy sources');
    const fragments = historyProofSnapshotPredicates(proof, 's', kit.clock.now());
    const packed = fragments.map((fragment) => {
      const result = packScanPredicate(fragment.sql, fragment.params, 'history_bind_test');
      if (!result) throw new Error('History fragment could not be packed');
      return result;
    });
    const current = async () => {
      const results = await recorder.db.batch<{ id: string }>(
        packed.map((fragment) =>
          stmt(recorder.db, `SELECT s.id FROM scans s WHERE s.id=? AND (${fragment.sql})`, [
            s.scanId,
            ...fragment.params,
          ]),
        ),
      );
      return (
        results.length === packed.length &&
        results.every((result) => result.results?.[0]?.id === s.scanId)
      );
    };
    expect(await current()).toBe(true);

    const privateByLabel = {
      serial: s.pass.serial,
      'auth-token': s.pass.authToken,
      'download-token': s.pass.downloadToken,
      'web-service-url': s.pass.webServiceUrl,
      'scan-code': s.pass.scanCode!,
      'external-id': s.externalId,
      'holder-email': s.holderEmail,
    };
    const scanner = await first<{ csrf_secret: string | null }>(
      kit.env.DB,
      'SELECT csrf_secret FROM scanners WHERE id=?',
      [s.scanner.id],
    );
    const secrets = [
      ...Object.values(privateByLabel),
      s.walletSecret,
      ...(scanner?.csrf_secret ? [scanner.csrf_secret] : []),
    ];
    expect(sources.privateValues).toEqual(
      expect.arrayContaining([...Object.values(privateByLabel), s.walletSecret]),
    );
    expect(historyProofPolicySources({ ...proof })).toBeNull();
    const serialized = JSON.stringify(proof);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    const finals = recorder.prepared.filter((entry) => entry.sql.includes('history_bind_test'));
    expect(finals).toHaveLength(fragments.length);
    const labeled = finals.flatMap((entry) => {
      expect(entry.values.length).toBeLessThanOrEqual(100);
      const slots = scanSecretSlots(entry.sql, entry.values.length);
      if (!slots) throw new Error('Missing structural bind labels');
      return slots.map((slot, index) => ({ label: slot.label, value: entry.values[index] }));
    });
    for (const [label, secret] of Object.entries(privateByLabel))
      expect(labeled.some((slot) => slot.label === label && slot.value === secret)).toBe(true);
    expect(labeled.some((slot) => slot.label === 'history-current-wallet-private-values')).toBe(
      true,
    );
    const real = kit.env.DB;
    Object.assign(kit.env, { DB: recorder.db });
    try {
      for (const path of ['/scans?limit=5', '/summary']) {
        const response = await kit.get(s.scanner.headers, path);
        expect(response.status).toBe(200);
        const text = await response.text();
        for (const secret of secrets) expect(text).not.toContain(secret);
      }
    } finally {
      Object.assign(kit.env, { DB: real });
    }
    for (const statement of recorder.prepared) {
      for (const value of statement.values) {
        if (typeof value !== 'string') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          continue;
        }
        const json = JSON.stringify(parsed);
        for (const secret of secrets) expect(json).not.toContain(secret);
      }
    }

    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [
      'changed-private-value',
      s.pass.id,
    ]);
    expect(await current()).toBe(false);
    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [s.externalId, s.pass.id]);
    expect(await current()).toBe(true);
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json=json_set(pass_json,'$.userInfo.nested[0].value',?)
      WHERE pass_id=? AND version=(SELECT max(v.version) FROM pass_versions v JOIN passes p ON p.id=v.pass_id
        WHERE v.pass_id=? AND v.version<=p.version)`,
      ['changed-wallet-private-value', s.pass.id, s.pass.id],
    );
    expect(await current()).toBe(false);
    const data = JSON.parse(sources.event.data) as { authority: { eventProof: { mac: string } } };
    const mac = data.authority.eventProof.mac;
    const changed = `${mac[0] === '0' ? '1' : '0'}${mac.slice(1)}`;
    await run(
      kit.env.DB,
      "UPDATE pass_events SET data=json_set(data,'$.authority.eventProof.mac',?) WHERE id=?",
      [changed, sources.event.id],
    );
    expect((await historyProofSnapshotsForOrg(kit.ctx, s.scope, [s.scanId], new Map())).size).toBe(
      0,
    );
  });

  it('segments large Wallet scalars across bounded fragments and rejects forged evidence', async () => {
    const s = await scenario();
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json=json_set(pass_json,'$.userInfo.large',?)
      WHERE pass_id=? AND version=(SELECT max(v.version) FROM pass_versions v JOIN passes p ON p.id=v.pass_id
        WHERE v.pass_id=? AND v.version<=p.version)`,
      ['🙂'.repeat(200_000), s.pass.id, s.pass.id],
    );
    const proofs = await historyProofSnapshotsForOrg(kit.ctx, s.scope, [s.scanId], new Map());
    const proof = proofs.get(s.scanId);
    if (!proof) throw new Error('Missing verified history proof');
    const fragments = historyProofSnapshotPredicates(proof, 's', kit.clock.now());
    const walletParts = fragments.flatMap((fragment) => {
      const slots = scanSecretSlots(fragment.sql, fragment.params.length);
      if (!slots) throw new Error('Missing structural bind labels');
      return slots.flatMap((slot, index) =>
        slot.label === 'history-current-wallet-private-values' ? [fragment.params[index]] : [],
      );
    });
    expect(walletParts.length).toBeGreaterThan(1);
    expect(
      walletParts.every(
        (part) => typeof part === 'string' && new TextEncoder().encode(part).byteLength <= 750_000,
      ),
    ).toBe(true);
    expect(fragments.every((fragment) => fragment.params.length <= 60)).toBe(true);
    const check = () =>
      kit.env.DB.batch<{ id: string }>(
        fragments.map((fragment) =>
          stmt(kit.env.DB, `SELECT s.id FROM scans s WHERE s.id=? AND (${fragment.sql})`, [
            s.scanId,
            ...fragment.params,
          ]),
        ),
      );
    expect((await check()).every((result) => result.results?.[0]?.id === s.scanId)).toBe(true);
    await run(
      kit.env.DB,
      `UPDATE pass_versions SET pass_json=json_set(pass_json,'$.userInfo.large',?)
      WHERE pass_id=? AND version=(SELECT max(v.version) FROM pass_versions v JOIN passes p ON p.id=v.pass_id
        WHERE v.pass_id=? AND v.version<=p.version)`,
      [`${'🙂'.repeat(199_999)}x`, s.pass.id, s.pass.id],
    );
    const changed = await check();
    expect(changed.some((result) => result.results?.[0]?.id === s.scanId)).toBe(true);
    expect(changed.some((result) => !result.results?.length)).toBe(true);
    expect(
      historyProofSnapshotPredicates(
        { ...proof, snapshot: { metadata: proof.snapshot.metadata } },
        's',
        kit.clock.now(),
      ),
    ).toEqual([{ sql: '0', params: [] }]);
    expect(historyProofSnapshotPredicates(proof, 's) OR 1=1 --', kit.clock.now())).toEqual([
      { sql: '0', params: [] },
    ]);
    expect(
      historyProofSnapshotPredicates(
        { ...proof, credentialKeysetCommitment: '' },
        's',
        kit.clock.now(),
      ),
    ).toEqual([{ sql: '0', params: [] }]);
  });

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
        (entry) =>
          entry.sql.includes('/* scan-history-proof-page */') && entry.values.length <= 100,
      ),
    ).toBe(true);
    const preloaded = await plan.finish(await recorder.db.batch(plan.stmts));
    if (!preloaded) throw new Error('Missing preloaded history');
    expect(JSON.stringify(preloaded)).not.toContain(s.pass.authToken);
    const display = await prepareDisplayHistory(ctx, actor, found, needs, preloaded);
    const now = kit.clock.now();
    const authority = outputAuthorityPredicate({
      actor,
      event: actor.event,
      now,
      templateId: found.pass.templateId,
      pass: candidate.pass,
      connectionGeneration: candidate.connectionGeneration,
      activeTemplateVersion: candidate.activeTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      release: candidate,
      displayTemplateVersion: candidate.displayTemplateVersion,
      checkInRules: candidate.checkInRules,
      lookupHash: candidate.lookupHash,
      requireActive: true,
      credentialTombstoneRefs: [],
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
    });
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
    expect(complete?.proofs.size).toBe(1);
    expect(complete?.proofs.has(s.scanId)).toBe(true);
    expect(
      recorder.prepared.filter((entry) => entry.sql.includes('/* scan-history-proof-page */')),
    ).toHaveLength(2);
    const batched = planDisplayHistoryRead(ctx, actor, found, needs, 102);
    expect(batched.stmts).toHaveLength(2);
    const allPages = await batched.finish(await recorder.db.batch(batched.stmts));
    if (!allPages) throw new Error('Missing batched history pages');
    const combined = await consumeDisplayHistoryRead(allPages, actor, found, needs);
    expect(combined?.ids).toHaveLength(102);
    expect(combined?.proofs.size).toBe(1);
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
        (entry) =>
          entry.sql.includes('/* scan-history-proof-pending */') && entry.values.length <= 100,
      ),
    ).toBe(true);
    expect(
      await preparePlannedDisplayHistoryProof({} as never, actor, found, {} as never, {} as never),
    ).toBeNull();
  });
});
