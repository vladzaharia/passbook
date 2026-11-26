import { requireCaller } from '../../platform/auth.ts';
import { TRY_TOKEN_PREFIX } from '../../platform/browser-signals.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import { requireTenantSession, requireTenantSessionOrApiKey } from '../passes/http.ts';

/** Writes that declare their own `auth` (keys included): the router guard leaves them to it. */
const OWN_AUTH_WRITES =
  /^\/api\/v1\/templates\/[^/]+\/(use|candidates|candidates\/[^/]+\/approve|releases|release|review|review-requests|preview)\/?$/;

// A version save and its dry run also take a Workbench token (Test only: design §2.3), through the same
// `requireCaller` path the token's other writes use. A plain API key still gets the session guard's 401.
const VERSION_SAVE = /^\/api\/v1\/templates\/[^/]+\/versions\/?$/;
const tokenVersionSave = requireCaller({
  scope: 'templates:write',
  capability: 'templates:author',
});

// Template reads allow scoped API keys; mutations require a session and are authorized per org.
// The scan setup route declares its own `auth` (a session or a `scanning:write` key).
const SCAN_SETUP = /^\/api\/v1\/templates\/[^/]+\/scan-setup$/;
/** The router's one guard: who may call which template route. */
export const templatesGuard = declareKeyAccess(
  async (c, next) =>
    c.req.method === 'POST' && (SCAN_SETUP.test(c.req.path) || OWN_AUTH_WRITES.test(c.req.path))
      ? next()
      : c.req.method === 'POST' &&
          VERSION_SAVE.test(c.req.path) &&
          c.req.header('authorization')?.toLowerCase().includes(TRY_TOKEN_PREFIX)
        ? tokenVersionSave(c, next)
        : c.req.method === 'GET'
          ? requireTenantSessionOrApiKey(
              /\/templates\/eligible\/?$/.test(c.req.path)
                ? ['templates:read', 'passes:read']
                : 'templates:read',
            )(c, next)
          : requireTenantSession(c, next),
  { read: ['templates:read'] },
);
