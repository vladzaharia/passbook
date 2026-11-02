import type { RouteConfig } from '@hono/zod-openapi';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { ZodType } from 'zod';
import { ProblemSchema } from '../../shared/contracts/common.ts';
import { defaultBodyLimit } from './body-limit.ts';
import type { AppBindings } from './context.ts';
import { NotImplementedError } from './errors.ts';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec {
  method: Method;
  /** OpenAPI style path, e.g. `/{id}/void`. */
  path: string;
  summary: string;
  params?: ZodType;
  query?: ZodType;
  /** JSON request body. */
  body?: ZodType;
  /** JSON success body. Omit for redirects, HTML and binary responses. */
  response?: ZodType;
  status?: 200 | 201 | 202 | 204 | 302;
}

/**
 * Router whose validation failures surface as problem+json (422). Request bodies are capped at
 * DEFAULT_BODY_BYTES; a module with larger uploads passes `{ bodyLimit: false }` and applies
 * `defaultBodyLimit(pathOfTheUpload)` plus its own cap.
 */
export function createRouter(options: { bodyLimit?: boolean } = {}): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({
    defaultHook: (result) => {
      if (!result.success) throw result.error;
    },
  });
  if (options.bodyLimit !== false) router.use('*', defaultBodyLimit());
  return router;
}

export function register(
  router: OpenAPIHono<AppBindings>,
  tag: string,
  spec: RouteSpec,
  handler: (c: never) => unknown,
): void {
  const status = spec.status ?? 200;
  const config = {
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    tags: [tag],
    request: {
      ...(spec.params ? { params: spec.params } : {}),
      ...(spec.query ? { query: spec.query } : {}),
      ...(spec.body
        ? { body: { required: true, content: { 'application/json': { schema: spec.body } } } }
        : {}),
    },
    responses: {
      [status]: {
        description: 'Success',
        ...(spec.response ? { content: { 'application/json': { schema: spec.response } } } : {}),
      },
      default: {
        description: 'Error',
        content: { 'application/problem+json': { schema: ProblemSchema } },
      },
    },
  } as unknown as RouteConfig;
  router.openapi(createRoute(config), handler as never);
}

/** Applies a middleware to every route of a router. */
export function guard(
  router: OpenAPIHono<AppBindings>,
  ...middleware: MiddlewareHandler<AppBindings>[]
): void {
  for (const m of middleware) router.use('*', m);
}
