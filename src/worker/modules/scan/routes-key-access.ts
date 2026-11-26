import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../../platform/context.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';

/** A till's `scans:write` key (guard-api-key.ts) may call these; the actor guards admit it. Document only. */
export const tillKeyAccess = declareKeyAccess(
  createMiddleware<AppBindings>((_c, next) => next()),
  {
    read: [],
    write: ['scans:write'],
    documentOnly: true,
    only: /\/scan\/(?:resolve|actions|sign-out|scans\/\{scanId\}\/undo)$/,
  },
);
