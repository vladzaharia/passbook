import { env } from 'cloudflare:workers';
import { createJobContext, type ServiceContext } from '../../platform/service-context.ts';

/** A queue or cron context over the test database (or a wrapped one), for the provider queue's grants. */
export function walletJobCtx(db: D1Database = env.DB): ServiceContext {
  const ctx = createJobContext(env, 'test');
  return db === env.DB ? ctx : { ...ctx, env: { ...ctx.env, DB: db } };
}
