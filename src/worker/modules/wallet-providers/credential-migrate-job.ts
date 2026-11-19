import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { runCredentialMigrate } from './credential-migrate.ts';

/** `wallet.credential_migrate`: one legacy account onto its credential source (the migrate job grant writes it). */
export async function handleCredentialMigrate(
  job: JobOf<'wallet.credential_migrate'>,
  ctx: ServiceContext,
): Promise<void> {
  await runCredentialMigrate(ctx, job.accountId);
}
