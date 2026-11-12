import { beforeAll } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

export let kit: ScanKit;
export let credentialKeysetCommitment: string;
export const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;

export function registerLookupReleaseFixture() {
  beforeAll(async () => {
    kit = await setupScanKit();
    credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  });
}

export async function stageVersion(templateId: string, version: string) {
  const base = await kit.registry.resolve(templateId, 'v1');
  const manifest = structuredClone(base.manifest);
  if (!manifest.inputs.properties) throw new Error('Missing template input properties');
  manifest.inputs.properties.memberName = { type: 'string', 'x-scan': 'manager' };
  const staged = kit.registry.add({
    id: templateId,
    orgId: base.orgId,
    version,
    manifest,
    passJson: base.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, staged, { registry: kit.registry });
}
