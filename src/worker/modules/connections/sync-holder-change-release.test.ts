// A sync that changes the holder email of an existing pass transfers it under the pass's own release.
import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { resumePendingCredentialTransfers } from '../passes/credential-transfer-resume.ts';
import { type Kit as PassKit, setupKit, TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { resetDeps, setDeps } from './deps.ts';
import { inlineStep, seedConnectionWorkflow } from './runtime-fixtures.ts';
import * as service from './service.ts';
import { executeSync } from './sync-runner.ts';
import { publicResolver } from './test-kit.ts';

const actor = { type: 'user', id: 'admin-1' } as const;
let kit: PassKit & { credentialKeysetCommitment: string };
let n = 0;

beforeAll(async () => {
  const local = await setupKit();
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(local.env.DB, local.env);
  const ctx = createJobContext(local.env, 'connection-test', {
    clock: local.clock,
    log: local.ctx.log,
  });
  await makeUser(local.fx, { id: 'admin-1' });
  kit = { ...local, ctx, credentialKeysetCommitment };
  resetDeps();
  setDeps({ sleep: async () => {}, resolver: publicResolver });
}, 60_000);

async function sync(connectionId: string, generation: number) {
  const id = `holder-${++n}`;
  const params = {
    connectionId,
    orgId: kit.org.id,
    generation,
    credentialKeysetCommitment: kit.credentialKeysetCommitment,
    trigger: 'schedule' as const,
    runId: id,
    instanceId: id,
  };
  await seedConnectionWorkflow(kit.ctx, params);
  await executeSync(kit.ctx, inlineStep(), params);
}

/** A template of its own, so archiving it or moving its head touches no other case. */
async function template(barcode: 'dynamic' | 'static') {
  const base = kit.template;
  const added = kit.registry.add({
    id: `holder-change-${++n}`,
    orgId: kit.org.id,
    version: 'v1',
    manifest: base.manifest,
    passJson:
      barcode === 'static'
        ? {
            ...base.passJson,
            barcodes: [
              {
                format: 'PKBarcodeFormatQR',
                message: 'fixed-credential',
                messageEncoding: 'iso-8859-1',
              },
            ],
          }
        : base.passJson,
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, added, { registry: kit.registry });
  await approveAppleRelease(kit, { templateId: added.id, version: added.version });
  return added.id;
}

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
    assets: { 'icon.png': TINY_PNG },
  });
  await persistTemplate(kit.fx, next, { registry: kit.registry, buildKey: `other-${version}` });
  await approveAppleRelease(kit, { templateId, version });
}

interface Row {
  id: string;
  holder_email: string | null;
  credential_generation: number;
  template_version: string;
  release_id: string | null;
}
const readPass = (connectionId: string) =>
  first<Row>(
    kit.env.DB,
    `SELECT id, holder_email, credential_generation, template_version, release_id
     FROM passes WHERE connection_id = ?`,
    [connectionId],
  );

async function setup(templateId: string, count = 1) {
  const dto = await service.create(kit.ctx, actor, {
    orgId: kit.org.id,
    connectorType: 'demo',
    name: `Demo ${++n}`,
    config: { count, holderDomain: 'first.example.com' },
    mode: 'poll',
    mapping: { memberName: { from: '/memberName' } },
    holderEmailField: '/email',
    autoCreate: true,
    defaultTemplateId: templateId,
  } as never);
  await sync(dto.id, 1);
  await kit.settle();
  const before = await readPass(dto.id);
  expect(before?.release_id).not.toBeNull();
  return { dto, before };
}

async function changeHolder(dto: { id: string }, count = 1) {
  await service.update(kit.ctx, actor, dto.id, {
    config: { count, revision: 1, holderDomain: 'second.example.com' },
  });
  const row = await first<{ generation: number }>(
    kit.env.DB,
    'SELECT generation FROM connections WHERE id = ?',
    [dto.id],
  );
  await sync(dto.id, row?.generation ?? 0);
  await kit.settle();
  await resumePendingCredentialTransfers(jobCtxOf(kit));
  return readPass(dto.id);
}

describe('connection sync changing the holder of an existing pass', () => {
  it.each(['archived', 'behind a head on another build'] as const)(
    'completes the transfer under the pass own release when the template is %s',
    async (state) => {
      const templateId = await template('dynamic');
      const { dto, before } = await setup(templateId);
      if (state === 'archived')
        await run(kit.env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [
          templateId,
        ]);
      else await moveHead(templateId, 'v2');
      const after = await changeHolder(dto);
      expect(after?.holder_email).toBe('m-001@second.example.com');
      expect(after?.credential_generation).toBe((before?.credential_generation ?? 0) + 1);
      expect(after?.template_version).toBe(before?.template_version);
      expect(after?.release_id).toBe(before?.release_id);
      expect(
        await first(
          kit.env.DB,
          `SELECT target_holder_email, source_admitted_release_id FROM pass_credential_transfers
           WHERE pass_id = ?`,
          [before?.id],
        ),
      ).toEqual({
        target_holder_email: 'm-001@second.example.com',
        source_admitted_release_id: before?.release_id,
      });
    },
    120_000,
  );

  it('classifies a static-barcode holder change as PASS_REISSUE_REQUIRED and carries on', async () => {
    const templateId = await template('static');
    const { dto, before } = await setup(templateId, 2);
    const passes = await all<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM passes WHERE connection_id = ? ORDER BY external_ref',
      [dto.id],
    );
    expect(passes).toHaveLength(2);
    await changeHolder(dto, 2);
    for (const { id } of passes) {
      expect(
        await first(
          kit.env.DB,
          'SELECT holder_email, credential_generation, sync_error_code FROM passes WHERE id = ?',
          [id],
        ),
      ).toMatchObject({
        holder_email: expect.stringContaining('@first.example.com'),
        credential_generation: before?.credential_generation,
        sync_error_code: 'PASS_REISSUE_REQUIRED',
      });
    }
    const last = await first<{ outcome: string; error_code: string | null; records_seen: number }>(
      kit.env.DB,
      'SELECT outcome, error_code, records_seen FROM connection_runs WHERE connection_id = ? ORDER BY rowid DESC LIMIT 1',
      [dto.id],
    );
    expect(last?.error_code).not.toBe('INTERNAL');
    expect(last?.records_seen).toBe(2);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_transfers WHERE pass_id = ?', [
        passes[0]?.id,
      ]),
    ).toBeNull();
  }, 120_000);
});
