// A transfer that keeps the pass at its own version re-signs under its own issued release.
import { describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { type Kit, setupKit, TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { fixedBarcodePass } from './fixed-barcode-fixtures.ts';
import { reassignHolder } from './service.ts';

const system = { type: 'system', id: null } as const;
let n = 0;
const email = () => `own-release-${++n}-${Math.random().toString(36).slice(2)}@example.test`;

const setStatus = (kit: Kit, templateId: string, status: string) =>
  run(kit.env.DB, 'UPDATE templates SET status = ? WHERE id = ?', [status, templateId]);

async function moveHead(kit: Kit, templateId: string, version: string) {
  const pinned = await kit.registry.resolve(templateId);
  const manifest = structuredClone(pinned.manifest);
  manifest.name = `${manifest.name} ${version}`;
  const next = kit.registry.add({
    id: templateId,
    orgId: pinned.orgId,
    version,
    manifest,
    passJson: pinned.passJson,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, next, { registry: kit.registry, buildKey: `other-${version}` });
  await approveAppleRelease(kit, { templateId, version });
}

async function reassign(kit: Kit, passId: string, to: string) {
  await reassignHolder(jobCtxOf(kit), system, { passId, email: to }, null);
}

async function expectKeptVersion(
  kit: Kit,
  before: NonNullable<Awaited<ReturnType<typeof getPass>>>,
) {
  const to = email();
  await reassign(kit, before.id, to);
  const after = await getPass(kit.env.DB, before.id);
  expect(after).toMatchObject({
    holderEmail: to,
    templateVersion: before.templateVersion,
    releaseId: before.releaseId,
    credentialGeneration: before.credentialGeneration + 1,
  });
}

describe('holder change under the pass own release', () => {
  it('completes on an archived template at the pass own version', async () => {
    const kit = await setupKit();
    const pass = await kit.pass({ holderEmail: email() });
    await setStatus(kit, kit.template.id, 'archived');
    await expectKeptVersion(kit, pass);
  }, 120_000);

  it('completes behind a head on another build, without moving the pass', async () => {
    const kit = await setupKit();
    const pass = await kit.pass({ holderEmail: email() });
    await moveHead(kit, kit.template.id, 'v2');
    await expectKeptVersion(kit, pass);
  }, 120_000);

  it('still completes at the head when the head is the pass own version', async () => {
    const kit = await setupKit();
    const pass = await kit.pass({ holderEmail: email() });
    await expectKeptVersion(kit, pass);
  }, 120_000);

  it('refuses when the template is deleted', async () => {
    const kit = await setupKit();
    const pass = await kit.pass({ holderEmail: email() });
    await setStatus(kit, kit.template.id, 'deleted');
    await expect(reassign(kit, pass.id, email())).rejects.toBeDefined();
    expect((await getPass(kit.env.DB, pass.id))?.credentialGeneration).toBe(
      pass.credentialGeneration,
    );
  }, 120_000);

  it('needs the head when the pass has no issued release (it would move to a new version)', async () => {
    const kit = await setupKit();
    const pass = await kit.pass({ holderEmail: email() });
    await run(kit.env.DB, 'UPDATE passes SET release_id = NULL WHERE id = ?', [pass.id]);
    await setStatus(kit, kit.template.id, 'archived');
    await expect(reassign(kit, pass.id, email())).rejects.toBeDefined();
    await setStatus(kit, kit.template.id, 'active');
    await reassign(kit, pass.id, email());
    expect((await getPass(kit.env.DB, pass.id))?.releaseId).not.toBeNull();
  }, 120_000);

  it('still requires a reissue for a static barcode on an archived template', async () => {
    const { kit, pass } = await fixedBarcodePass();
    await setStatus(kit, pass.templateId, 'archived');
    await expect(reassign(kit, pass.id, email())).rejects.toMatchObject({
      code: 'PASS_REISSUE_REQUIRED',
    });
  }, 120_000);
});
