import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { generatedSource } from '../templates/sync.ts';
import { HOUR, out } from './act-test-fixtures.ts';
import { approveScanReleases, codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let templateId: string;
beforeAll(async () => {
  kit = await setupScanKit();
  const henrys = generatedSource.templates.find((t) => t.slug === 'henrys-blue');
  if (!henrys?.manifest.scan) throw new Error('henrys-blue has no scan block.');
  // The scan block and inputs are Henry's own; the pass faces are the kit's, which the rules never read.
  const base = kit.template;
  const resolved = kit.registry.add({
    id: 'tpl-henrys-door',
    orgId: kit.org.id,
    manifest: {
      ...base.manifest,
      name: henrys.manifest.name,
      inputs: henrys.manifest.inputs,
      bindings: [
        ...base.manifest.bindings,
        { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
      ],
      scan: henrys.manifest.scan,
    },
    passJson: {
      ...base.passJson,
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'utf-8' }],
    } as PassJson,
    assets: { 'icon.png': ICON_PNG },
  });
  templateId = resolved.id;
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  await approveScanReleases(kit, templateId, { version: resolved.version });
});

const member = (over: Record<string, unknown> = {}) =>
  kit.scanPass(templateId, {
    memberName: 'Alex Morgan',
    memberId: 'DEMO0001',
    membership: 'All-Inclusive Wellness',
    ...over,
  });
const scanner = () => kit.scanner({ templateIds: [templateId] });
const scan = async (
  s: Awaited<ReturnType<typeof scanner>>,
  p: Awaited<ReturnType<typeof member>>,
) =>
  out(
    await kit.post(s.headers, '/actions', {
      idempotencyKey: key(),
      input: codeOf(p),
      clientTs: kit.clock.now(),
      actionId: 'auto',
    }),
  );

describe("Henry's at the door", () => {
  it('lets a member in, refuses a second visit the same day and accepts the next day', async () => {
    const s = await scanner();
    const pass = await member();
    expect(await scan(s, pass)).toMatchObject({ kind: 'ok' });
    kit.clock.advance(5 * 60_000);
    expect(await scan(s, pass)).toMatchObject({ kind: 'heads_up', reason: 'already_done' });
    kit.clock.advance(26 * HOUR);
    expect(await scan(s, pass)).toMatchObject({ kind: 'ok' });
  });

  it.each(['Suspended', 'Expired', 'Cancelled'])('stops a %s member', async (status) => {
    const s = await scanner();
    const pass = await member({ status });
    expect(await scan(s, pass)).toMatchObject({ kind: 'heads_up', reason: 'check_required' });
  });

  it('admits an Active member and finds a member by member number', async () => {
    const s = await kit.scanner({
      templateIds: [templateId],
      settings: { lookup: true, roleWithoutSignIn: 'desk' },
    });
    const pass = await member({ memberId: 'LOOKUP77', status: 'Active' });
    expect(await scan(s, pass)).toMatchObject({ kind: 'ok' });
    const res = await kit.post(s.headers, '/lookup', { q: 'LOOKUP77' });
    const body = (await res.json()) as { items: { passId: string }[] };
    expect(body.items.map((i) => i.passId)).toContain(pass.id);
  });
});
