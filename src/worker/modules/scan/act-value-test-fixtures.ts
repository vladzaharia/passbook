import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { kit } from './act-test-fixtures.ts';

/**
 * The next version of a scan template whose pass shows the balance (so a change publishes a new
 * artifact), with an optional maximum and a lock-screen message on the field.
 */
export async function showBalance(
  id: string,
  options: { maximum?: number; message?: boolean; edit?: (m: TemplateManifest) => void } = {},
): Promise<void> {
  const pinned = await kit.registry.resolve(id);
  const manifest = structuredClone(pinned.manifest);
  const balance = (manifest.inputs.properties as Record<string, Record<string, unknown>>).balance;
  if (balance && options.maximum !== undefined) balance.maximum = options.maximum;
  manifest.bindings = [
    ...manifest.bindings,
    { to: { field: 'bal' }, value: '{{balance}}' } as never,
  ];
  options.edit?.(manifest);
  const passJson = structuredClone(pinned.passJson) as PassJson & {
    generic: { secondaryFields?: unknown[] };
  };
  passJson.generic.secondaryFields = [
    {
      key: 'bal',
      label: 'Balance',
      value: '',
      ...(options.message ? { changeMessage: 'Balance is now %@' } : {}),
    },
  ];
  const version = pinned.version === 'v1' ? 'v2' : 'v3';
  const revised = kit.registry.add({
    id,
    orgId: pinned.orgId,
    version,
    manifest,
    passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, revised, { registry: kit.registry, buildKey: 'value-test' });
  for (const mode of ['live', 'test'] as const)
    await approveAppleRelease(kit, { templateId: id, version, mode });
}
