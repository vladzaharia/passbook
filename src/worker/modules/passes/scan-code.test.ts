import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex, toBase32 } from '../../platform/ids.ts';
import { createPassRow } from './create.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo.ts';
import { barcodeHashOf } from './scan-code.ts';
import { ICON_PNG, type Kit, setupKit } from './test-kit.ts';

let kit: Kit;
let scanTemplateId: string;

beforeAll(async () => {
  kit = await setupKit();
  const base = kit.template;
  const resolved = kit.registry.add({
    id: 'tpl-scan',
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
  await persistTemplate(kit.fx, resolved);
  scanTemplateId = resolved.id;
});

const make = async (templateId = scanTemplateId) =>
  createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId,
    templateVersion: (await kit.registry.resolve(templateId)).version,
    input: { memberName: 'Scan Me' },
    source: 'manual',
    mode: 'live',
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
    const { pass: next } = await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'user', id: 'u1' },
      mutate: () => ({ personalization: { memberName: 'Renamed' } }),
    });
    expect(next.scanCode).toBe(pass.scanCode);
    expect(next.barcodeHash).toBe(await sha256Hex(pass.scanCode ?? ''));
  });

  it('is backfilled on the next publish of an older pass, even an otherwise identical one', async () => {
    const pass = await make();
    await run(kit.env.DB, 'UPDATE passes SET scan_code = NULL, barcode_hash = NULL WHERE id = ?', [
      pass.id,
    ]);
    const { pass: next } = await publishPass(kit.ctx, {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'user', id: 'u1' },
    });
    expect(next.scanCode).toMatch(/^[A-Z2-7]{26}$/);
    expect(next.scanCode).not.toBe(pass.scanCode);
    expect(await message(pass.id)).toBe(next.scanCode);
    expect(next.barcodeHash).toBe(await sha256Hex(next.scanCode ?? ''));
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
