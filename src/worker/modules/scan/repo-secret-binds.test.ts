import { beforeAll, describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { packScanPredicate, scanSecretSlots } from './repo-secret-binds.ts';

let env: AppEnv;
beforeAll(async () => {
  env = await makeEnv();
});

describe('structurally labeled scan SQL binds', () => {
  it('keeps repeated secret scalars outside metadata JSON through nested packing', async () => {
    const secret = 'private-token?with-json-"content';
    const sql = `? = 7 AND ?/* scan-ephemeral-download-token */ = ?/* scan-ephemeral-download-token */
      AND '?' = '?' /* ordinary ? comment */ AND ? = 9`;
    const inner = packScanPredicate(sql, [7, secret, secret, 9], 'inner_snapshot');
    if (!inner) throw new Error('Missing inner predicate');
    expect(inner.params).toEqual(['[7,9]', secret, secret]);
    expect(inner.sql).toContain('scan-ephemeral-download-token');
    const outer = packScanPredicate(
      `(${inner.sql}) AND ? = 1`,
      [...inner.params, 1],
      'outer_snapshot',
    );
    if (!outer) throw new Error('Missing outer predicate');
    expect(outer.params[0]).not.toContain(secret);
    expect(outer.params.slice(1)).toEqual([secret, secret]);
    expect(await first(env.DB, `SELECT (${outer.sql}) AS valid`, outer.params)).toEqual({
      valid: 1,
    });
  });

  it('keeps independently labeled source and recipient secrets in positional order', async () => {
    const sql = `?/* scan-ephemeral-csrf:source:scanner */ = 'source-secret'
      AND ?/* scan-ephemeral-csrf:recipient:session */ = 'recipient-secret'`;
    const packed = packScanPredicate(sql, ['source-secret', 'recipient-secret'], 'authority');
    if (!packed) throw new Error('Missing predicate');
    expect(packed.params).toEqual(['[]', 'source-secret', 'recipient-secret']);
    expect(await first(env.DB, `SELECT (${packed.sql}) AS valid`, packed.params)).toEqual({
      valid: 1,
    });
  });

  it('fails closed for unknown or unattached labels, malformed SQL, and mismatched binds', () => {
    expect(
      packScanPredicate('?/* scan-ephemeral-unregistered */ = 1', ['secret'], 'safe'),
    ).toBeNull();
    expect(packScanPredicate('? = 1 /* scan-ephemeral-csrf */', [1], 'safe')).toBeNull();
    expect(packScanPredicate('?/*scan-ephemeral-csrf*/ = 1', [1], 'safe')).toBeNull();
    expect(packScanPredicate('?1 = 1', [1], 'safe')).toBeNull();
    expect(packScanPredicate('? = ?', [1], 'safe')).toBeNull();
    expect(packScanPredicate('? = 1', [1], 'unsafe alias')).toBeNull();
    expect(scanSecretSlots("'unterminated ?", 0)).toBeNull();
  });
});
