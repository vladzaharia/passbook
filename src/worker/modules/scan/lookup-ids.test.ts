import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, persistTemplate } from '../../../../test/helpers/index.ts';
import { ICON_PNG } from '../passes/test-kit.ts';
import { key, type ScanKit, setPass, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeEach(async () => {
  kit = await setupScanKit();
  const resolved = kit.registry.add({
    id: `tpl-${key()}`,
    orgId: kit.org.id,
    manifest: {
      ...kit.template.manifest,
      inputs: {
        type: 'object',
        properties: { memberName: { type: 'string' }, memberNo: { type: 'string' } },
      },
      bindings: kit.template.manifest.bindings,
      scan: {
        actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
        lookup: { input: 'memberNo' },
      },
    },
    passJson: {
      ...kit.template.passJson,
      barcodes: [
        { format: 'PKBarcodeFormatQR', message: 'opaque:qr:payload', messageEncoding: 'utf-8' },
      ],
    },
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, resolved);
  templateId = resolved.id;
});
const search = async (q: string, headers = kit.admin()) => {
  const response = await kit.post(headers, '/lookup', {
    q,
    ...(headers.cookie?.includes('__Host-wallet_scan=')
      ? {}
      : { scope: { orgId: kit.org.id, timeZone: 'UTC' } }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ items: { passId: string }[]; more: boolean }>;
};

describe('exact lookup IDs', () => {
  it('finds hidden member IDs alongside an independent QR payload without writing a scan', async () => {
    const pass = await kit.scanPass(templateId, { memberNo: '00001234' });
    for (const q of [
      '00001234',
      '0000-1234',
      'opaque:qr:payload',
      pass.id,
      pass.serial,
      pass.scanCode!,
    ])
      expect((await search(q)).items.map((p) => p.passId)).toEqual([pass.id]);
    for (const method of ['manual', 'wedge', 'camera'] as const) {
      const response = await kit.post(kit.admin(), '/resolve', {
        idempotencyKey: key(),
        input: { code: '00001234', method },
        clientTs: kit.clock.now(),
        scope: { orgId: kit.org.id, timeZone: 'UTC' },
      });
      expect(await response.json()).toMatchObject({ kind: 'ready', card: { passId: pass.id } });
    }
    const rows = await kit.env.DB.prepare('SELECT count(*) AS n FROM scans').first<{ n: number }>();
    expect(rows?.n).toBe(0);
    const json = JSON.stringify(await search('00001234'));
    expect(json).not.toContain('00001234');
    expect(json).not.toContain('opaque:qr:payload');
  });

  it('matches short and email-like external IDs exactly without enabling short name or partial email search', async () => {
    const pass = await kit.scanPass(templateId, { memberName: 'Annabelle', memberNo: '07' });
    expect((await search('07')).items.map((p) => p.passId)).toEqual([pass.id]);
    expect((await search('An')).items).toEqual([]);
    await setPass(kit, pass.id, 'external_id = ?', ['legacy@id']);
    expect((await search('legacy@id')).items.map((p) => p.passId)).toEqual([pass.id]);
    expect((await search('legacy@i')).items).toEqual([]);
    await setPass(kit, pass.id, 'external_id = ?', ['Legacy@example.test']);
    expect((await search('Legacy@example.test')).items.map((p) => p.passId)).toEqual([pass.id]);
  });

  it('scopes exact IDs by organization, mode and accepted templates', async () => {
    const pass = await kit.scanPass(templateId, { memberNo: 'COMMON' });
    await kit.scanPass(templateId, { memberNo: 'COMMON' }, { mode: 'test' });
    const org = await makeOrg(kit.fx, { name: 'Other' });
    const otherTemplate = await kit.scanTemplate(
      'Other org',
      {
        actions: [{ id: 'enter', label: 'Enter', kind: 'check_in' }],
        lookup: { input: 'memberNo' },
      },
      { orgId: org.id },
    );
    await kit.scanPass(otherTemplate, { memberNo: 'COMMON' }, { orgId: org.id });
    expect((await search('COMMON')).items.map((p) => p.passId)).toEqual([pass.id]);
    const excluded = await kit.scanner({ templateIds: [otherTemplate] });
    expect((await search(pass.id, excluded.headers)).items).toEqual([]);
    const duplicate = await kit.scanPass(templateId, { memberNo: 'COMMON' });
    expect((await search('COMMON')).items.map((p) => p.passId).sort()).toEqual(
      [pass.id, duplicate.id].sort(),
    );
    const response = await kit.post(kit.admin(), '/resolve', {
      idempotencyKey: key(),
      input: { code: 'COMMON', method: 'wedge' },
      clientTs: kit.clock.now(),
      scope: { orgId: kit.org.id, timeZone: 'UTC' },
    });
    expect(await response.json()).toMatchObject({ reason: 'ambiguous' });
  });
});
