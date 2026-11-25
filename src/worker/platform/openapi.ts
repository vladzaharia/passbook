import type { RouteConfig } from '@hono/zod-openapi';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import type { ZodError, ZodType, z } from 'zod';
import { ProblemSchema } from '../../shared/contracts/common.ts';
import { scopeExercises } from './api-scopes.ts';
import { authorityUnproven, type RouteAuth, requireCaller } from './auth.ts';
import { defaultBodyLimit } from './body-limit.ts';
import type { AppBindings } from './context.ts';
import { checkDeprecation, deprecationMiddleware, type RouteDeprecation } from './deprecation.ts';
import { AppError } from './errors.ts';
import './openapi-names.ts';
import { checkFeatureRule, type FeatureRule, featureUnchecked } from './feature-guard.ts';
import { operationSecurity, scopesForMethod } from './openapi-security.ts';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec {
  method: Method;
  /** OpenAPI style path, e.g. `/{id}/void`. */
  path: string;
  summary: string;
  /** Stable id. Default: `<tag>.<verb><Path>` (openapi-document.ts); frozen in docs/api/operation-ids.json. SDK names come from docs/api/sdk-names.json. */
  operationId?: string;
  params?: ZodType;
  query?: ZodType;
  /** JSON request body. */
  body?: ZodType;
  /** The body may be left out (every field of `body` has a default); documented as not required. */
  bodyOptional?: true;
  /** JSON success body. Omit for redirects, HTML and binary responses. */
  response?: ZodType;
  status?: 200 | 201 | 202 | 204 | 302;
  /**
   * Who may call: a session or a key with a scope, humans only, or platform admins only. When set,
   * `register` installs the guard (`requireCaller`) and writes the document's `security`. A route
   * without it relies on a router-level guard (to be migrated).
   */
  auth?: RouteAuth;
  /**
   * The entitlement the organization must have, for a route that guards by its own authority (no `auth`):
   * documentation only, written as `x-feature`. The service and its grant enforce it; nothing here does.
   * With `auth`, declare `auth.feature` instead, which the request guard enforces.
   */
  xFeature?: FeatureRule;
  /**
   * The route is open to anyone on purpose (health, holder links, provider callbacks): it takes no
   * `auth`, and route-inventory.test.ts counts it as decided. Authority, if any, is the route's own.
   */
  public?: true;
  /**
   * Error codes the route can return that inference misses (docs/api/operation-codes.json is derived
   * from the handler's call graph by `npm run gen`). Read by that tool, not at runtime.
   */
  codes?: readonly string[];
  /**
   * The operation is deprecated: the document gets `deprecated` and `x-sunset`, and every response
   * (problem+json too) carries `Deprecation`, `Sunset` and `Link`. docs/api.md, "Deprecation".
   */
  deprecated?: RouteDeprecation;
  /** Names a validation failure of this route's request with its own error; undefined keeps the generic 422. */
  invalid?: (error: ZodError) => AppError | undefined;
}

const publicHandlers = new WeakSet<object>();
export const isPublicHandler = (handler: object): boolean => publicHandlers.has(handler);

/** A `capability` on a scope declaration must be one every scope the route's method accepts exercises. */
function checkDeclaration(spec: RouteSpec): void {
  if (spec.public && spec.auth)
    throw new Error(`${spec.method.toUpperCase()} ${spec.path}: public and auth are exclusive`);
  const auth = spec.auth;
  if (spec.xFeature !== undefined) {
    if (auth)
      throw new Error(
        `${spec.method.toUpperCase()} ${spec.path}: xFeature is for routes without auth`,
      );
    checkFeatureRule(`${spec.method.toUpperCase()} ${spec.path}`, spec.xFeature);
  }
  if (auth && 'platform' in auth) return;
  const where = `${spec.method.toUpperCase()} ${spec.path}`;
  if (auth?.feature !== undefined) {
    if ('human' in auth && !auth.requestMode)
      throw new Error(`${where}: a feature needs a tenant principal (requestMode)`);
    checkFeatureRule(where, auth.feature);
  }
  if (!auth || !('scope' in auth) || !auth.capability) return;
  for (const scope of scopesForMethod(auth.scope, spec.method)) {
    if (!scopeExercises(scope, auth.capability))
      throw new Error(
        `${spec.method.toUpperCase()} ${spec.path}: scope ${scope} does not exercise ${auth.capability}`,
      );
  }
}

/** The router's hook for a failed validation: the ZodError reaches the error handler (422). */
const throwInvalid = (
  result: { success: true; data: unknown } | { success: false; error: ZodError },
): void => {
  if (!result.success) throw result.error;
};

/**
 * Router whose validation failures surface as problem+json (422). Request bodies are capped at
 * DEFAULT_BODY_BYTES; a module with larger uploads passes `{ bodyLimit: false }` and applies
 * `defaultBodyLimit(pathOfTheUpload)` plus its own cap.
 */
export function createRouter(options: { bodyLimit?: boolean } = {}): OpenAPIHono<AppBindings> {
  const router = new OpenAPIHono<AppBindings>({ defaultHook: throwInvalid });
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
  checkDeclaration(spec);
  const retired = spec.deprecated;
  if (retired) checkDeprecation(`${spec.method.toUpperCase()} ${spec.path}`, retired);
  // First in the chain, so a 401, 403 or 422 raised by a later guard still carries the headers.
  const middleware = [
    ...(retired ? [deprecationMiddleware(retired)] : []),
    ...(spec.auth ? [requireCaller(spec.auth)] : []),
  ];
  const config = {
    ...(middleware.length ? { middleware } : {}),
    ...(spec.auth
      ? operationSecurity(spec.auth, spec.method)
      : spec.xFeature === undefined
        ? {}
        : { 'x-feature': spec.xFeature }),
    ...(retired
      ? { deprecated: true, 'x-deprecated': retired.since, 'x-sunset': retired.sunset }
      : {}),
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    ...(spec.operationId ? { operationId: spec.operationId } : {}),
    tags: [tag],
    'x-route': `${tag} ${spec.method} ${spec.path}`,
    request: {
      ...(spec.params ? { params: spec.params } : {}),
      ...(spec.query ? { query: spec.query } : {}),
      ...(spec.body
        ? {
            body: {
              required: !spec.bodyOptional,
              content: { 'application/json': { schema: spec.body } },
            },
          }
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
    const principal = c.var.auth;
    const response = await handler(c);
    // A declared capability must have been proven by the handler: fail closed, not just in tests.
    if (response.status < 400 && authorityUnproven(principal))
      throw new AppError('AUTHORITY_UNPROVEN', 500, 'Authority was not verified.');
    // Likewise a declared feature: a success that never checked the org's entitlements is a fault.
    if (response.status < 400 && featureUnchecked(principal))
      throw new AppError('FEATURE_UNCHECKED', 500, 'Features were not verified.');
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
  if (spec.public) publicHandlers.add(checked);
  const { invalid } = spec;
  router.openapi(
    createRoute(config),
    checked as never,
    invalid
      ? (result) => {
          if (!result.success) {
            const named = invalid(result.error);
            if (named) throw named;
          }
          throwInvalid(result);
        }
      : undefined,
  );
}

/** Applies a middleware to every route of a router. */
export function guard(
  router: OpenAPIHono<AppBindings>,
  ...middleware: MiddlewareHandler<AppBindings>[]
): void {
  for (const m of middleware) router.use('*', m);
}
