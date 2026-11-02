import type { ServiceContext } from '../../platform/service-context.ts';
import { syncBakedTemplates } from './sync.ts';

/** After a deploy the first minute tick copies the baked assets, so no request pays for it. */
export const syncBakedOnDeploy = (ctx: ServiceContext) => syncBakedTemplates(ctx);
