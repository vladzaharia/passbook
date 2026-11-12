import { materializeTemplateAssets } from '../../../../test/helpers/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { kit } from './resolve-test-fixtures.ts';

export async function installVersion(
  templateId: string,
  version: string,
  manifest: TemplateManifest,
  passJson: PassJson,
  buildKey: string | null = null,
  assets: Record<string, Uint8Array> = { 'icon.png': ICON_PNG },
) {
  const staged = kit.registry.add({
    id: templateId,
    orgId: kit.org.id,
    version,
    manifest,
    passJson,
    assets,
  });
  const storedAssets = await materializeTemplateAssets(kit.fx, staged, kit.registry);
  await run(
    kit.env.DB,
    `INSERT INTO template_versions
    (template_id, version, manifest, pass_json, assets, created_at, build_key) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      templateId,
      version,
      JSON.stringify(manifest),
      JSON.stringify(passJson),
      JSON.stringify(storedAssets),
      kit.clock.now(),
      buildKey,
    ],
  );
  await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
    version,
    templateId,
  ]);
  const live = await approveAppleRelease(kit, { templateId, version, mode: 'live' });
  await approveAppleRelease(kit, { templateId, version, mode: 'test' });
  return live;
}

/** Stage an issued fixture on a separately inserted, immutable template version. */
export async function pinFixtureVersion(passId: string, version: string, releaseId: string) {
  await run(kit.env.DB, 'UPDATE passes SET template_version = ?, release_id = ? WHERE id = ?', [
    version,
    releaseId,
    passId,
  ]);
  await run(kit.env.DB, 'UPDATE pass_versions SET template_version = ? WHERE pass_id = ?', [
    version,
    passId,
  ]);
}

export async function walletFixture(passId: string, template: PassJson): Promise<PassJson> {
  const row = await first<{ pass_json: string | null }>(
    kit.env.DB,
    'SELECT pass_json FROM pass_versions WHERE pass_id=? ORDER BY version DESC LIMIT 1',
    [passId],
  );
  if (!row?.pass_json) throw new Error('Missing issued Wallet snapshot');
  const issued = JSON.parse(row.pass_json) as PassJson;
  const snapshot = structuredClone(template);
  snapshot.serialNumber = issued.serialNumber;
  snapshot.passTypeIdentifier = issued.passTypeIdentifier;
  snapshot.teamIdentifier = issued.teamIdentifier;
  return snapshot;
}

export async function persistCardProjection(
  passId: string,
  snapshot: PassJson,
  personalization: Record<string, unknown>,
  displayTitle: string,
  displaySubtitle: string,
) {
  await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
    JSON.stringify(snapshot),
    passId,
  ]);
  await run(
    kit.env.DB,
    'UPDATE passes SET personalization = ?, display_title = ?, display_subtitle = ? WHERE id = ?',
    [JSON.stringify(personalization), displayTitle, displaySubtitle, passId],
  );
  await run(
    kit.env.DB,
    `UPDATE pass_versions
    SET personalization=(SELECT personalization FROM passes WHERE id=?) WHERE pass_id=?`,
    [passId, passId],
  );
}
