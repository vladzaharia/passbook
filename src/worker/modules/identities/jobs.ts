import type { JobOf } from '../../jobs/types.ts';
import { NotImplementedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export async function handleIdentityCheck(
  _job: JobOf<'identity.check'>,
  _ctx: ServiceContext,
): Promise<void> {
  throw new NotImplementedError('identity.check is not implemented yet.');
}

export async function dailyIdentities(_ctx: ServiceContext): Promise<void> {}
