import { type Context, Hono } from 'hono';
import { ArrowLeft } from 'lucide-react';
import {
  ACCESS_FORM_MAX_BYTES,
  ACCESS_FORM_POST_MAX_BYTES,
} from '../../../shared/contracts/access-request.ts';
import { ACCESS_COPY } from '../../../shared/copy/access.ts';
import { MARKETING_PATHS } from '../../../shared/marketing.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { sameOriginOnly } from '../../platform/csrf.ts';
import { AppError, BadRequestError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit, clientRatePrefix, secondsToReset } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { renderErrorPage } from '../../ssr/error-page.tsx';
import { requestTheme } from '../../ssr/head.ts';
import { submitAccessRequest } from './service.ts';

/**
 * The public site's own endpoints. Plain Hono routes, not API operations: the form is the site's
 * (a browser form post or its script's JSON post), so it stays out of the OpenAPI document.
 */
export const marketingRoutes = new Hono<AppBindings>();

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

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

/** A browser form post that failed for a reason a reload cannot fix: the page says so and links back. */
function failurePage(c: Context<AppBindings>, error: AppError): Response {
  const html = renderErrorPage({
    status: error.status,
    nonce: c.var.nonce,
    theme: requestTheme(c),
    line:
      error.status === 429
        ? ACCESS_COPY.tooMany
        : error.status === 413
          ? ACCESS_COPY.tooLarge
          : ACCESS_COPY.unavailable,
    action: { label: ACCESS_COPY.back, href: MARKETING_PATHS.access, icon: ArrowLeft },
  });
  return new Response(html, {
    status: error.status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      ...(error.headers ?? {}),
    },
  });
}

marketingRoutes.post('/', sameOriginOnly, async (c) => {
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  const json = type.startsWith(JSON_TYPE);
  try {
    let out: Response | undefined;
    // JSON from the page's script stays small; a plain form post is percent-encoded and may be longer.
    await limitBody(json ? ACCESS_FORM_MAX_BYTES : ACCESS_FORM_POST_MAX_BYTES)(c, async () => {
      out = await accept(c, type, json);
    });
    return out as Response;
  } catch (error) {
    // No script runs on a plain form post, so the refusal must explain itself.
    if (
      !json &&
      error instanceof AppError &&
      (error.status === 429 || error.status === 503 || error.status === 413)
    )
      return failurePage(c, error);
    throw error;
  }
});

async function accept(c: Context<AppBindings>, type: string, json: boolean): Promise<Response> {
  const ctx = serviceContext(c);
  const limited = () => {
    ctx.log.warn('marketing.access_limited', { code: 'ACCESS_RATE_LIMITED' });
    return new RateLimitedError(secondsToReset(ctx.clock.now()), ACCESS_COPY.tooMany);
  };
  if (!(await checkRateLimit(c.env, 'RL_ACCESS', `access:${clientRatePrefix(c)}`))) throw limited();
  if (!json && !type.startsWith(FORM))
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415, 'Send the form as a plain form post.');
  const text = await c.req.text();
  const fields = json ? parseJson(text) : Object.fromEntries(new URLSearchParams(text));
  await submitAccessRequest(ctx, fields, {
    // The site-wide cap is charged only by requests that will send mail.
    beforeSend: async () => {
      if (!(await checkRateLimit(c.env, 'RL_ACCESS_ALL', 'access:all'))) throw limited();
    },
  });
  const headers = { 'cache-control': 'no-store' };
  return json
    ? c.body(null, 204, headers)
    : new Response(null, {
        status: 303,
        headers: { ...headers, location: MARKETING_PATHS.accessSent },
      });
}
