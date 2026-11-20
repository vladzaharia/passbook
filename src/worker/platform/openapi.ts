import type { RouteConfig } from '@hono/zod-openapi';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import type { ZodType, z } from 'zod';
import { ProblemSchema } from '../../shared/contracts/common.ts';
import { scopeExercises } from './api-scopes.ts';
import { authorityUnproven, type RouteAuth, requireCaller } from './auth.ts';
import { defaultBodyLimit } from './body-limit.ts';
import type { AppBindings } from './context.ts';
import { AppError } from './errors.ts';
import './openapi-names.ts';
import { checkFeatureRule, featureUnchecked } from './feature-guard.ts';
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
   * The route is open to anyone on purpose (health, holder links, provider callbacks): it takes no
   * `auth`, and route-inventory.test.ts counts it as decided. Authority, if any, is the route's own.
   */
  public?: true;
}

const publicHandlers = new WeakSet<object>();
export const isPublicHandler = (handler: object): boolean => publicHandlers.has(handler);

/** A `capability` on a scope declaration must be one every scope the route's method accepts exercises. */
function checkDeclaration(spec: RouteSpec): void {
  if (spec.public && spec.auth)
    throw new Error(`${spec.method.toUpperCase()} ${spec.path}: public and auth are exclusive`);
  const auth = spec.auth;
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
  checkDeclaration(spec);
  const config = {
    ...(spec.auth
      ? { middleware: requireCaller(spec.auth), ...operationSecurity(spec.auth, spec.method) }
      : {}),
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    ...(spec.operationId ? { operationId: spec.operationId } : {}),
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
  router.openapi(createRoute(config), checked as never);
}

/** Applies a middleware to every route of a router. */
export function guard(
  router: OpenAPIHono<AppBindings>,
  ...middleware: MiddlewareHandler<AppBindings>[]
): void {
  for (const m of middleware) router.use('*', m);
}
