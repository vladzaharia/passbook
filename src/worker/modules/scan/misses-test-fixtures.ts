import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { grantReadMiss } from './misses.ts';
import { missWindow } from './repo-miss-authority.ts';
import { captureTestEpochs } from './test-kit-epochs.ts';

/** Count a confirmed read-only miss without credential input, in its own grant. */
export async function countMiss(ctx: ServiceContext, actor: ScanActor): Promise<void> {
  await captureTestEpochs(ctx, actor);
  await grantReadMiss(ctx, actor, {
    refs: [],
    unchanged: missWindow('{org} IS NOT NULL', []),
  });
}
