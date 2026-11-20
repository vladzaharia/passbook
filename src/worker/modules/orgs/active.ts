import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive, orgServesPass } from './repo.ts';

/** Org suspension gate for public pages, Apple endpoints, connections and webhooks. */
/** The org serves this pass: it is active, or closed and the pass voided (its last push). */
export const isOrgServingPass = (ctx: ServiceContext, passId: string): Promise<boolean> =>
  orgServesPass(ctx.env.DB, passId);

export const isOrgActive = (ctx: ServiceContext, orgId: string): Promise<boolean> =>
  orgIsActive(ctx.env.DB, orgId);
