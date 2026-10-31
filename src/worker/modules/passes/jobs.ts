import type { JobOf } from '../../jobs/types.ts';
import { NotImplementedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export async function handlePassReissue(
  _job: JobOf<'pass.reissue'>,
  _ctx: ServiceContext,
): Promise<void> {
  throw new NotImplementedError('pass.reissue is not implemented yet.');
}

export async function handlePassPurgeVersions(
  _job: JobOf<'pass.purge-versions'>,
  _ctx: ServiceContext,
): Promise<void> {
  throw new NotImplementedError('pass.purge-versions is not implemented yet.');
}

export async function dailyPasses(_ctx: ServiceContext): Promise<void> {}
