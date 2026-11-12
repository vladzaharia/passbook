import { expect, it } from 'vitest';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { grantInsertConfirmed } from './asset-grant-results.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import {
  assetGrantValid,
  confirmAssetGrantToken,
  mintAssetGrant,
  prepareGenericAssetGrant,
} from './assets.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { candidateById } from './repo-lookup.ts';
import { setupScanKit } from './test-kit.ts';

it('pins one KEK snapshot across asynchronous asset mint and redemption', async () => {
  const kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const template = await kit.scanTemplate('Asset key capture', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const device = await kit.scanner({ templateIds: [template] });
  const actor = await assetActorFor(kit, device);
  const pass = await kit.scanPass(template, { memberName: 'Key capture fixture' });
  if (!pass.scanCode) throw new Error('Scan code missing');
  const keys = await scanCredentialKeys(kit.env, kit.org.id, 'live', pass.scanCode, false);
  const original = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!original) throw new Error('Candidate missing');
  const snapshot = { ...original, credentialTombstoneRefs: keys.credentialTombstoneRefs };
  expect(snapshot.credentialKeysetCommitment).toBe(keys.credentialKeysetCommitment);

  const oldKey = kit.env.KEK_V1;
  const replacement = btoa(String.fromCharCode(...new Uint8Array(32).fill(29)));
  let token: string;
  try {
    const pending = mintAssetGrant(
      kit.ctx,
      actor,
      snapshot,
      snapshot.connectionGeneration,
      snapshot.activeTemplateVersion,
    );
    kit.env.KEK_V1 = replacement;
    token = await pending;
  } finally {
    kit.env.KEK_V1 = oldKey;
  }

  try {
    const pending = assetGrantValid(kit.ctx, actor, snapshot, snapshot.connectionGeneration, token);
    kit.env.KEK_V1 = replacement;
    expect(await pending).toBe(true);
  } finally {
    kit.env.KEK_V1 = oldKey;
  }

  const deferred = await prepareGenericAssetGrant(
    kit.ctx,
    actor,
    snapshot,
    snapshot.connectionGeneration,
    snapshot.activeTemplateVersion,
    'commit',
  );
  if (!deferred) throw new Error('Generic grant plan missing');
  expect(confirmAssetGrantToken(deferred, undefined)).toBeNull();
  const alteredSnapshots = [
    { ...snapshot, pass: { ...snapshot.pass, authToken: `${snapshot.pass.authToken}-altered` } },
    { ...snapshot, passJsonSnapshot: `${snapshot.passJsonSnapshot ?? ''} ` },
    {
      ...snapshot,
      pass: {
        ...snapshot.pass,
        personalization: {
          ...snapshot.pass.personalization,
          testChange: 'altered',
        },
      },
    },
  ];
  for (const altered of alteredSnapshots) {
    const bind = await prepareAssetGrantInsertion(kit.ctx, deferred, undefined, altered);
    await expect(kit.env.DB.batch(bind(kit.clock.now(), undefined))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
  }
  const originalAuthToken = snapshot.pass.authToken;
  const pendingInsert = prepareAssetGrantInsertion(kit.ctx, deferred, undefined, snapshot);
  snapshot.pass.authToken = `${originalAuthToken}-changed`;
  try {
    const bind = await pendingInsert;
    await expect(kit.env.DB.batch(bind(kit.clock.now(), undefined))).rejects.toThrow(
      'scan_asset_authority_failed',
    );
  } finally {
    snapshot.pass.authToken = originalAuthToken;
  }
  const bind = await prepareAssetGrantInsertion(kit.ctx, deferred, undefined, snapshot);
  const inserted = await kit.env.DB.batch(bind(kit.clock.now(), undefined));
  expect(grantInsertConfirmed(inserted)).toBe(true);
  const deferredToken = confirmAssetGrantToken(deferred, inserted);
  if (!deferredToken) throw new Error('Confirmed generic asset grant missing');
  expect(
    await assetGrantValid(kit.ctx, actor, snapshot, snapshot.connectionGeneration, deferredToken),
  ).toBe(true);
});
