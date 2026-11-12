import { makePass } from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { AssetEntry } from '../../../passkit/types.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { crc32, sha1Hex } from '../templates/package/hash.ts';
import { r2Key } from '../templates/registry.ts';
import { type FakeAssets, fakeAssets } from '../templates/testing.ts';
import {
  type LiveTemplateBinding,
  type LiveTemplateSnapshot,
  liveTemplateSnapshotFromResult,
  liveTemplateSnapshotStmt,
  scanTemplateSnapshotPredicate,
} from './repo-live-template-snapshot.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

interface Projected {
  passId: string;
  orgId: string;
  mode: 'live' | 'test';
  templateId: string;
  pinnedVersion: string;
  issuedId: string | null;
  pinned: { version: string; buildKey: string | null } | null;
  active: { version: string; buildKey: string | null } | null;
  release: { id: string; generation: number; version: string; candidateHash: string } | null;
}

export async function capture(kit: ScanKit, passId: string, mode: 'live' | 'test' = 'live') {
  const result = await liveTemplateSnapshotStmt(kit.env.DB, kit.org.id, mode, passId).all();
  const snapshot = liveTemplateSnapshotFromResult(result);
  if (!snapshot) throw new Error('Expected a template snapshot');
  const data = JSON.parse(snapshot.raw) as Projected;
  const compatible =
    data.pinned &&
    data.active &&
    (data.pinned.version === data.active.version ||
      (data.pinned.buildKey !== null && data.pinned.buildKey === data.active.buildKey));
  const binding: LiveTemplateBinding = {
    pass: {
      id: data.passId,
      orgId: data.orgId,
      mode: data.mode,
      templateId: data.templateId,
      templateVersion: data.pinnedVersion,
      releaseId: data.issuedId,
    },
    activeReleaseId: data.release?.id ?? null,
    activeReleaseGeneration: data.release?.generation ?? null,
    activeReleaseVersion: data.release?.version ?? null,
    activeReleaseCandidateHash: data.release?.candidateHash ?? null,
    activeTemplateVersion: data.active?.version ?? null,
    displayTemplateVersion: compatible && data.active ? data.active.version : null,
  };
  return { binding, snapshot, data };
}

export async function current(
  kit: ScanKit,
  binding: LiveTemplateBinding,
  snapshot: LiveTemplateSnapshot,
  purpose: 'read' | 'commit' = 'commit',
) {
  const predicate = scanTemplateSnapshotPredicate(binding, snapshot, purpose);
  const row = await first<{ ok: number }>(
    kit.env.DB,
    `SELECT (${predicate.sql}) AS ok FROM (SELECT ? AS org_id, ? AS mode) scope`,
    [...predicate.params, binding.pass.orgId, binding.pass.mode],
  );
  return row?.ok === 1;
}

export async function insertVersion(
  kit: ScanKit,
  id: string,
  v: string,
  buildKey: string | null,
  options: { static?: boolean; name?: string } = {},
): Promise<ResolvedTemplate> {
  const manifest = {
    ...structuredClone(kit.template.manifest),
    name: options.name ?? `Version ${v}`,
  };
  const passJson = structuredClone(kit.template.passJson);
  const source = options.static
    ? { kind: 'static' as const, path: `/assets/${id}-${v}.png` }
    : { kind: 'r2' as const, key: r2Key(kit.org.id, id, v, 'icon.png') };
  if (source.kind === 'r2') await kit.env.BUCKET.put(source.key, ICON_PNG);
  else (kit.env.ASSETS as FakeAssets).files.set(source.path, ICON_PNG);
  const asset: AssetEntry = {
    name: 'icon.png',
    slot: 'icon',
    scale: 1,
    size: ICON_PNG.length,
    sha1: await sha1Hex(ICON_PNG),
    crc32: crc32(ICON_PNG),
    width: 38,
    height: 38,
    source,
  };
  await run(
    kit.env.DB,
    `INSERT INTO template_versions
    (template_id, version, build_key, manifest, pass_json, assets, report, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      v,
      buildKey,
      JSON.stringify(manifest),
      JSON.stringify(passJson),
      JSON.stringify([asset]),
      JSON.stringify({ ok: true, issues: [] }),
      kit.clock.now(),
    ],
  );
  return kit.registry.add({
    id,
    orgId: kit.org.id,
    version: v,
    manifest,
    passJson,
    assets: { 'icon.png': ICON_PNG },
  });
}

export async function fixture(
  options: { approved?: boolean; buildKey?: string | null; static?: boolean } = {},
) {
  const kit = await setupScanKit();
  if (options.static) Object.assign(kit.env, { ASSETS: fakeAssets() });
  const id = `snapshot-${kit.fx.ids.token(6)}`;
  await run(
    kit.env.DB,
    `INSERT INTO templates
    (id, org_id, slug, name, origin, active_version, created_at, updated_at)
    VALUES (?, ?, ?, 'Snapshot', 'uploaded', 'v1', ?, ?)`,
    [id, kit.org.id, id, kit.clock.now(), kit.clock.now()],
  );
  const pinned = await insertVersion(
    kit,
    id,
    'v1',
    options.buildKey === undefined ? 'same-build' : options.buildKey,
    { static: options.static },
  );
  if (options.approved !== false) {
    const release = await approveAppleRelease(kit, { templateId: id, version: 'v1', mode: 'live' });
    const pass = await kit.scanPass(id);
    return { kit, id, pinned, pass, release };
  }
  const pass = await makePass(kit.fx, { orgId: kit.org.id, template: pinned });
  return { kit, id, pinned, pass, release: null };
}
