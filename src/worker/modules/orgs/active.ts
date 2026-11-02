import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from './repo.ts';

/** Org suspension gate for public pages, Apple endpoints, connections and webhooks. */
export const isOrgActive = (ctx: ServiceContext, orgId: string): Promise<boolean> =>
  orgIsActive(ctx.env.DB, orgId);
