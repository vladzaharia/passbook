// Setup shared by the managed-issuer, shared-issuer and key-rotation tests.
import { makeOrg } from '../../../../test/helpers/index.ts';
import { systemClock } from '../../platform/clock.ts';
import { createJobContext, type ServiceContext } from '../../platform/service-context.ts';
import { savePlatformCredential } from './credential-service.ts';
import { installGoogleStub, withQueue } from './google-managed-test-fixtures.ts';
import type { CredentialRow } from './repo-credentials.ts';
import { activePlatformGoogle } from './repo-google-managed.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

export interface ManagedKit {
  k: Kit;
  stub: ReturnType<typeof installGoogleStub>;
  /** A job context whose queue records its messages. */
  ctx: ServiceContext;
  sent: unknown[];
  platform: CredentialRow;
  org: (name?: string, preset?: string) => ReturnType<typeof makeOrg>;
}

/** PassBook's live Google credential, the Google stand-in and a job context. */
export async function managedKit(): Promise<ManagedKit> {
  const k = await kit();
  const stub = installGoogleStub();
  stub.issuers.set('1000000000000001', 'PassBook');
  const { env: queued, sent } = withQueue(k.env);
  const ctx = createJobContext(queued as typeof k.env, 'test', { clock: systemClock });
  const admin = await k.admin('live');
  const existing = await activePlatformGoogle(k.env.DB, 'live');
  if (!existing)
    await savePlatformCredential(k.ctx, admin.auth, {
      provider: 'google',
      mode: 'live',
      expectedRevision: 0,
      credentials: k.google('1000000000000001'),
    });
  const platform = await activePlatformGoogle(k.env.DB, 'live');
  if (!platform) throw new Error('platform credential');
  return {
    k,
    stub,
    ctx,
    sent,
    platform,
    org: (name = 'Test Org', preset = 'legacy') => makeOrg(k.f, { name, preset }),
  };
}
