import { Hono } from 'hono';
import { ACCESS_FORM_MAX_BYTES } from '../../../shared/contracts/access-request.ts';
import { ACCESS_COPY } from '../../../shared/copy/access.ts';
import { MARKETING_PATHS } from '../../../shared/marketing.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { sameOriginOnly } from '../../platform/csrf.ts';
import { AppError, BadRequestError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit, clientRatePrefix, secondsToReset } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { submitAccessRequest } from './service.ts';

/**
 * The public site's own endpoints. Plain Hono routes, not API operations: the form is the site's
 * (a browser form post or its script's JSON post), so it stays out of the OpenAPI document.
 */
export const marketingRoutes = new Hono<AppBindings>();

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

/** The select is named `for` in the markup; the contract says `purpose`. */
function withPurpose(fields: Record<string, unknown>): Record<string, unknown> {
  const { for: chosen, ...rest } = fields;
  return rest.purpose === undefined ? { ...rest, purpose: chosen } : rest;
}

function parseJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON: the caller gets a 400 below.
    value = null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new BadRequestError('Send the form as JSON or a form post.');
  return value as Record<string, unknown>;
}

marketingRoutes.post('/', sameOriginOnly, limitBody(ACCESS_FORM_MAX_BYTES), async (c) => {
  const ctx = serviceContext(c);
  const prefix = clientRatePrefix(c);
  if (
    !(await checkRateLimit(c.env, 'RL_ACCESS', `access:${prefix}`)) ||
    !(await checkRateLimit(c.env, 'RL_ACCESS_ALL', 'access:all'))
  ) {
    ctx.log.warn('marketing.access_limited', { code: 'ACCESS_RATE_LIMITED' });
    throw new RateLimitedError(secondsToReset(ctx.clock.now()), ACCESS_COPY.tooMany);
  }
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  const json = type.startsWith(JSON_TYPE);
  if (!json && !type.startsWith(FORM))
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415, 'Send the form as a plain form post.');
  const text = await c.req.text();
  const fields = json ? parseJson(text) : Object.fromEntries(new URLSearchParams(text));
  await submitAccessRequest(ctx, withPurpose(fields));
  const headers = { 'cache-control': 'no-store' };
  return json
    ? c.body(null, 204, headers)
    : new Response(null, {
        status: 303,
        headers: { ...headers, location: MARKETING_PATHS.accessSent },
      });
});
