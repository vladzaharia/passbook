import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { credentialTombstoneRef } from '../passes/credential-tombstones.ts';
import {
  credentialTombstonesClear,
  credentialTombstonesClearStmt,
  noCredentialTombstonesSql,
  validCredentialTombstoneRefs,
} from './repo-credential-tombstones.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let retiredRef: string;
let passId: string;
let credentialKeysetCommitment: string;

beforeAll(async () => {
  kit = await setupScanKit();
  credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const templateId = await kit.scanTemplate('Credential tombstone scope', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const pass = await kit.scanPass(templateId);
  passId = pass.id;
  retiredRef = await credentialTombstoneRef(
    kit.env,
    pass.orgId,
    pass.mode,
    await sha256Hex(pass.serial),
  );
  const transferId = kit.fx.ids.id();
  await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
    id: transferId,
    token: kit.fx.ids.token(),
    now: kit.clock.now(),
    targetHolderEmail: 'after@example.test',
  });
  await run(
    kit.env.DB,
    `INSERT INTO pass_credential_tombstones
    (pass_id,org_id,mode,credential_generation,credential_kind,credential_hash,retired_at)
    SELECT pass_id,org_id,mode,source_generation,'serial',?,? FROM pass_credential_transfers WHERE id=?`,
    [retiredRef, kit.clock.now(), transferId],
  );
});

describe('scanner credential tombstone authority', () => {
  it('fences retired refs across credential kinds in the original tenant and mode', async () => {
    const fresh = await credentialTombstoneRef(
      kit.env,
      kit.org.id,
      'live',
      await sha256Hex('fresh-credential'),
    );
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        [fresh],
        credentialKeysetCommitment,
      ),
    ).toBe(true);
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        [fresh, retiredRef],
        credentialKeysetCommitment,
      ),
    ).toBe(false);
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'test',
        [retiredRef],
        credentialKeysetCommitment,
      ),
    ).toBe(true);
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        'other-org',
        'live',
        [retiredRef],
        credentialKeysetCommitment,
      ),
    ).toBe(true);

    const predicate = noCredentialTombstonesSql(
      [fresh, retiredRef],
      { orgIdSql: '?', modeSql: '?' },
      credentialKeysetCommitment,
    );
    expect(predicate.params).toEqual([
      JSON.stringify([fresh, retiredRef]),
      credentialKeysetCommitment,
    ]);
    expect(
      await first(kit.env.DB, `SELECT 1 WHERE ${predicate.sql}`, [
        kit.org.id,
        'live',
        ...predicate.params,
      ]),
    ).toBeNull();
  });

  it('allows the same scoped checks to share an atomic batch with a pass read', async () => {
    const db = kit.env.DB;
    const result = await db.batch([
      db.prepare('SELECT id FROM passes WHERE id=?').bind(passId),
      credentialTombstonesClearStmt(
        db,
        kit.org.id,
        'live',
        [retiredRef],
        credentialKeysetCommitment,
      ),
      credentialTombstonesClearStmt(
        db,
        kit.org.id,
        'test',
        [retiredRef],
        credentialKeysetCommitment,
      ),
      credentialTombstonesClearStmt(db, kit.org.id, 'live', [], credentialKeysetCommitment),
      credentialTombstonesClearStmt(db, kit.org.id, 'live', ['bad'], credentialKeysetCommitment),
    ]);
    expect(result.map((row) => row.results?.length)).toEqual([1, 0, 1, 1, 0]);
  });

  it('fails closed for absent, malformed or oversized snapshots while accepting an explicit empty set', async () => {
    const scope = { orgIdSql: '?', modeSql: '?' };
    for (const refs of [
      undefined,
      null,
      ['not-a-hash'],
      [`A${retiredRef.slice(1)}`],
      Array(4).fill(retiredRef),
    ]) {
      expect(noCredentialTombstonesSql(refs, scope, credentialKeysetCommitment)).toEqual({
        sql: '0',
        params: [],
      });
    }
    expect(validCredentialTombstoneRefs([42])).toBe(false);
    expect(noCredentialTombstonesSql([], scope, credentialKeysetCommitment).params).toEqual([
      credentialKeysetCommitment,
    ]);
    expect(noCredentialTombstonesSql([], scope, undefined)).toEqual({ sql: '0', params: [] });
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        [],
        credentialKeysetCommitment,
      ),
    ).toBe(true);
    const mismatched = `${credentialKeysetCommitment[0] === '0' ? '1' : '0'}${credentialKeysetCommitment.slice(1)}`;
    expect(await credentialTombstonesClear(kit.env.DB, kit.org.id, 'live', [], mismatched)).toBe(
      false,
    );
    expect(
      await credentialTombstonesClear(
        kit.env.DB,
        kit.org.id,
        'live',
        ['bad'],
        credentialKeysetCommitment,
      ),
    ).toBe(false);
  });
});
