import { beforeAll, expect } from 'vitest';
import type { ScannerFixture } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { finishCredentialTransfer } from '../passes/credential-transfer.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { claimRemoval, getPassLifecycle, releaseRemoval } from '../passes/repo-remove.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { getWalletInstanceById, getWalletOperation } from '../wallet-providers/instance.ts';
import { reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import { runWalletProviderOperation } from '../wallet-providers/sync-operation.ts';
import { outputRaceDatabase } from './output-authority-race-database-test-fixtures.ts';
import { type Candidate, candidateById } from './repo-lookup.ts';
import { key, type ScanKit, setupScanKit, startScanCredentialTransfer } from './test-kit.ts';

export let kit: ScanKit;
export let templateId: string;
export const name = 'Output Fence Private Person';
const email = 'output-fence-private@example.test';
export const system = { type: 'system' as const, id: null };

interface OutputFixture {
  pass: Pass;
  candidate: Candidate;
  scanner: ScannerFixture;
}

beforeAll(async () => {
  kit = await setupScanKit();
  templateId = await kit.scanTemplate('Output authority race', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    lookup: { input: 'memberNo' },
    flags: [{ input: 'tier', label: 'Review', equals: ['overdue'], stop: true }],
    display: { v: 1, header: {}, photo: { minRole: 'door' } },
  });
});

/** Mutate after projection, immediately before the selected output or actor authority read. */
export function raceFence(real: D1Database, change: () => Promise<unknown>, occurrence = 1) {
  let calls = 0;
  let fired = false;
  const trigger = async () => {
    calls++;
    if (!fired && calls === occurrence) {
      fired = true;
      await change();
    }
  };
  const db = outputRaceDatabase(real, trigger);
  return { db, fired: () => fired };
}

export async function fixture(
  options: {
    mode?: 'live' | 'test';
    tier?: string;
    photo?: boolean;
    lagWallet?: boolean;
    memberName?: string;
    memberNo?: string;
  } = {},
): Promise<OutputFixture> {
  const pass = await kit.scanPass(
    templateId,
    {
      memberName: options.memberName ?? name,
      tier: options.tier ?? 'gold',
      ...(options.memberNo ? { memberNo: options.memberNo } : {}),
    },
    { mode: options.mode ?? 'live', holderEmail: email },
  );
  if (options.photo)
    await putMemberPhoto(
      kit.ctx,
      system,
      pass.id,
      {
        png: btoa(String.fromCharCode(...makePng(270, 270))),
        includeInPass: false,
      },
      null,
    );
  if (options.lagWallet)
    await run(kit.env.DB, 'UPDATE passes SET version=version+1 WHERE id=?', [pass.id]);
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!candidate || candidate.walletVersion === null || !candidate.activeTemplateVersion)
    throw new Error('Missing candidate snapshot.');
  const scanner = await kit.scanner({ templateIds: [templateId] });
  return { pass, candidate, scanner };
}

export function noDisclosure(text: string, passId: string) {
  expect(text).not.toContain(passId);
  expect(text).not.toContain(name);
  expect(text).not.toContain(email);
  expect(text).not.toContain('member.png');
  expect(text).not.toContain('assetGrant');
}

/** Exercise a genuine removal-claim rollback that restores state while advancing its epoch. */
export async function rollbackRemoval(db: D1Database, passId: string, now: number) {
  const pass = await getPass(db, passId, null);
  if (!pass) throw new Error('Missing pass for lifecycle race.');
  const lifecycle = await getPassLifecycle(db, pass);
  if (!lifecycle) throw new Error('Missing lifecycle snapshot.');
  const state = { at: now, message: null, priorStatus: pass.status };
  const generation = await claimRemoval(db, passId, state, {
    pass,
    generation: lifecycle.generation,
    now,
  });
  if (generation === null) throw new Error('Unable to claim removal.');
  await releaseRemoval(db, passId, { pass, state, generation });
  const after = await getPassLifecycle(db, pass);
  if (!after || after.generation !== lifecycle.generation + 2)
    throw new Error('Removal rollback did not advance lifecycle twice.');
}

/** A pending provider incarnation can settle only after its real revoke has completed. */
export async function finishProviderTransfer(
  kit: Pick<ScanKit, 'env' | 'ctx' | 'clock'>,
  pass: Pass,
  instanceId: string,
  transferId: string,
  credentialKeysetCommitment: string,
) {
  const db = kit.env.DB;
  expect(await finishCredentialTransfer(jobCtxOf(kit), transferId)).toMatchObject({
    state: 'pending',
  });
  kit.clock.advance(300_001);
  const scope = {
    orgId: pass.orgId,
    mode: pass.mode,
    provider: 'samsung' as const,
    instanceId,
    credentialKeysetCommitment,
  };
  const instance = await getWalletInstanceById(db, scope);
  if (!instance) throw new Error('Missing provider instance.');
  expect(await reconcileWalletInstance(kit.ctx, instance)).toBe('scheduled');
  const retiring = await getWalletInstanceById(db, scope);
  if (!retiring) throw new Error('Missing retiring instance.');
  const revoke = await getWalletOperation(db, { ...scope, version: retiring.desiredVersion });
  if (!revoke) throw new Error('Missing provider revoke.');
  expect(revoke).toMatchObject({ kind: 'revoke', state: 'pending' });
  expect(await runWalletProviderOperation(kit.ctx, revoke)).toBe('completed');
  expect(await getWalletInstanceById(db, scope)).toMatchObject({ lifecycle: 'retired' });
  expect(await finishCredentialTransfer(jobCtxOf(kit), transferId)).toMatchObject({
    state: 'completed',
  });
}

export async function providerFixture() {
  const template = await kit.registry.resolve(templateId);
  const apple = await approveAppleRelease(kit, { templateId, version: template.version });
  const pass = await kit.scanPass(
    templateId,
    { memberName: 'Transfer Source Member' },
    { holderEmail: 'transfer-old@example.test' },
  );
  return setupSamsungCallbacks({
    promoted: false,
    source: { kit: { ...kit, template }, apple, pass, barcode: 'qr' },
  });
}

type Change =
  | 'scanner'
  | 'quarantine'
  | 'wallet'
  | 'wallet-personalization'
  | 'wallet-lineage'
  | 'wallet-version'
  | 'identity-aba'
  | 'credential-generation'
  | 'lifecycle-generation'
  | 'release'
  | 'rules'
  | 'photo'
  | 'photo-version'
  | 'photo-key'
  | 'photo-digest'
  | 'photo-inclusion'
  | 'photo-aba'
  | 'source-privacy';

export async function changeAfterProjection(f: OutputFixture, db: D1Database, change: Change) {
  const { pass, candidate, scanner } = f;
  if (change === 'scanner') {
    await run(db, 'UPDATE scanners SET revoked_at=? WHERE id=?', [kit.clock.now(), scanner.id]);
  } else if (change === 'quarantine') {
    await run(db, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [pass.id]);
  } else if (change === 'credential-generation') {
    const current = await getPass(db, pass.id, null);
    if (!current) throw new Error('Missing transfer source');
    if (current.status === 'voided')
      await run(db, "UPDATE passes SET status='active' WHERE id=?", [pass.id]);
    try {
      expect((await startScanCredentialTransfer(kit, pass.id, { db })).state).toBe('completed');
    } finally {
      if (current.status === 'voided')
        await run(db, "UPDATE passes SET status='voided' WHERE id=?", [pass.id]);
    }
  } else if (change === 'lifecycle-generation') {
    await rollbackRemoval(db, pass.id, kit.clock.now());
  } else if (change === 'wallet') {
    await run(
      db,
      "UPDATE pass_versions SET pass_json=json_set(pass_json,'$.description','changed') WHERE pass_id=? AND version=?",
      [pass.id, candidate.walletVersion],
    );
  } else if (change === 'wallet-personalization') {
    await run(db, "UPDATE pass_versions SET personalization='[]' WHERE pass_id=? AND version=?", [
      pass.id,
      candidate.walletVersion,
    ]);
  } else if (change === 'wallet-lineage') {
    await run(db, 'UPDATE pass_versions SET template_version=? WHERE pass_id=? AND version=?', [
      `${candidate.walletTemplateVersion}-changed`,
      pass.id,
      candidate.walletVersion,
    ]);
  } else if (change === 'wallet-version') {
    await run(
      db,
      `INSERT INTO pass_versions
      (pass_id,version,object_key,object_sha256,template_version,personalization,pass_json,cause,actor_type,actor_id,created_at,purged_at)
      SELECT pass_id,?,object_key,object_sha256,template_version,personalization,pass_json,cause,actor_type,actor_id,created_at,purged_at
      FROM pass_versions WHERE pass_id=? AND version=?`,
      [candidate.pass.version, pass.id, candidate.walletVersion],
    );
  } else if (change === 'identity-aba') {
    const team = candidate.identityTeamIdentifier;
    if (!team) throw new Error('Missing identity snapshot.');
    await run(db, 'UPDATE signing_identities SET team_identifier=? WHERE id=?', [
      `${team}-changed`,
      pass.identityId,
    ]);
    await run(db, 'UPDATE signing_identities SET team_identifier=? WHERE id=?', [
      team,
      pass.identityId,
    ]);
  } else if (change === 'release') {
    if (!candidate.activeTemplateVersion) throw new Error('Missing active template version.');
    await approveAppleRelease(kit, {
      db,
      templateId,
      mode: candidate.pass.mode,
      version: candidate.activeTemplateVersion,
    });
  } else if (change === 'photo') {
    await run(db, 'DELETE FROM member_photos WHERE org_id=? AND pass_id=?', [kit.org.id, pass.id]);
  } else if (change === 'photo-version') {
    await run(
      db,
      "UPDATE member_photos SET version=version||'-changed' WHERE org_id=? AND pass_id=?",
      [kit.org.id, pass.id],
    );
  } else if (change === 'photo-key') {
    await run(
      db,
      "UPDATE member_photos SET r2_key=r2_key||'-changed' WHERE org_id=? AND pass_id=?",
      [kit.org.id, pass.id],
    );
  } else if (change === 'photo-digest') {
    await run(db, "UPDATE member_photos SET sha1=sha1||'-changed' WHERE org_id=? AND pass_id=?", [
      kit.org.id,
      pass.id,
    ]);
  } else if (change === 'photo-inclusion') {
    await run(
      db,
      'UPDATE member_photos SET include_in_pass=1-include_in_pass WHERE org_id=? AND pass_id=?',
      [kit.org.id, pass.id],
    );
  } else if (change === 'photo-aba') {
    await run(
      db,
      'UPDATE member_photos SET include_in_pass=1-include_in_pass WHERE org_id=? AND pass_id=?',
      [kit.org.id, pass.id],
    );
    await run(
      db,
      'UPDATE member_photos SET include_in_pass=1-include_in_pass WHERE org_id=? AND pass_id=?',
      [kit.org.id, pass.id],
    );
  } else if (change === 'source-privacy') {
    await run(db, 'UPDATE passes SET external_id=? WHERE id=?', [name, pass.id]);
  } else {
    await run(
      db,
      `INSERT INTO pass_check_in(pass_id,org_id,rules,updated_at) VALUES (?,?,'{"mode":"single"}',?)
      ON CONFLICT(pass_id) DO UPDATE SET rules=excluded.rules,updated_at=excluded.updated_at`,
      [pass.id, kit.org.id, kit.clock.now()],
    );
  }
}

export async function racedResolve(f: OutputFixture, change: Change) {
  const real = kit.env.DB;
  const race = raceFence(real, () => changeAfterProjection(f, real, change));
  Object.assign(kit.env, { DB: race.db });
  try {
    const response = await kit.post(f.scanner.headers, '/resolve', {
      idempotencyKey: key(),
      input: { passId: f.pass.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    expect(race.fired()).toBe(true);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      card: null,
      display: null,
      template: null,
    });
    noDisclosure(text, f.pass.id);
  } finally {
    Object.assign(kit.env, { DB: real });
  }
}
