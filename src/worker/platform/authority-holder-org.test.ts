import { describe, expect, it } from 'vitest';
import { makePass } from '../../../test/helpers/index.ts';
import { grant } from './authority.ts';
import { codeOf, db, refusal } from './authority-ext-fixtures.ts';
import type { HolderProof, Principal } from './authority-principal.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first, run } from './db.ts';
import { sha256Hex } from './ids.ts';

type Setup = Awaited<ReturnType<typeof setupGrant>>;
const PURPOSE = {
  session: 'org_mode.pass.holder_remove',
  verified_email: 'org_mode.pass.holder_attach',
  device: 'org_mode.pass.personalize',
} as const;

const holder = (passId: string, proof: HolderProof): Principal => ({
  kind: 'holder',
  passId,
  proof,
});
const commit = (x: Setup, passId: string, proof: HolderProof) =>
  grant(x.route, { purpose: PURPOSE[proof.via], principal: holder(passId, proof) }).commit();
const setOrg = (x: Setup, status: 'active' | 'suspended' | 'deleted') =>
  run(db, 'UPDATE orgs SET status = ? WHERE id = ?', [status, x.s.org.id]);

/** One pass per proof: owned (session), waiting for a verified address (verified_email), any (device). */
async function proofs(label: string) {
  const x = await setupGrant(label);
  const owned = await makePass(x.s.f, {
    orgId: x.s.org.id,
    template: x.s.template.resolved,
    ownerUserId: x.s.user.id,
  });
  const address = `${label}@example.com`;
  const waiting = await makePass(x.s.f, {
    orgId: x.s.org.id,
    template: x.s.template.resolved,
    holderEmail: address,
  });
  await run(
    db,
    "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES (?, ?, 'magic_link', 1)",
    [address, x.s.user.id],
  );
  const device = await first<{
    identity_id: string;
    serial: string;
    auth_token: string;
    credential_generation: number;
  }>(db, 'SELECT identity_id, serial, auth_token, credential_generation FROM passes WHERE id = ?', [
    x.s.pass.id,
  ]);
  const cases: [HolderProof['via'], string, HolderProof][] = [
    [
      'session',
      owned.id,
      {
        via: 'session',
        userId: x.s.user.id,
        sessionIdHash: await sha256Hex(x.s.session.cookieValue),
      },
    ],
    ['verified_email', waiting.id, { via: 'verified_email', userId: x.s.user.id }],
    [
      'device',
      x.s.pass.id,
      {
        via: 'device',
        identityId: device?.identity_id ?? '',
        serial: device?.serial ?? '',
        authToken: device?.auth_token ?? '',
        credentialGeneration: device?.credential_generation ?? 0,
      },
    ],
  ];
  return { x, cases };
}

describe('holder principals and an inactive org (37)', () => {
  it('every proof commits while the org is active (positive control)', async () => {
    const { x, cases } = await proofs('ho-active');
    for (const [via, passId, proof] of cases)
      await expect(commit(x, passId, proof), via).resolves.toBeDefined();
  });

  it.each(['suspended', 'deleted'] as const)(
    'only the session holder (holder_remove) acts when the org is %s',
    async (status) => {
      const { x, cases } = await proofs(`ho-${status}`);
      await setOrg(x, status);
      for (const [via, passId, proof] of cases)
        if (via === 'session') await expect(commit(x, passId, proof), via).resolves.toBeDefined();
        else
          expect(await refusal(commit(x, passId, proof)), via).toMatchObject({
            code: 'ORG_ACCESS_CHANGED',
          });
    },
  );

  it('a session holder still holds holder_remove only', async () => {
    const { x, cases } = await proofs('ho-purpose');
    await setOrg(x, 'suspended');
    const [, passId, proof] = cases[0] ?? [];
    if (!passId || !proof) throw new Error('Missing session case');
    for (const purpose of [PURPOSE.verified_email, PURPOSE.device, 'org_mode.pass.publish'])
      expect(
        codeOf(() => grant(x.route, { purpose, principal: holder(passId, proof) })),
        purpose,
      ).toBe('GRANT_BAD_PRINCIPAL');
  });
});
