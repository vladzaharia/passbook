import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { first, run, stmt } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createPassRow } from './create.ts';
import { MAX_CAS_ATTEMPTS, publishPass } from './publish.ts';
import { backfillScanKeys } from './repo-write.ts';
import { lookupHashOf } from './scan-code.ts';
import { ICON_PNG, type Kit, setupKit } from './test-kit.ts';

let kit: Kit;
let lookupTemplateId: string;
const actor = { type: 'user', id: 'u1' } as const;

beforeAll(async () => {
  kit = await setupKit();
  await kit.env.DB.exec(
    'CREATE TABLE hook_probe (pass_id TEXT NOT NULL, object_key TEXT NOT NULL, version INTEGER NOT NULL)',
  );
  const base = kit.template;
  const resolved = kit.registry.add({
    id: 'tpl-lookup',
    manifest: {
      ...base.manifest,
      name: 'Lookup template',
      scan: {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
        lookup: { input: 'memberName' },
      },
      bindings: [
        ...base.manifest.bindings,
        { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
      ],
    },
    passJson: {
      ...base.passJson,
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'iso-8859-1' }],
    } as PassJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, resolved);
  lookupTemplateId = resolved.id;
});

const make = (memberName = 'Ab-12 / 34', templateId = lookupTemplateId) =>
  createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId,
    input: { memberName },
    source: 'manual',
    actor: { type: 'system', id: null },
  });

const lookupOf = async (passId: string) =>
  (
    await first<{ h: string | null }>(
      kit.env.DB,
      'SELECT lookup_hash AS h FROM passes WHERE id = ?',
      [passId],
    )
  )?.h ?? null;

const probeRows = async (passId: string) =>
  (
    await kit.env.DB.prepare('SELECT * FROM hook_probe WHERE pass_id = ?')
      .bind(passId)
      .all<{ object_key: string; version: number }>()
  ).results;

/** A hooked statement guards itself on the pass still pointing at the object this publish wrote. */
const probe = (passId: string) => (w: { objectKey: string; version: number }) => [
  stmt(
    kit.env.DB,
    `INSERT INTO hook_probe (pass_id, object_key, version)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM passes WHERE id = ? AND object_key = ?)`,
    [passId, w.objectKey, w.version, passId, w.objectKey],
  ),
];

describe('publish commit hook (C5)', () => {
  it('runs a hooked statement with the new object key and version when the CAS wins', async () => {
    const pass = await make();
    const { pass: next } = await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor,
      mutate: () => ({ personalization: { memberName: 'Changed' } }),
      commit: probe(pass.id),
    });
    const rows = await probeRows(pass.id);
    expect(rows).toEqual([{ pass_id: pass.id, object_key: next.objectKey, version: next.version }]);
    expect(next.version).toBe(pass.version + 1);
  });

  it('runs a hooked statement on a metadata-only write too', async () => {
    const pass = await make('Meta');
    await run(kit.env.DB, 'UPDATE passes SET content_hash = NULL WHERE id = ?', [pass.id]);
    const { pass: next, changed } = await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor,
      commit: probe(pass.id),
    });
    expect(changed).toBe(false);
    expect(await probeRows(pass.id)).toEqual([
      { pass_id: pass.id, object_key: next.objectKey, version: next.version },
    ]);
  });

  it('writes nothing when all three CAS attempts lose', async () => {
    const pass = await make('Loser');
    // Another writer wins between the read and the swap, on every attempt.
    const resolve = kit.registry.resolve.bind(kit.registry);
    kit.registry.resolve = async (id, version) => {
      await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
      return resolve(id, version);
    };
    try {
      await expect(
        publishPass(kit.ctx, {
          passId: pass.id,
          cause: 'admin',
          actor,
          mutate: () => ({ personalization: { memberName: 'Loser changed' } }),
          commit: probe(pass.id),
        }),
      ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    } finally {
      kit.registry.resolve = resolve;
    }
    expect(MAX_CAS_ATTEMPTS).toBe(3);
    expect(await probeRows(pass.id)).toEqual([]);
  });

  it('a hooked statement whose guard fails writes nothing', async () => {
    const pass = await make('Guard');
    await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor,
      mutate: () => ({ personalization: { memberName: 'Guarded' } }),
      commit: (w) => probe(pass.id)({ ...w, objectKey: `${w.objectKey}-other` }),
    });
    expect(await probeRows(pass.id)).toEqual([]);
  });
});

describe('lookup hash (C7)', () => {
  it('equals lookupHashOf(input value) at creation', async () => {
    const pass = await make('Ab-12 / 34');
    expect(await lookupOf(pass.id)).toBe(await lookupHashOf('Ab-12 / 34'));
    expect(await lookupOf(pass.id)).toBe(await sha256Hex(normalizeLookup('ab 12.34')));
  });

  it('follows the input on publish', async () => {
    const pass = await make('First 1');
    await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor,
      mutate: () => ({ personalization: { memberName: 'Second 2' } }),
    });
    expect(await lookupOf(pass.id)).toBe(await lookupHashOf('second2'));
  });

  it('follows the input on a metadata-only write', async () => {
    const pass = await make('Meta 1');
    // Same rendered pass, different stored input: casMeta.
    await run(kit.env.DB, 'UPDATE passes SET lookup_hash = NULL WHERE id = ?', [pass.id]);
    await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor,
      mutate: () => ({ personalization: { memberName: 'Meta 1', extra: 'x' } as never }),
    });
    expect(await lookupOf(pass.id)).toBe(await lookupHashOf('meta1'));
  });

  it('stays NULL without scan.lookup', async () => {
    const pass = await kit.pass();
    expect(await lookupOf(pass.id)).toBeNull();
  });
});

describe('backfillScanKeys', () => {
  const mint = () => 'M'.repeat(26);

  const clear = (id: string) =>
    run(
      kit.env.DB,
      'UPDATE passes SET scan_code = NULL, barcode_hash = NULL, lookup_hash = NULL WHERE id = ?',
      [id],
    );

  it('fills scan_code, barcode_hash and lookup_hash, then finds nothing left', async () => {
    const pass = await make('Back 9');
    await clear(pass.id);
    let n = 0;
    const count = await backfillScanKeys(kit.env.DB, 1000, () => `CODE${n++}`.padEnd(26, 'A'));
    expect(count).toBeGreaterThanOrEqual(1);
    const row = await first<{ s: string; b: string; l: string }>(
      kit.env.DB,
      'SELECT scan_code s, barcode_hash b, lookup_hash l FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.s).toMatch(/^CODE\d+A+$/);
    // The pass was built with its old scan code as barcode message: the hash is of that message.
    const json = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    );
    const message = (JSON.parse(json?.pass_json ?? '{}') as PassJson).barcodes?.[0]?.message;
    expect(row?.b).toBe(await sha256Hex(message ?? ''));
    expect(row?.l).toBe(await lookupHashOf('Back 9'));
    expect(await backfillScanKeys(kit.env.DB, 1000, mint)).toBe(0);
  });

  it('leaves a removed pass without a barcode hash', async () => {
    const pass = await make('Gone 1');
    await clear(pass.id);
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [Date.now(), pass.id]);
    await backfillScanKeys(kit.env.DB, 1000, () => 'R'.repeat(26));
    const row = await first<{ s: string | null; b: string | null; l: string | null }>(
      kit.env.DB,
      'SELECT scan_code s, barcode_hash b, lookup_hash l FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.b).toBeNull();
    expect(row?.s).toBe('R'.repeat(26));
    expect(row?.l).toBe(await lookupHashOf('Gone 1'));
  });

  it('respects the limit', async () => {
    for (const n of ['Lim 1', 'Lim 2', 'Lim 3']) await clear((await make(n)).id);
    let n = 0;
    const count = await backfillScanKeys(kit.env.DB, 2, () => `L${n++}`.padEnd(26, 'Z'));
    expect(count).toBe(2);
  });

  it('does not rewrite a pass that has every key', async () => {
    const pass = await make('Keep 1');
    const before = await first<{ s: string }>(
      kit.env.DB,
      'SELECT scan_code s FROM passes WHERE id = ?',
      [pass.id],
    );
    await backfillScanKeys(kit.env.DB, 1000, mint);
    const after = await first<{ s: string }>(
      kit.env.DB,
      'SELECT scan_code s FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(after?.s).toBe(before?.s);
  });
});
