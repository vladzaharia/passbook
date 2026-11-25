import { createMiddleware } from 'hono/factory';
import type { AppBindings } from './context.ts';
import { baseUrl } from './env.ts';

/** A deprecated operation: listed from `since`, removed on `sunset` (both `YYYY-MM-DD`, UTC). */
export interface RouteDeprecation {
  since: string;
  sunset: string;
  /** Slug of the developer guide that replaces it: `/developers/guides/<guide>`. */
  guide: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ms = (date: string): number => Date.parse(`${date}T00:00:00Z`);

/** `x-sunset` and the description prefix use the same date text. */
export const sunsetLabel = (sunset: string): string =>
  new Date(ms(sunset)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function checkDeprecation(where: string, d: RouteDeprecation): void {
  if (![d.since, d.sunset].every((x) => DATE.test(x) && !Number.isNaN(ms(x))))
    throw new Error(`${where}: deprecated dates are YYYY-MM-DD`);
  if (ms(d.sunset) <= ms(d.since)) throw new Error(`${where}: sunset must follow since`);
  if (!/^[a-z0-9-]+$/.test(d.guide)) throw new Error(`${where}: deprecated guide is a slug`);
}

/** RFC 9745 `Deprecation` (structured date), RFC 8594 `Sunset`, and the `Link` to the guide. */
export function deprecationHeaders(d: RouteDeprecation, base: string): Record<string, string> {
  return {
    Deprecation: `@${ms(d.since) / 1000}`,
    Sunset: new Date(ms(d.sunset)).toUTCString(),
    Link: `<${base}/developers/guides/${d.guide}>; rel="deprecation"; type="text/html"`,
  };
}

/** Sets the headers after the handler, so success and problem+json answers both carry them. */
export const deprecationMiddleware = (d: RouteDeprecation) =>
  createMiddleware<AppBindings>(async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(deprecationHeaders(d, baseUrl(c.env))))
      c.header(name, value, { append: name === 'Link' });
  });
