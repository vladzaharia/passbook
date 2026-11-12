import { beforeAll, describe, expect, it } from 'vitest';
import { makePass, persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex, toBase32 } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import type { TemplateRelease } from '../templates/releases.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { buildArtifact } from './builder.ts';
import { createPassRow } from './create.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getOrg } from './repo-read-issuance.ts';
import { getPass } from './repo-read-pass.ts';
import { barcodeHashOf } from './scan-code.ts';

let kit: Kit;
let scanRelease: TemplateRelease;

beforeAll(async () => {
  kit = await setupKit();
  const base = kit.template;
  const resolved = kit.registry.add({
    id: 'tpl-scan',
    orgId: kit.org.id,
    manifest: {
      ...base.manifest,
      name: 'Scan template',
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
  scanRelease = await approveAppleRelease(kit, {
    orgId: kit.org.id,
    mode: 'live',
    templateId: resolved.id,
    version: resolved.version,
  });
});

const make = () =>
  createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: scanRelease.templateId,
    templateVersion: scanRelease.version,
    releaseId: scanRelease.id,
    releaseGeneration: scanRelease.generation,
    input: { memberName: 'Scan Me' },
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });

const message = async (passId: string) => {
  const row = await first<{ pass_json: string }>(
    kit.env.DB,
    'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
    [passId],
  );
  return (JSON.parse(row?.pass_json ?? '{}') as PassJson).barcodes?.[0]?.message;
};

describe('scan code', () => {
  it('encodes 128 bits as 26 base32 characters', () => {
    expect(toBase32(new Uint8Array(16))).toBe('A'.repeat(26));
    expect(toBase32(new Uint8Array(16).fill(255))).toBe(`${'7'.repeat(25)}4`);
    expect(toBase32(new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]))).toBe('MZXW6YTBOI');
  });

  it('is created with every pass, unique, and bound as {{pass.scanCode}}', async () => {
    const a = await make();
    const b = await make();
    const plain = await kit.pass();
    for (const pass of [a, b, plain]) expect(pass.scanCode).toMatch(/^[A-Z2-7]{26}$/);
    expect(new Set([a.scanCode, b.scanCode, plain.scanCode]).size).toBe(3);
    expect(await message(a.id)).toBe(a.scanCode);
    expect(a.barcodeHash).toBe(await sha256Hex(a.scanCode ?? ''));
    // The template without a barcode has no hash.
    expect(plain.barcodeHash).toBeNull();
  });

  it('keeps the same code across publishes and writes the hash each time', async () => {
    const pass = await make();
    const { pass: next } = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'user', id: 'u1' },
      mutate: () => ({ personalization: { memberName: 'Renamed' } }),
    });
    expect(next.scanCode).toBe(pass.scanCode);
    expect(next.barcodeHash).toBe(await sha256Hex(pass.scanCode ?? ''));
  });

  it('backfills an older pass on its next publish', async () => {
    const pass = await makePass(kit.fx, {
      orgId: kit.org.id,
      template: await kit.registry.resolve(scanRelease.templateId, scanRelease.version),
      registry: kit.registry,
      scanCode: null,
      personalization: { memberName: 'Scan Me' },
    });
    expect((await getPass(kit.env.DB, pass.id))?.scanCode).toBeNull();
    const { pass: next, changed } = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'user', id: 'u1' },
    });
    expect(next.scanCode).toMatch(/^[A-Z2-7]{26}$/);
    expect(changed).toBe(true);
    expect(await message(pass.id)).toBe(next.scanCode);
    expect(next.barcodeHash).toBe(await sha256Hex(next.scanCode ?? ''));
    expect((await getPass(kit.env.DB, pass.id))?.scanCode).toBe(next.scanCode);
  });

  it('backfills a missing scan code even when the rendered artifact is identical', async () => {
    const fixture = await makePass(kit.fx, {
      orgId: kit.org.id,
      template: kit.template,
      registry: kit.registry,
      scanCode: null,
      personalization: { memberName: 'Legacy' },
    });
    const pass = await getPass(kit.env.DB, fixture.id);
    const org = await getOrg(kit.env.DB, kit.org.id);
    if (!pass || !org) throw new Error('Missing legacy pass or organization');
    expect(pass.scanCode).toBeNull();
    const artifact = await buildArtifact(kit.ctx, {
      orgId: pass.orgId,
      orgName: org.name,
      branding: org.branding,
      passId: pass.id,
      serial: pass.serial,
      authToken: pass.authToken,
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
    const { pass: next, changed } = await publishPass(jobCtxOf(kit), {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'user', id: 'u1' },
    });
    expect(changed).toBe(false);
    expect(next.objectKey).toBe(pass.objectKey);
    expect(next.scanCode).toMatch(/^[A-Z2-7]{26}$/);
    expect(next.barcodeHash).toBeNull();
    expect((await getPass(kit.env.DB, pass.id))?.scanCode).toBe(next.scanCode);
  });

  it('hashes the first barcode, or the legacy one', async () => {
    const hash = await sha256Hex('hello');
    expect(
      await barcodeHashOf({ barcodes: [{ message: 'hello' }, { message: 'no' }] } as never),
    ).toBe(hash);
    expect(await barcodeHashOf({ barcode: { message: 'hello' } } as never)).toBe(hash);
    expect(await barcodeHashOf({} as never)).toBeNull();
  });
});
