import { beforeAll, describe, expect, it } from 'vitest';
import { makePass, persistTemplate, withoutTrigger } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { normalizeLookup } from '../../../shared/scan-lookup.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import type { TemplateRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { buildArtifact } from './builder.ts';
import { createPassRow } from './create.ts';
import { credentialReferences } from './credential-references.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getOrg } from './repo-read-issuance.ts';
import { getPass } from './repo-read-pass.ts';
import { backfillScanKeys } from './repo-write-backfill.ts';
import { lookupHashOf, newScanCode } from './scan-code.ts';

let kit: Kit;
let lookupRelease: TemplateRelease;
const actor = { type: 'user', id: 'u1' } as const;

beforeAll(async () => {
  kit = await setupKit();
  const base = kit.template;
  const resolved = kit.registry.add({
    id: 'tpl-lookup',
    orgId: kit.org.id,
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
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  lookupRelease = await approveAppleRelease(kit, {
    orgId: kit.org.id,
    mode: 'live',
    templateId: resolved.id,
    version: resolved.version,
  });
});

const make = (memberName = 'Ab-12 / 34') =>
  createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: lookupRelease.templateId,
    templateVersion: lookupRelease.version,
    releaseId: lookupRelease.id,
    releaseGeneration: lookupRelease.generation,
    input: { memberName },
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });

const legacy = async (memberName: string, scanCode: string | null = null) => {
  const pass = await makePass(kit.fx, {
    orgId: kit.org.id,
    template: await kit.registry.resolve(lookupRelease.templateId, lookupRelease.version),
    registry: kit.registry,
    scanCode,
    personalization: { memberName },
  });
  // Before scan_code existed, a pass could still contain an independent barcode.
  await run(
    kit.env.DB,
    'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ? AND version = 1',
    [
      JSON.stringify({
        barcodes: [
          {
            format: 'PKBarcodeFormatQR',
            message: `legacy-${pass.id}`,
            messageEncoding: 'iso-8859-1',
          },
        ],
      }),
      pass.id,
    ],
  );
  return pass;
};

const lookupOf = async (passId: string) =>
  (
    await first<{ h: string | null }>(
      kit.env.DB,
      'SELECT lookup_hash AS h FROM passes WHERE id = ?',
      [passId],
    )
  )?.h ?? null;

describe('lookup hash (C7)', () => {
  it('equals lookupHashOf(input value) at creation', async () => {
    const pass = await make('Ab-12 / 34');
    expect(await lookupOf(pass.id)).toBe(await lookupHashOf('Ab-12 / 34'));
    expect(await lookupOf(pass.id)).toBe(await sha256Hex(normalizeLookup('ab 12.34')));
  });

  it('follows the input on publish', async () => {
    const pass = await make('First 1');
    await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor,
      mutate: () => ({ personalization: { memberName: 'Second 2' } }),
    });
    expect(await lookupOf(pass.id)).toBe(await lookupHashOf('second2'));
  });

  it('follows the input on a metadata-only write', async () => {
    const scanCode = newScanCode(kit.ctx);
    const fixture = await legacy('Meta 1', scanCode);
    const pass = await getPass(kit.env.DB, fixture.id);
    const org = await getOrg(kit.env.DB, kit.org.id);
    if (!pass || !org) throw new Error('Missing legacy pass or organization');
    expect(await lookupOf(pass.id)).toBeNull();
    const artifact = await buildArtifact(kit.ctx, {
      orgId: pass.orgId,
      orgName: org.name,
      branding: org.branding,
      passId: pass.id,
      serial: pass.serial,
      authToken: pass.authToken,
      scanCode,
      webServiceUrl: pass.webServiceUrl,
      identityId: pass.identityId,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      personalization: pass.personalization,
      status: pass.status,
    });
    await kit.env.BUCKET.put(pass.objectKey, artifact.bytes);
    await run(
      kit.env.DB,
      'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ? AND version = ?',
      [JSON.stringify(artifact.passJson), pass.id, pass.version],
    );
    // Same rendered pass, different stored input: casMeta.
    const { pass: next, changed } = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor,
      mutate: () => ({ personalization: { memberName: 'Meta 1', extra: 'x' } as never }),
    });
    expect(changed).toBe(false);
    expect(next.objectKey).toBe(pass.objectKey);
    expect(await lookupOf(pass.id)).toBe(await lookupHashOf('meta1'));
  });

  it('stays NULL without scan.lookup', async () => {
    const pass = await kit.pass();
    expect(await lookupOf(pass.id)).toBeNull();
  });
});

describe('backfillScanKeys', () => {
  const mint = () => 'M'.repeat(26);

  it('fills scan_code, barcode_hash and lookup_hash, then finds nothing left', async () => {
    const pass = await legacy('Back 9');
    expect(
      await first(
        kit.env.DB,
        'SELECT scan_code s, barcode_hash b, lookup_hash l FROM passes WHERE id = ?',
        [pass.id],
      ),
    ).toEqual({ s: null, b: null, l: null });
    let n = 0;
    const count = await backfillScanKeys(jobCtxOf(kit), 1000, () => `CODE${n++}`.padEnd(26, 'A'));
    expect(count).toBeGreaterThanOrEqual(1);
    const row = await first<{ s: string; b: string; l: string }>(
      kit.env.DB,
      'SELECT scan_code s, barcode_hash b, lookup_hash l FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.s).toMatch(/^CODE\d+A+$/);
    // The legacy barcode is independent of the newly minted scan code.
    const json = await first<{ pass_json: string }>(
      kit.env.DB,
      'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    );
    const message = (JSON.parse(json?.pass_json ?? '{}') as PassJson).barcodes?.[0]?.message;
    expect(message).toBe(`legacy-${pass.id}`);
    expect(row?.b).toBe(await sha256Hex(message ?? ''));
    expect(row?.l).toBe(await lookupHashOf('Back 9'));
    expect(await backfillScanKeys(jobCtxOf(kit), 1000, mint)).toBe(0);
  });

  it('leaves a removed pass without a barcode hash', async () => {
    const pass = await legacy('Gone 1');
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [Date.now(), pass.id]);
    await backfillScanKeys(jobCtxOf(kit), 1000, () => 'R'.repeat(26));
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
    const ids: string[] = [];
    for (const name of ['Lim 1', 'Lim 2', 'Lim 3']) ids.push((await legacy(name)).id);
    let n = 0;
    const count = await backfillScanKeys(jobCtxOf(kit), 2, () => `L${n++}`.padEnd(26, 'Z'));
    expect(count).toBe(2);
    expect(
      await first(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM passes WHERE id IN (?, ?, ?) AND scan_code IS NOT NULL',
        ids,
      ),
    ).toEqual({ n: 2 });
  });

  it('does not rewrite a pass that has every key', async () => {
    const pass = await make('Keep 1');
    const before = await first<{ s: string; b: string; l: string }>(
      kit.env.DB,
      'SELECT scan_code s, barcode_hash b, lookup_hash l FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(before).toMatchObject({
      s: expect.any(String),
      b: expect.any(String),
      l: expect.any(String),
    });
    await backfillScanKeys(jobCtxOf(kit), 1000, mint);
    const after = await first<{ s: string; b: string; l: string }>(
      kit.env.DB,
      'SELECT scan_code s, barcode_hash b, lookup_hash l FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(after).toEqual(before);
  });

  it('does not backfill a tombstoned possession credential', async () => {
    const pass = await legacy('Backfill blocked');
    const scanCode = 'T'.repeat(26);
    const [ref] = await credentialReferences(kit.env, kit.org.id, 'live', { scanCode });
    if (!ref) throw new Error('Missing credential reference');
    // A tombstone is only written by a pending transfer; this models one retained earlier.
    await withoutTrigger(kit.env.DB, 'pass_credential_tombstones_insert_guard', () =>
      run(
        kit.env.DB,
        `INSERT INTO pass_credential_tombstones
      (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
      VALUES (?, ?, 'live', 1, ?, ?, ?)`,
        [pass.id, kit.org.id, ref.kind, ref.ref, kit.clock.now()],
      ),
    );
    await backfillScanKeys(jobCtxOf(kit), 1000, () => scanCode);
    expect(
      await first(
        kit.env.DB,
        'SELECT scan_code, barcode_hash, lookup_hash FROM passes WHERE id = ?',
        [pass.id],
      ),
    ).toEqual({ scan_code: null, barcode_hash: null, lookup_hash: null });
  });
});
