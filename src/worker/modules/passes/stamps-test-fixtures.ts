import { persistTemplate } from '../../../../test/helpers/index.ts';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { first } from '../../platform/db.ts';
import { runBulkReissue } from '../../workflows/bulk-reissue.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { createPassRow } from './create.ts';
import type { Kit } from './pass-test-fixtures.ts';
import { reissueStalePasses, STALE_QUIET_MS } from './stale-reissue.ts';

const blueprint = bakedTemplates.find((t) => t.slug === 'starter-stamp-card');
if (!blueprint) throw new Error('The Stamp card blueprint is missing; run npm run gen.');
export const STAMP_CARD = blueprint;

const STRIPS = { 2: makePng(750, 288), 3: makePng(1125, 432) };
const IMAGES: Record<string, Uint8Array> = {
  'icon@2x.png': makePng(58, 58),
  'icon@3x.png': makePng(87, 87),
  'logo@2x.png': makePng(100, 100),
  'logo@3x.png': makePng(150, 150),
};

/** The Stamp card at another goal, with a strip pair per count as a save stores them. */
export async function stampVersion(
  kit: Kit,
  id: string,
  version: string,
  goal: number,
  options: { keepReady?: boolean; maximum?: number; input?: string } = {},
) {
  const manifest = structuredClone(STAMP_CARD.manifest) as TemplateManifest;
  const block = manifest.stamps;
  if (!block) throw new Error('The Stamp card has no stamps block.');
  manifest.stamps = { ...block, goal, ...(options.keepReady ? { keepReady: true } : {}) };
  const props = manifest.inputs.properties as Record<string, Record<string, unknown>>;
  props.stamps = { ...props.stamps, maximum: options.maximum ?? 2 * goal - 1 };
  if (options.input) {
    props[options.input] = props.stamps as Record<string, unknown>;
    delete props.stamps;
    manifest.stamps = { ...manifest.stamps, input: options.input } as never;
  }
  const assets: Record<string, Uint8Array> = { ...IMAGES };
  for (let n = 0; n <= goal; n++) {
    assets[`stamps/strips/${n}/strip@2x.png`] = STRIPS[2];
    assets[`stamps/strips/${n}/strip@3x.png`] = STRIPS[3];
  }
  const resolved = kit.registry.add({
    id,
    version,
    orgId: kit.org.id,
    manifest,
    passJson: structuredClone(STAMP_CARD.passJson) as PassJson,
    assets,
  });
  await persistTemplate(kit.fx, resolved, { registry: kit.registry });
  return resolved;
}

export const releaseStamps = (kit: Kit, templateId: string, version: string) =>
  approveAppleRelease(kit, { orgId: kit.org.id, mode: 'live', templateId, version });

export async function stampCard(
  kit: Kit,
  release: Awaited<ReturnType<typeof releaseStamps>>,
  stamps: number,
) {
  return createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: release.templateId,
    templateVersion: release.version,
    releaseId: release.id,
    releaseGeneration: release.generation,
    input: { holder: 'Alex Morgan', cardNumber: `C-${kit.fx.ids.id()}`, reward: 'Coffee', stamps },
    holderEmail: null,
    source: 'manual',
    mode: 'live',
    execution: { kind: 'system' },
    actor: { type: 'system', id: null },
  });
}

type Fn = () => Promise<unknown>;
const call = (a: unknown, b: unknown) => ((typeof a === 'function' ? a : b) as Fn)();
const step = {
  do: async (_name: string, a: unknown, b?: unknown) => call(a, b),
} as unknown as Parameters<typeof runBulkReissue>[3];

/** Runs the stale reissue the cron would start for one template, twice (a retried page). */
export async function reissueStamps(kit: Kit, templateId: string) {
  kit.clock.set(kit.clock.now() + STALE_QUIET_MS + 1);
  await reissueStalePasses(kit.ctx);
  const workflow = kit.workflow.created.findLast(
    (w) =>
      typeof w.params === 'object' &&
      w.params !== null &&
      'templateId' in w.params &&
      w.params.templateId === templateId,
  );
  if (!workflow) throw new Error(`No reissue for ${templateId}.`);
  const params = workflow.params as Parameters<typeof runBulkReissue>[2];
  const result = await runBulkReissue(kit.env, workflow.id, params, step);
  await runBulkReissue(kit.env, workflow.id, params, step);
  await kit.settle();
  return result;
}

/** The latest built header field `stamps` of a pass. */
export async function stampHeader(kit: Kit, passId: string) {
  const row = await first<{ pass_json: string }>(
    kit.env.DB,
    'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
    [passId],
  );
  const pass = JSON.parse(row?.pass_json ?? '{}') as {
    storeCard?: { headerFields?: { key: string; value: string; changeMessage?: string }[] };
  };
  return pass.storeCard?.headerFields?.find((f) => f.key === 'stamps');
}
