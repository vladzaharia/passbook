import { describe, expect, it } from 'vitest';
import {
  assetGrant,
  envA,
  expectKeysetInitializationBlocked,
  installKeysetTestEnv,
  retainedClaimWithoutKeyset,
} from '../../../../test/helpers/credential-keyset.ts';
import { fixtures, makeOrg, makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { credentialRefKeysetCommitment, ensureCredentialRefKeyset } from './credential-keyset.ts';
import { credentialRefKeysetInitializeStmt } from './repo-credential-keyset.ts';

const makeEnv = installKeysetTestEnv();

describe.sequential('credential keyset legacy references', () => {
  it.each(['[]', JSON.stringify(['d'.repeat(64)])])(
    'fails closed on a preexisting asset grant with refs %s',
    async (refs) => {
      const f = fixtures(await makeEnv());
      const org = await makeOrg(f);
      await assetGrant(f.env.DB, org.id, refs);
      await expectKeysetInitializationBlocked(f.env.DB);
    },
  );

  it('fails closed on a preexisting retained connection claim', async () => {
    const { DB: db } = await makeEnv();
    await retainedClaimWithoutKeyset(db);
    await expectKeysetInitializationBlocked(db);
  });

  it.each([['claim snapshot', JSON.stringify({ refHash: 'c'.repeat(64) })]])(
    'blocks isolated connection item %s',
    async (_description, claim) => {
      const { DB: db } = await makeEnv();
      const commitment = await credentialRefKeysetCommitment(envA);
      // Defer the parent FK only within the batch, so the item predicate is tested independently
      // of the retention-row predicate. Remove the item before commit or roll back on rejection.
      const insertItem = () =>
        stmt(
          db,
          `INSERT INTO connection_webhook_items
        (retention_id, ordinal, state, release_snapshot, prior_unknown, claim_snapshot)
        VALUES ('transient', 0, 'pending', '{}', 0, ?)`,
          [claim],
        );
      const [, , initialized, state] = await db.batch<{
        items: number;
        parents: number;
        keysets: number;
      }>([
        stmt(db, 'PRAGMA defer_foreign_keys = ON'),
        insertItem(),
        credentialRefKeysetInitializeStmt(db, commitment),
        stmt(
          db,
          `SELECT (SELECT COUNT(*) FROM connection_webhook_items) AS items,
          (SELECT COUNT(*) FROM connection_webhook_retention) AS parents,
          (SELECT COUNT(*) FROM credential_ref_keyset) AS keysets`,
        ),
        stmt(db, "DELETE FROM connection_webhook_items WHERE retention_id = 'transient'"),
      ]);
      expect(initialized?.meta.changes).toBe(0);
      expect(state?.results).toEqual([{ items: 1, parents: 0, keysets: 0 }]);
      await expect(
        db.batch([
          stmt(db, 'PRAGMA defer_foreign_keys = ON'),
          insertItem(),
          stmt(db, 'INSERT INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
            commitment,
          ]),
        ]),
      ).rejects.toThrow('credential reference keyset cannot be initialized');
      expect(await first(db, 'SELECT COUNT(*) AS n FROM connection_webhook_items')).toEqual({
        n: 0,
      });
      expect(await first(db, 'SELECT COUNT(*) AS n FROM credential_ref_keyset')).toEqual({ n: 0 });
    },
  );

  it('fails closed on a retained webhook even without an item claim', async () => {
    const { DB: db } = await makeEnv();
    await retainedClaimWithoutKeyset(db);
    await run(db, "DELETE FROM connection_webhook_items WHERE retention_id = 'r'");
    await expectKeysetInitializationBlocked(db);
  });

  it('fails closed on a stored connection workflow key commitment', async () => {
    const { DB: db } = await makeEnv();
    await run(
      db,
      `INSERT INTO workflow_runs
      (instance_id, kind, status, started_at, credential_keyset_commitment)
      VALUES ('legacy-workflow', 'connection_sync', 'running', 1, ?)`,
      ['f'.repeat(64)],
    );
    await expectKeysetInitializationBlocked(db);
  });

  it.each([
    ['keyset commitment', { authority: { credentialKeysetCommitment: 'f'.repeat(64) } }],
    ['legacy event proof', { authority: { eventProof: { mac: 'f'.repeat(64) } } }],
    ['legacy action reference', { actionIdRef: 'f'.repeat(64) }],
    ['scanner CSRF proof', { authority: { scannerCsrfProof: 'f'.repeat(43) } }],
    ['session CSRF proof', { authority: { sessionCsrfProof: 'f'.repeat(43) } }],
    [
      'nested title commitment',
      { authority: { eventProjection: { roles: { manager: { titleHash: 'f'.repeat(64) } } } } },
    ],
    [
      'nested scanner commitment',
      { authority: { eventProjection: { roles: { desk: { scannerNameHash: 'f'.repeat(64) } } } } },
    ],
    [
      'nested action commitment',
      {
        authority: {
          eventProjection: { roles: { gate: { action: { labelHash: 'f'.repeat(64) } } } },
        },
      },
    ],
    ['unknown credential refs', { legacy: { scannerRefs: ['f'.repeat(64)] } }],
    ['unknown token', { legacy: { customToken: 'opaque' } }],
    ['unknown MAC', { legacy: { customMac: 'opaque' } }],
  ])('fails closed on a persisted scan-event %s', async (_description, data) => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const { resolved: template, registry } = makeTemplate();
    const pass = await makePass(f, { orgId: org.id, template, registry });
    await run(
      f.env.DB,
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
      VALUES (?, ?, ?, 'live', 'scan.checked_in', ?, ?)`,
      [f.ids.id(), org.id, pass.id, JSON.stringify(data), f.clock.now()],
    );
    await expectKeysetInitializationBlocked(f.env.DB);
  });

  it('blocks every sensitive scan-event field pattern for either initialization path', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const { resolved: template, registry } = makeTemplate();
    const pass = await makePass(f, { orgId: org.id, template, registry });
    const fields: Array<readonly [string, unknown]> = [
      ...[
        'legacyRef',
        'legacyRefs',
        'legacyReference',
        'legacyReferences',
        'legacyReferenceCode',
        'legacyHashValue',
        'legacyProofValue',
        'legacySecretValue',
        'legacyTokenValue',
        'legacyKeysetValue',
        'legacySignatureValue',
        'legacyNonceValue',
        'legacyApiKeyValue',
        'legacyPrivateKeyValue',
        'legacyPasswordValue',
        'legacyPasscodeValue',
        'legacyScanCodeValue',
        'legacyBarcodeValue',
        'legacySerialNumberValue',
        'legacyCsrfValue',
        'Credential',
        'CREDENTIALS',
        'PIN',
        'legacyCredentialValue',
        'legacyCredentialData',
        'legacyStaffPin',
        'legacyHmacValue',
        'legacyMac',
        'legacyMacs',
      ].map((name) => [name, 'opaque'] as const),
      ['legacySecretValue', {}],
      ['legacyRefs', []],
    ];
    for (const [name, value] of fields) {
      const id = f.ids.id();
      await run(
        f.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
        VALUES (?, ?, ?, 'live', 'scan.checked_in', ?, ?)`,
        [id, org.id, pass.id, JSON.stringify({ legacy: { [name]: value } }), f.clock.now()],
      );
      await expectKeysetInitializationBlocked(f.env.DB);
      await run(f.env.DB, 'DELETE FROM pass_events WHERE id = ?', [id]);
    }
  }, 30_000);

  it('blocks the explicit legacy authority paths on non-scan events, including JSON nulls', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const { resolved: template, registry } = makeTemplate();
    const pass = await makePass(f, { orgId: org.id, template, registry });
    for (const data of [
      { authority: { credentialKeysetCommitment: null } },
      { authority: { eventProof: null } },
      { actionIdRef: null },
      { authority: { scannerCsrfProof: 'opaque' } },
      { authority: { sessionCsrfProof: 'opaque' } },
    ]) {
      const id = f.ids.id();
      await run(
        f.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
        VALUES (?, ?, ?, 'live', 'pass.updated', ?, ?)`,
        [id, org.id, pass.id, JSON.stringify(data), f.clock.now()],
      );
      await expectKeysetInitializationBlocked(f.env.DB);
      await run(f.env.DB, 'DELETE FROM pass_events WHERE id = ?', [id]);
    }
  });

  it('permits bootstrap over unsigned legacy scan rows with absent or null CSRF proofs', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const { resolved: template, registry } = makeTemplate();
    const pass = await makePass(f, { orgId: org.id, template, registry });
    for (const data of [
      {},
      { legacy: { customRef: null, customProof: false, customToken: 3 } },
      {
        actorKey: 's:legacy',
        reason: 'not_found',
        legacyTokenCount: 2,
        tokenPresent: false,
        nonceVersion: 1,
        authority: {
          scannerCsrfProof: null,
          sessionCsrfProof: null,
          credentialGeneration: 1,
          noPendingTransfer: true,
          eventProjection: {
            roles: {
              manager: {
                scannerNameHash: null,
                titleHash: null,
                action: { kind: 'check_in', labelHash: null },
              },
            },
          },
        },
      },
    ]) {
      await run(
        f.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
        VALUES (?, ?, ?, 'live', 'scan.rejected', ?, ?)`,
        [f.ids.id(), org.id, pass.id, JSON.stringify(data), f.clock.now()],
      );
    }
    await run(
      f.env.DB,
      `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
      VALUES (?, ?, ?, 'live', 'pass.updated', ?, ?)`,
      [
        f.ids.id(),
        org.id,
        pass.id,
        JSON.stringify({ legacy: { customToken: 'opaque' } }),
        f.clock.now(),
      ],
    );
    expect(await ensureCredentialRefKeyset(f.env.DB, envA)).toBe(
      await credentialRefKeysetCommitment(envA),
    );
  });
});
