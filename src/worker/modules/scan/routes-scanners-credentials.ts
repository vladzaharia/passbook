import { z } from 'zod';
import {
  CreatedScannerSchema,
  CreateScannerSchema,
  IdParamSchema,
  ScannerPairingSchema,
  ScannerPairingStateSchema,
  TerminalTokenSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { clientIp } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, type C, tenantAuthorityOf } from '../passes/http.ts';
import { credentialOnce, withoutSecrets } from './credential-once.ts';
import { charged } from './key-credentials.ts';
import { withoutNames } from './key-names.ts';
import { createPairing, pairingState } from './pairing.ts';
import { replaceTerminalToken } from './pairing-token.ts';
import { loadScanner } from './scanner-views.ts';
import { createScanner } from './scanners.ts';
import { scopedScanningView } from './scanning-workspace.ts';
import { scannerAuthority } from './target-authority.ts';

type Router = ReturnType<typeof createRouter>;

/** `?restore=true` lets a pairing, pair-here or token call bring a removed scanner back (audited). */
export const RestoreQuerySchema = z.object({ restore: z.enum(['true']).optional() });
export const restoreOf = (q: z.infer<typeof RestoreQuerySchema>) => q.restore === 'true';

const ADMIN = {
  scope: 'scanning:admin',
  capability: 'scanning:manage',
  feature: 'scanning.devices',
} as const;
/** The poll is a read: a `scan-setup:read` key follows a pairing it did not make. */
const READ = { scope: 'scan-setup:read', capability: 'scanning:read' } as const;

/**
 * The scanner and its caller (the org check is `scannerAuthority`, which 404s every key whose org
 * differs, platform keys included: keep it, never `tenantAuthorityOf` alone): a console session by membership, or an org-bound key under its own
 * principal. The scanner loads in the caller's mode, and a key of another org (or a platform key)
 * finds no such scanner, the same answer as a missing id.
 */
async function target(c: C, id: string, capability: 'scanning:manage' | 'scanning:read') {
  const ctx = serviceContext(c);
  const auth = authOf(c);
  if (auth.kind !== 'session' && auth.kind !== 'api_key') throw new UnauthenticatedError();
  const row = await loadScanner(ctx, id, modeOf(auth));
  const authority = await scannerAuthority(ctx, auth, row.orgId, capability);
  const actorId = auth.kind === 'api_key' ? auth.keyId : currentUserId(c);
  return { ctx, row, authority, actorId, ip: ipPrefix(clientIp(c)) };
}

/**
 * Pairing code, its poll and the till token: a console session, or a live org-bound `scanning:admin`
 * key. The code and the token are in the answer of the call that made them and nowhere else; with an
 * `Idempotency-Key` a replay returns the same answer with the secret null. Registered before the
 * session guard.
 */
export function registerScannerCredentials(router: Router): void {
  register(
    router,
    'scanners',
    {
      method: 'post',
      path: '/',
      summary: 'Create a scanner (a device comes with a pairing code)',
      auth: { ...ADMIN, scope: ['scanning:admin', 'scanning:write'] },
      body: CreateScannerSchema,
      status: 201,
      response: CreatedScannerSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const auth = authOf(c);
      if (auth.kind !== 'session' && auth.kind !== 'api_key') throw new UnauthenticatedError();
      const input = c.req.valid('json');
      if (auth.kind === 'api_key' && auth.orgId !== input.orgId)
        throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
      const authority = await tenantAuthorityOf(ctx, auth, input.orgId, 'scanning:manage');
      const actorId = auth.kind === 'api_key' ? auth.keyId : currentUserId(c);
      const origin = new URL(c.req.url).origin;
      const code =
        authority.kind === 'api_key' &&
        authority.scope === 'scanning:admin' &&
        input.kind === 'device';
      return credentialOnce(c, ctx, {
        orgId: input.orgId,
        body: input,
        status: 201,
        execute: async () =>
          charged(ctx, authority, code ? 1 : 0, async (committed) => {
            const made = await createScanner(
              ctx,
              actorId,
              modeOf(auth),
              input,
              origin,
              authority,
              ipPrefix(clientIp(c)),
              committed,
            );
            return scopedScanningView(
              auth.kind === 'api_key' ? withoutNames(made) : made,
              input.orgId,
            );
          }),
        redact: (v) => withoutSecrets(CreatedScannerSchema, v, ['pairing']),
      });
    },
  );
  register(
    router,
    'scanners',
    {
      method: 'post',
      path: '/{id}/pairing',
      summary: 'A new pairing code (replaces any live one)',
      auth: ADMIN,
      params: IdParamSchema,
      query: RestoreQuerySchema,
      response: ScannerPairingSchema,
    },
    async (c) => {
      const t = await target(c, c.req.valid('param').id, 'scanning:manage');
      const restore = restoreOf(c.req.valid('query'));
      const origin = new URL(c.req.url).origin;
      return credentialOnce(c, t.ctx, {
        orgId: t.row.orgId,
        body: { restore },
        status: 200,
        execute: () =>
          charged(t.ctx, t.authority, 1, () =>
            createPairing(t.ctx, t.actorId, t.row, origin, t.authority, restore, t.ip),
          ),
        redact: (p) => ({ code: null, url: null, expiresAt: p.expiresAt }),
      });
    },
  );
  register(
    router,
    'scanners',
    {
      method: 'get',
      path: '/{id}/pairing',
      summary: 'Poll a pairing',
      auth: READ,
      params: IdParamSchema,
      response: ScannerPairingStateSchema,
    },
    async (c) => {
      const t = await target(c, c.req.valid('param').id, 'scanning:read');
      return c.json(pairingState(t.row, t.ctx.clock.now()));
    },
  );
  register(
    router,
    'scanners',
    {
      method: 'post',
      path: '/{id}/token',
      summary: 'A till token, shown once (replaces the old one)',
      auth: ADMIN,
      params: IdParamSchema,
      query: RestoreQuerySchema,
      response: TerminalTokenSchema,
    },
    async (c) => {
      const t = await target(c, c.req.valid('param').id, 'scanning:manage');
      const restore = restoreOf(c.req.valid('query'));
      c.header('cache-control', 'no-store');
      return credentialOnce(c, t.ctx, {
        orgId: t.row.orgId,
        body: { restore },
        status: 200,
        execute: () =>
          charged(t.ctx, t.authority, 1, () =>
            replaceTerminalToken(t.ctx, t.actorId, t.row, t.authority, restore, t.ip),
          ),
        redact: (r) => ({ token: null, expiresAt: r.expiresAt }),
      });
    },
  );
}
