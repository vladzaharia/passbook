import { expect } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ScanCard, ScanOutcome } from '../../../shared/contracts/scan.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { key, type ScanKit } from './test-kit.ts';

/** Keep each suite's helpers bound to its own beforeAll scanner kit. */
export function cardLastScansSplitFixture(getKit: () => ScanKit) {
  const input = (passId: string) => ({ passId, method: 'manual' as const });
  const body = (passId: string) => ({
    idempotencyKey: key(),
    input: input(passId),
    clientTs: getKit().clock.now(),
  });

  async function act(headers: Record<string, string>, passId: string): Promise<string> {
    const response = await getKit().post(headers, '/actions', {
      ...body(passId),
      actionId: 'enter',
    });
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome.kind).toBe('ok');
    if (!outcome.scanId) throw new Error('Expected an actual committed scan');
    return outcome.scanId;
  }

  async function card(headers: Record<string, string>, passId: string): Promise<ScanCard> {
    const response = await getKit().post(headers, '/resolve', body(passId));
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as ScanOutcome;
    expect(outcome.kind).toBe('ready');
    if (!outcome.card) throw new Error('Expected a ready scanner card');
    return outcome.card;
  }

  function last(card: ScanCard, scanId: string): ScanCard['lastScans'][number] {
    const row = card.lastScans.find((item) => item.scanId === scanId);
    if (!row) throw new Error('Expected the committed scan in card history');
    return row;
  }

  async function manager(templateId: string) {
    const kit = getKit();
    const staff = await kit.staff('manager');
    const scanner = await kit.scanner({
      templateIds: [templateId],
      staffId: staff.id,
      settings: { staffSignIn: true },
    });
    return { scanner, staff };
  }

  async function stage(
    templateId: string,
    baseVersion: string,
    version: string,
    edit: (manifest: TemplateManifest) => void,
  ) {
    const kit = getKit();
    const base = await kit.registry.resolve(templateId, baseVersion);
    const manifest = structuredClone(base.manifest);
    edit(manifest);
    const resolved = kit.registry.add({
      id: templateId,
      orgId: kit.org.id,
      version,
      manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, resolved, { registry: kit.registry });
    await approveAppleRelease(kit, { templateId, version, mode: 'live' });
  }

  async function approve(templateId: string, version: string) {
    await approveAppleRelease(getKit(), { templateId, version, mode: 'live' });
  }

  async function simple(label = 'Admit member') {
    const kit = getKit();
    const templateId = await kit.scanTemplate('Card history privacy', {
      actions: [{ id: 'enter', label, kind: 'check_in' }],
    });
    const pass = await kit.scanPass(templateId);
    const scanner = await kit.scanner({ templateIds: [templateId] });
    return { templateId, pass, scanner };
  }

  return { act, approve, body, card, last, manager, simple, stage };
}
