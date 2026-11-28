import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  ScanPairPreviewSchema,
  ScanPairRequestSchema,
  ScanSessionSchema,
} from '../../../shared/contracts/index.ts';
import { SCANNER_COOKIE } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { sameOriginOnly } from '../../platform/csrf.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientRatePrefix, rateLimit } from '../../platform/rate-limit.ts';
import { ownUse, wholeMountUse } from '../../platform/router-scope.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { completePairing, previewPairing, unpair } from './pairing.ts';
import { pairedSession } from './pairing-session.ts';

/** 180 days, as the token's own expiry. */
const COOKIE_MAX_AGE_S = 15_552_000;

export function setScannerCookie(c: Context<AppBindings>, token: string): void {
  setCookie(c, SCANNER_COOKIE, token, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: COOKIE_MAX_AGE_S,
  });
}

const ipOf = (c: Context<AppBindings>) => ipPrefix(c.req.header('cf-connecting-ip'));

/** Pairing, public: /api/v1/scan/pair*, and /unpair. Same-origin, rate limited per IP. */
export const scanPairRoutes = createRouter();
// This router is mounted over the whole scan API. A terminal's or a till's bearer is no ambient
// credential (a cross-site page cannot set it), so only those requests skip the origin check.
const BEARER = /^Bearer\s+(?:wls|wlt|pb|pbp|pbo)_\S+$/i;
wholeMountUse(scanPairRoutes, (c, next) =>
  BEARER.test(c.req.header('authorization') ?? '') ? next() : sameOriginOnly(c, next),
);
// A pairing code is a guess target: key on the /24 or /64, not the full address.
scanPairRoutes.use('/pair/*', rateLimit('RL_SCAN_PAIR', clientRatePrefix));
scanPairRoutes.use('/pair', rateLimit('RL_SCAN_PAIR', clientRatePrefix));
ownUse(scanPairRoutes, limitBody(4 * 1024));

register(
  scanPairRoutes,
  'scan',
  {
    method: 'post',
    path: '/pair/preview',
    summary: 'What a pairing code is for (consumes nothing)',
    body: ScanPairRequestSchema,
    response: ScanPairPreviewSchema,
  },
  async (c) =>
    c.json(await previewPairing(serviceContext(c), ipOf(c), c.req.valid('json').code), 200, {
      'cache-control': 'no-store',
    }),
);
register(
  scanPairRoutes,
  'scan',
  {
    method: 'post',
    path: '/pair',
    summary: 'Pair this browser as a scanner',
    body: ScanPairRequestSchema,
    response: ScanSessionSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const paired = await completePairing(
      ctx,
      ipOf(c),
      c.req.header('user-agent'),
      c.req.valid('json').code,
    );
    setScannerCookie(c, paired.token);
    return c.json(await pairedSession(ctx, paired.scannerId, paired.csrfSecret), 200, {
      'cache-control': 'no-store',
    });
  },
);
register(
  scanPairRoutes,
  'scan',
  { method: 'post', path: '/unpair', summary: 'Forget this scanner on this browser', status: 204 },
  async (c) => {
    await unpair(serviceContext(c), getCookie(c, SCANNER_COOKIE));
    deleteCookie(c, SCANNER_COOKIE, { path: '/', secure: true });
    return c.body(null, 204);
  },
);
