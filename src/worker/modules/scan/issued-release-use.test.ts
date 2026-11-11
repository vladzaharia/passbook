// An existing pass is used against its own issued release, never the template's current head.
import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { codeOf, key, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

const system = { type: 'system', id: null } as const;
const scope = () => ({ orgId: kit.org.id, timeZone: 'UTC' });
const scan = async (code: { code: string; method: 'camera' }) => {
  const res = await kit.post(kit.admin(), '/actions', {
    scope: scope(),
    idempotencyKey: key(),
    input: code,
    clientTs: kit.clock.now(),
    actionId: 'check_in',
  });
  return (await res.json()) as ScanOutcome;
};
const undo = async (scanId: string) => {
  const res = await kit.post(kit.admin(), `/scans/${scanId}/undo`, {
    idempotencyKey: key(),
    scope: scope(),
  });
  return (await res.json()) as ScanOutcome;
};
const refresh = (passId: string, mutate?: () => { templateVersion: string }) =>
  publishPass(jobCtxOf(kit), {
    passId,
    actor: system,
    cause: mutate ? 'template_upgrade' : 'admin',
    force: true,
    ...(mutate ? { mutate } : {}),
  });

/** A second version whose build differs, approved as the new head. */
async function moveHead(templateId: string, version: string) {
  const pinned = await kit.registry.resolve(templateId);
  const manifest = structuredClone(pinned.manifest);
  manifest.name = `${manifest.name} ${version}`;
  const next = kit.registry.add({
    id: templateId,
    orgId: pinned.orgId,
    version,
    manifest,
    passJson: pinned.passJson,
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, next, {
    registry: kit.registry,
    buildKey: `incompatible-${version}`,
  });
  for (const mode of ['live', 'test'] as const)
    await approveAppleRelease(kit, { templateId, version, mode });
}

const setStatus = (templateId: string, status: string) =>
  run(kit.env.DB, 'UPDATE templates SET status = ? WHERE id = ?', [status, templateId]);

describe('use of an existing pass does not depend on the template head', () => {
  it('scans, refreshes and undoes an old-version pass after a new release, and the reissue upgrades it', async () => {
    const templateId = await kit.scanTemplate('Old version', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    const first = await scan(codeOf(pass));
    expect(first.kind).toBe('ok');
    await moveHead(templateId, 'v2');

    expect((await refresh(pass.id)).pass.templateVersion).toBe(pass.templateVersion);
    expect((await undo(first.scanId ?? '')).kind).toBe('ok');
    const second = await scan(codeOf(pass));
    expect(second.kind).toBe('ok');

    const upgraded = await refresh(pass.id, () => ({ templateVersion: 'v2' }));
    expect(upgraded.pass.templateVersion).toBe('v2');
    expect((await scan({ code: upgraded.pass.scanCode ?? '', method: 'camera' })).kind).toBe('ok');
  });

  it('scans and refreshes the passes of an archived template, while new issuance is refused', async () => {
    const templateId = await kit.scanTemplate('Archived', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    await setStatus(templateId, 'archived');
    expect((await scan(codeOf(pass))).kind).toBe('ok');
    expect((await refresh(pass.id)).pass.templateVersion).toBe(pass.templateVersion);
    await expect(kit.scanPass(templateId)).rejects.toMatchObject({
      code: 'TEMPLATE_RELEASE_REQUIRED',
    });
  });

  it('keeps scanning a pass whose own release is no longer the head after a rollback to another version', async () => {
    const templateId = await kit.scanTemplate('Superseded', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    await moveHead(templateId, 'v2');
    await moveHead(templateId, 'v3');
    expect((await scan(codeOf(pass))).kind).toBe('ok');
  });

  it('refuses the passes of a deleted template', async () => {
    const templateId = await kit.scanTemplate('Deleted', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const pass = await kit.scanPass(templateId);
    await setStatus(templateId, 'deleted');
    expect(await scan(codeOf(pass))).toMatchObject({ kind: 'refused' });
  });
});
