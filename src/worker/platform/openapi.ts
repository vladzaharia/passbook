import type { RouteConfig } from '@hono/zod-openapi';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import type { ZodType, z } from 'zod';
import { ProblemSchema } from '../../shared/contracts/common.ts';
import { defaultBodyLimit } from './body-limit.ts';
import type { AppBindings } from './context.ts';

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

type Part<S, K extends string, Target extends string> = S extends {
  [P in K]: infer T extends ZodType;
}
  ? { [P in Target]: z.output<T> }
  : Record<never, never>;

/** What `c.req.valid()` returns for a spec: only the parts the spec declares. */
export type ValidInput<S extends RouteSpec> = Part<S, 'params', 'param'> &
  Part<S, 'query', 'query'> &
  Part<S, 'body', 'json'>;

/** A handler's context: `c.req.valid('json' | 'query' | 'param')` is typed from the spec. */
export type RouteContext<S extends RouteSpec> = Context<
  AppBindings,
  string,
  { in: Record<string, never>; out: ValidInput<S> }
>;

let checkResponses = false;

/** Test hook: a JSON response that violates its spec's `response` schema throws instead of shipping. */
export function enableResponseChecks(): void {
  checkResponses = true;
}

export function register<S extends RouteSpec>(
  router: OpenAPIHono<AppBindings>,
  tag: string,
  spec: S,
  handler: (c: RouteContext<S>) => Response | Promise<Response>,
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
  const checked = async (c: RouteContext<S>) => {
    const response = await handler(c);
    const schema = spec.response;
    if (checkResponses && schema && response.status === status) {
      const parsed = schema.safeParse(await response.clone().json());
      if (!parsed.success)
        throw new Error(
          `${spec.method.toUpperCase()} ${spec.path} response breaks its contract: ${parsed.error.message}`,
        );
    }
    return response;
  };
  router.openapi(createRoute(config), checked as never);
}

/** Applies a middleware to every route of a router. */
export function guard(
  router: OpenAPIHono<AppBindings>,
  ...middleware: MiddlewareHandler<AppBindings>[]
): void {
  for (const m of middleware) router.use('*', m);
}
