import { expect, it } from 'vitest';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { assetGrantValid, mintAssetGrant } from './asset-grant-test-fixtures.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { scanCredentialKeys } from './credential-input.ts';
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

  // Any change to the evaluated snapshot is a different capability: the tag no longer matches.
  const alteredSnapshots = [
    { ...snapshot, pass: { ...snapshot.pass, authToken: `${snapshot.pass.authToken}-altered` } },
    { ...snapshot, passJsonSnapshot: `${snapshot.passJsonSnapshot ?? ''} ` },
    {
      ...snapshot,
      pass: {
        ...snapshot.pass,
        personalization: { ...snapshot.pass.personalization, testChange: 'altered' },
      },
    },
  ];
  for (const altered of alteredSnapshots)
    expect(
      await assetGrantValid(kit.ctx, actor, altered, snapshot.connectionGeneration, token),
    ).toBe(false);
  // Positive control: the unaltered snapshot still redeems.
  expect(
    await assetGrantValid(kit.ctx, actor, snapshot, snapshot.connectionGeneration, token),
  ).toBe(true);
});
