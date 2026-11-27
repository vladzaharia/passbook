import { expect, it, vi } from 'vitest';
import { all, first, run, type SqlValue } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { publishRelease, routeFetchToMock } from './google-runtime-test-fixtures.ts';
import { offerPassSnapshot } from './offers-eligibility.ts';
import { legacyWalletOfferSnapshotCurrent } from './offers-legacy-test-fixtures.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import {
  legacyProjectionReleaseBindingPredicateSql,
  withLegacyProjection,
} from './projection-legacy-test-fixtures.ts';
import { getApprovedProjection } from './projection-service.ts';
import {
  walletInstanceOperationCurrentSql,
  walletInstanceProofSql,
} from './repo-instance-proof.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';
import { type WalletOfferFence, walletOfferSnapshotCurrent } from './repo-offers.ts';
import { projectionReleaseBindingPredicateSql } from './repo-projection.ts';
import {
  seedHistoricalOfferRef,
  seedHistoricalProviderInstance,
} from './runtime-historical-fixtures.ts';

/** Only the recipient-market denial is modeled as satisfied; every other fence stays. */
function marketFence(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) =>
          target.prepare(
            sql.includes('-- Single SQL form of the provider policy gate')
              ? sql.replace('AND 1 = 0', 'AND 1 = 1')
              : sql,
          );
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

it('reads each CTE once and answers like the previous offer snapshot statement', async () => {
  const f = await setupWalletOfferKit({ google: 'absent' });
  const db = marketFence(f.kit.env.DB);
  const snapshot = await offerPassSnapshot(f.kit.ctx, f.pass.id);
  if (!snapshot?.pass.releaseId || !f.samsungRelease) throw new Error('Missing approved fixture');
  const approved = await getApprovedProjection(f.kit.ctx, {
    orgId: f.pass.orgId,
    mode: f.pass.mode,
    provider: 'samsung',
    templateId: f.pass.templateId,
    templateVersion: f.pass.templateVersion,
    appleReleaseId: snapshot.pass.releaseId,
  });
  if (!approved) throw new Error('Missing verified Samsung projection');
  const now = f.kit.clock.now();
  const operation = await seedHistoricalProviderInstance(db, {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    orgId: f.pass.orgId,
    mode: f.pass.mode,
    provider: 'samsung',
    passId: f.pass.id,
    credentialGeneration: snapshot.credentialGeneration,
    credentialKeysetCommitment: f.credentialKeysetCommitment,
    accountId: approved.release.accountId,
    releaseId: approved.release.id,
    now,
    upsert: { requestHash: await sha256Hex(crypto.randomUUID()), state: 'succeeded' },
  });
  if (!operation) throw new Error('Missing historical operation');
  const seedRef = async (refHash: string, consumedAt: number | null) =>
    seedHistoricalOfferRef(db, {
      refHash,
      instanceId: operation.instanceId,
      operationVersion: operation.version,
      createdAt: now,
      expiresAt: now + 300_000,
      consumedAt,
      deliveredAt: null,
    });
  const [pendingHash, consumedHash, deliverNew, deliverOld] = ['a', 'b', 'd', 'e'].map((c) =>
    c.repeat(64),
  ) as [string, string, string, string];
  await seedRef(pendingHash, null);
  await seedRef(consumedHash, now);
  await seedRef(deliverNew, now);
  await seedRef(deliverOld, now);
  const pending: WalletOfferFence = {
    refHash: pendingHash,
    instanceId: operation.instanceId,
    version: operation.version,
    now,
    consumed: false,
  };
  const consumed: WalletOfferFence = { ...pending, refHash: consumedHash, consumed: true };

  let trueCount = 0;
  const both = async (
    offer?: WalletOfferFence,
    changes: Partial<typeof snapshot> = {},
    releaseId = approved.release.id,
  ) => {
    const value = { ...snapshot, ...changes };
    const args = [
      value.pass,
      value.lifecycleGeneration,
      value.credentialGeneration,
      value.rawPassJson,
      'samsung',
      releaseId,
      now,
      offer,
    ] as const;
    const next = await walletOfferSnapshotCurrent(db, ...args);
    expect(next).toBe(await legacyWalletOfferSnapshotCurrent(db, ...args));
    if (next) trueCount++;
  };
  // The projection fence and the instance proof embedding it, current against legacy, on every state below.
  let trueProjection = 0;
  let trueProof = 0;
  const projectionScope = {
    releaseIdSql: 'requested.release_id',
    orgIdSql: 'requested.org_id',
    modeSql: 'requested.mode',
    providerSql: 'requested.provider',
    templateIdSql: 'requested.template_id',
    versionSql: 'requested.version',
    sourceReleaseIdSql: 'requested.source_id',
    nowSql: 'requested.now_ms',
    credentialKeysetCommitmentSql: 'requested.credential_keyset_commitment',
  };
  const baseScope = {
    release_id: approved.release.id as string | null,
    org_id: f.pass.orgId as string,
    mode: f.pass.mode as string,
    provider: 'samsung' as string,
    template_id: f.pass.templateId as string,
    version: f.pass.templateVersion as string | number,
    source_id: snapshot.pass.releaseId as string | null,
    now_ms: now as number | null,
  };
  const projectionDiffs = async () => {
    const other = (v: string) => `${v}-other`;
    const scopes = [
      baseScope,
      { ...baseScope, release_id: crypto.randomUUID() },
      { ...baseScope, org_id: other(baseScope.org_id) },
      { ...baseScope, mode: other(baseScope.mode) },
      { ...baseScope, provider: 'google' },
      { ...baseScope, template_id: other(baseScope.template_id) },
      { ...baseScope, version: `${baseScope.version}9` },
      { ...baseScope, source_id: crypto.randomUUID() },
      { ...baseScope, now_ms: null },
    ];
    for (const scope of scopes) {
      const read = (predicate: string) =>
        first(
          db,
          `SELECT 1 AS ok FROM (SELECT ? AS release_id, ? AS org_id, ? AS mode, ? AS provider,
            ? AS template_id, ? AS version, ? AS source_id, ? AS now_ms,
            ${pinnedKeysetSql} AS credential_keyset_commitment) requested WHERE ${predicate}`,
          Object.values(scope),
        );
      const next = await read(projectionReleaseBindingPredicateSql(projectionScope));
      expect(next).toEqual(await read(legacyProjectionReleaseBindingPredicateSql(projectionScope)));
      if (next) trueProjection++;
    }
    const now$ = String(now);
    for (const byEpoch of [false, true]) {
      for (const requiredKind of [undefined, 'revoke'] as const) {
        const proofs = [
          walletInstanceProofSql('i', 'op', now$, false, requiredKind, byEpoch),
          walletInstanceProofSql('i', 'op', now$, true, requiredKind, byEpoch),
          walletInstanceOperationCurrentSql('i', 'op', now$, requiredKind, byEpoch),
        ];
        for (const proof of proofs) {
          const read = (predicate: string) =>
            all<{ id: string }>(
              db,
              `SELECT op.id FROM wallet_provider_instances i
               JOIN wallet_provider_instance_operations op ON op.instance_id = i.id
               JOIN passes p ON p.id = i.pass_id WHERE ${predicate} ORDER BY op.id`,
            );
          const next = await read(proof);
          if (requiredKind !== 'revoke')
            expect(next).toEqual(await read(withLegacyProjection(proof, now$)));
          if (next.length > 0 && requiredKind !== 'revoke') trueProof++;
        }
      }
    }
  };
  const matrix = async () => {
    await projectionDiffs();
    for (const offer of [undefined, pending, consumed]) await both(offer);
    await both({ ...pending, consumed: true });
    await both({ ...pending, refHash: 'c'.repeat(64) });
    await both({ ...pending, instanceId: crypto.randomUUID() });
    await both({ ...pending, version: pending.version + 1 });
    await both({ ...pending, now: now + 300_000 });
    await both({ ...consumed, deliver: true, refHash: 'c'.repeat(64) });
    await both(pending, { lifecycleGeneration: snapshot.lifecycleGeneration + 1 });
    await both(pending, { credentialGeneration: snapshot.credentialGeneration + 1 });
    await both(pending, { rawPassJson: '{}' });
    for (const pass of [
      { ...snapshot.pass, version: snapshot.pass.version + 1 },
      { ...snapshot.pass, orgId: crypto.randomUUID() },
      { ...snapshot.pass, templateVersion: snapshot.pass.templateVersion + 1 },
      { ...snapshot.pass, releaseId: crypto.randomUUID() },
      { ...snapshot.pass, downloadToken: 'stale-token' },
      { ...snapshot.pass, holderEmail: 'different@example.test' },
    ])
      await both(pending, { pass });
    await both(pending, {}, crypto.randomUUID());
  };

  await matrix();
  expect(trueCount).toBeGreaterThan(2);
  expect(trueProjection).toBeGreaterThan(0);
  expect(trueProof).toBeGreaterThan(0);
  // Delivery: the guarded UPDATE of each statement flips only its own consumed ref.
  const deliveredAt = (hash: string) =>
    first(db, 'SELECT delivered_at FROM wallet_provider_offer_refs WHERE ref_hash = ?', [hash]);
  const args = [
    snapshot.pass,
    snapshot.lifecycleGeneration,
    snapshot.credentialGeneration,
    snapshot.rawPassJson,
    'samsung',
    approved.release.id,
    now,
  ] as const;
  const fence = (refHash: string) => ({ ...consumed, refHash, deliver: true });
  expect(await walletOfferSnapshotCurrent(db, ...args, fence(deliverNew))).toBe(true);
  expect(await legacyWalletOfferSnapshotCurrent(db, ...args, fence(deliverOld))).toBe(true);
  expect(await deliveredAt(deliverNew)).toEqual(await deliveredAt(deliverOld));
  expect(await deliveredAt(deliverNew)).toEqual({ delivered_at: now });
  expect(await walletOfferSnapshotCurrent(db, ...args, fence(deliverNew))).toBe(false);
  expect(await legacyWalletOfferSnapshotCurrent(db, ...args, fence(deliverOld))).toBe(false);

  for (const sql of [
    "UPDATE wallet_provider_instance_operations SET state = 'failed' WHERE id = ?",
    "UPDATE wallet_provider_instance_operations SET state = 'succeeded' WHERE id = ?",
  ]) {
    await run(db, sql, [operation.id]);
    await matrix();
  }
  await run(
    db,
    `INSERT INTO wallet_provider_pass_authority (pass_id, generation) VALUES (?, 1)
     ON CONFLICT(pass_id) DO UPDATE SET generation = generation + 1`,
    [f.pass.id],
  );
  await matrix();
  await run(db, 'UPDATE wallet_provider_instances SET retirement_requested_at = ? WHERE id = ?', [
    now,
    operation.instanceId,
  ]);
  await matrix();
});

it('projection fence matches legacy under row mutations', async () => {
  const f = await setupWalletOfferKit({ google: 'configured' });
  const db = marketFence(f.kit.env.DB);
  const snapshot = await offerPassSnapshot(f.kit.ctx, f.pass.id);
  if (!snapshot?.pass.releaseId) throw new Error('Missing approved fixture');
  routeFetchToMock();
  try {
    await publishRelease(f, 0);
  } finally {
    vi.unstubAllGlobals();
  }
  const now = f.kit.clock.now();
  const scope = {
    releaseIdSql: 'requested.release_id',
    orgIdSql: 'requested.org_id',
    modeSql: 'requested.mode',
    providerSql: 'requested.provider',
    templateIdSql: 'requested.template_id',
    versionSql: 'requested.version',
    sourceReleaseIdSql: 'requested.source_id',
    nowSql: 'requested.now_ms',
    credentialKeysetCommitmentSql: 'requested.credential_keyset_commitment',
  };
  const releases = [] as {
    provider: string;
    id: string;
    candidateId: string;
    approvalId: string;
  }[];
  for (const provider of ['samsung', 'google']) {
    const row = await first<{ id: string; candidateId: string; approvalId: string }>(
      db,
      `SELECT id, candidate_id AS candidateId, approval_id AS approvalId FROM template_releases
       WHERE org_id = ? AND provider = ? AND template_id = ?`,
      [f.pass.orgId, provider, f.pass.templateId],
    );
    if (!row) throw new Error(`Missing ${provider} release`);
    releases.push({ provider, ...row });
  }
  const answers = async () => {
    const out: (number | null)[] = [];
    for (const release of releases) {
      const params = [
        release.id,
        f.pass.orgId,
        f.pass.mode,
        release.provider,
        f.pass.templateId,
        f.pass.templateVersion,
        snapshot.pass.releaseId,
        now,
      ];
      const read = (predicate: string) =>
        first<{ ok: number }>(
          db,
          `SELECT 1 AS ok FROM (SELECT ? AS release_id, ? AS org_id, ? AS mode, ? AS provider,
            ? AS template_id, ? AS version, ? AS source_id, ? AS now_ms,
            ${pinnedKeysetSql} AS credential_keyset_commitment) requested WHERE ${predicate}`,
          params,
        );
      const next = await read(projectionReleaseBindingPredicateSql(scope));
      expect(next, `${release.provider} release`).toEqual(
        await read(legacyProjectionReleaseBindingPredicateSql(scope)),
      );
      out.push(next ? 1 : null);
    }
    return out;
  };
  expect(await answers()).toEqual([1, 1]);

  // The guards refuse these edits in production; the worker test setup restores them after the test.
  const guards = await all<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (
      'wallet_provider_accounts', 'template_candidates', 'template_provider_apple_sources',
      'template_approvals', 'template_releases')`,
  );
  for (const { name } of guards) await run(db, `DROP TRIGGER IF EXISTS "${name}"`);

  const columnsOf = async (table: string, where: string, id: string, columns: string[]) =>
    first<Record<string, SqlValue>>(
      db,
      `SELECT ${columns.join(', ')} FROM ${table} WHERE ${where}`,
      [id],
    );
  /** Sets columns on one row, reads both fences, and puts the original values back. */
  const mutated = async (
    table: string,
    where: string,
    id: string,
    set: Record<string, SqlValue>,
  ) => {
    const columns = Object.keys(set);
    const before = await columnsOf(table, where, id, columns);
    if (!before) throw new Error(`Missing ${table} row`);
    const assign = columns.map((c) => `${c} = ?`).join(', ');
    await run(db, `UPDATE ${table} SET ${assign} WHERE ${where}`, [...Object.values(set), id]);
    try {
      return await answers();
    } finally {
      await run(db, `UPDATE ${table} SET ${assign} WHERE ${where}`, [...Object.values(before), id]);
    }
  };
  const perRelease = async (
    table: string,
    key: 'id' | 'candidateId' | 'approvalId',
    set: (provider: string) => Record<string, SqlValue>,
    column = 'id',
  ) => {
    const result: (number | null)[][] = [];
    for (const release of releases)
      result.push(await mutated(table, `${column} = ?`, release[key], set(release.provider)));
    return result;
  };
  const accountOf = async (candidateId: string) =>
    (
      await first<{ id: string }>(
        db,
        'SELECT provider_account_id AS id FROM template_candidates WHERE id = ?',
        [candidateId],
      )
    )?.id ?? '';
  const authorOf = async (candidateId: string) =>
    (
      await first<{ id: string }>(
        db,
        'SELECT author_id AS id FROM template_candidates WHERE id = ?',
        [candidateId],
      )
    )?.id ?? '';
  const [samsung, google] = releases as [(typeof releases)[number], (typeof releases)[number]];

  // Each mutation breaks exactly the release it touches, and both fences agree on every state.
  const accountRevoked = async (r: (typeof releases)[number]) =>
    mutated('wallet_provider_accounts', 'id = ?', await accountOf(r.candidateId), {
      revoked_at: 1,
    });
  expect(await accountRevoked(samsung)).toEqual([null, 1]);
  expect(await accountRevoked(google)).toEqual([1, null]);

  for (const projection of ['{', '[]', '"x"'])
    expect(
      await perRelease('template_candidates', 'candidateId', () => ({
        projection_json: projection,
      })),
    ).toEqual([
      [null, 1],
      [1, null],
    ]);
  expect(
    await perRelease('template_candidates', 'candidateId', () => ({ adapter_revision: 999 })),
  ).toEqual([
    [null, 1],
    [1, null],
  ]);

  // The Apple source is a view over its release, so its generation and hash are checked as the candidate records them.
  for (const set of [
    { source_release_generation: 999 },
    { source_release_hash: 'f'.repeat(64) },
    { content_hash: 'f'.repeat(64) },
  ])
    expect(await perRelease('template_candidates', 'candidateId', () => set)).toEqual([
      [null, 1],
      [1, null],
    ]);

  // Approval independence: a peer approval by the candidate's own author does not stand, a sole one does.
  for (const release of releases) {
    const author = await authorOf(release.candidateId);
    const own = await mutated('template_approvals', 'id = ?', release.approvalId, {
      kind: 'peer',
      reviewer_id: author,
    });
    expect(own).toEqual(release === samsung ? [null, 1] : [1, null]);
    const sole = await mutated('template_approvals', 'id = ?', release.approvalId, {
      kind: 'sole',
      reviewer_id: author,
    });
    expect(sole).toEqual([1, 1]);
  }

  // A superseded head: a newer generation of the same release line leaves this release without its head row.
  for (const release of releases) {
    const row = await first<Record<string, SqlValue>>(
      db,
      'SELECT * FROM template_releases WHERE id = ?',
      [release.id],
    );
    if (!row) throw new Error('Missing release row');
    const newer = { ...row, id: crypto.randomUUID(), generation: Number(row.generation) + 1 };
    const names = Object.keys(newer);
    await run(
      db,
      `INSERT INTO template_releases (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      Object.values(newer),
    );
    try {
      expect(await answers()).toEqual(release === samsung ? [null, 1] : [1, null]);
    } finally {
      await run(db, 'DELETE FROM template_releases WHERE id = ?', [newer.id]);
    }
  }
  expect(await answers()).toEqual([1, 1]);
  expect(google.id).not.toBe(samsung.id);
});
