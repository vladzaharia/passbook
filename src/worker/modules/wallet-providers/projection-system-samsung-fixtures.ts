import { vi } from 'vitest';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import type { SamsungWalletCredentials } from '../../../shared/contracts/wallet-providers.ts';
import type { Kit as PassKit } from '../passes/pass-test-fixtures.ts';
import { enrolOn } from './enrolled-test-fixtures.ts';
import { type Kit, S } from './projection-v2-test-fixtures.ts';

/** A real Samsung enrolment (an org credential, its source, On) for a projection kit; the identity is unique. */
export async function enrolSamsung(kit: Kit): Promise<SamsungWalletCredentials> {
  const identity = await createFixtureIdentity(undefined, { now: new Date(S.clock.now()) });
  const unique = `${Date.now()}${Math.floor(Math.random() * 1e3)}`;
  const samsung: SamsungWalletCredentials = {
    partnerId: `partner${unique}`,
    certificateId: 'ABCD',
    cardId: `card${unique}`,
    partnerPrivateKeyPem: identity.privateKey,
    partnerCertificatePem: identity.certificate,
    samsungCertificatePem: identity.certificate,
  };
  await enrolOn(
    { env: S.env, org: { id: kit.orgId }, ctx: kit.ctx } as unknown as PassKit,
    kit.author,
    { provider: 'samsung', expectedRevision: 0, credentials: samsung },
  );
  return samsung;
}

/** The card read a Samsung release needs: a loyalty card in `state` (Live needs ACTIVE and launched). */
export function samsungCard(samsung: SamsungWalletCredentials, state = 'ACTIVE') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({
      resultCode: '0',
      template: {
        cardId: samsung.cardId,
        state,
        testingModeOff: 'Y',
        cardType: 'loyalty',
        subType: 'others',
        countryCode: 'GB',
      },
    }),
  );
}
