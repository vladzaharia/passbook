import type { OpenAPIHono } from '@hono/zod-openapi';
import { isKnownGuard } from './auth.ts';
import type { AppBindings } from './context.ts';
import { isPublicHandler } from './openapi.ts';
import { enforcesKeyAccess } from './openapi-security.ts';

type Op = { security?: unknown; parameters?: unknown[]; responses?: unknown };
type Doc = {
  paths?: Record<string, Record<string, Op | undefined>>;
  components?: Record<string, unknown>;
} & Record<string, unknown>;

/** Open to anyone: the handler answers who you are, or the link or token in the request is the credential. */
const OPEN = new Set([
  'get /api/v1/session',
  'get /api/v1/org-exports/{exportId}/download',
  'get /api/v1/orgs/invitations/accept',
  'post /api/v1/orgs/invitations/preview',
]);

/** Apple's web service checks the pass's own `ApplePass` token. */
const PASS_TOKEN = new Set([
  'post /wallet/v1/devices/{deviceId}/registrations/{passTypeId}/{serial}',
  'delete /wallet/v1/devices/{deviceId}/registrations/{passTypeId}/{serial}',
  'get /wallet/v1/passes/{passTypeId}/{serial}',
]);

/** Operations that read `Idempotency-Key`; a retry with the same key returns the first result. */
const IDEMPOTENT = [
  'post /api/v1/passes',
  'post /api/v1/passes/{id}/resend-email',
  'post /api/v1/passes/bulk',
  'post /api/v1/broadcasts',
  'post /api/v1/bundles/{id}/send-email',
  'post /api/v1/orgs/{orgId}/identities/apple',
  'patch /api/v1/orgs/{orgId}/pass-setup',
  'post /api/v1/scanning-sessions/setup',
  'post /api/v1/templates/{id}/release',
  'post /api/v1/pass-imports',
  'post /api/v1/pass-imports/{id}/commit',
  'post /api/v1/templates/{id}/review-requests',
  'post /api/v1/operations/{id}/retry',
];

const toRegex = (path: string) =>
  new RegExp(
    `^${path
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/\*$/, '(?:/.*)?')
      .replace(/\*/g, '.*')
      .replace(/:[A-Za-z0-9_]+/g, '[^/]+')}/?$`,
  );

type Decision = 'public' | 'session' | 'scanner';

/** What guards a route no `auth` declaration or key access covers: its own handler, or a guard mounted over it. */
function decide(app: OpenAPIHono<AppBindings>, method: string, docPath: string): Decision {
  const exact = docPath.replace(/\{([^}]+)\}/g, ':$1');
  const sample = docPath.replace(/\{([^}]+)\}/g, 'x');
  const routes = app.routes;
  const own = routes
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.method.toLowerCase() === method && r.path === exact);
  const last =
    own.at(-1) ??
    routes
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.method.toLowerCase() === method && toRegex(r.path).test(sample))
      .at(-1);
  // No route behind a documented operation: fail closed, never read as open.
  if (!last) return 'session';
  if (isPublicHandler(last.r.handler)) return 'public';
  const covered = routes.some(
    (r, i) =>
      i < last.i &&
      (r.method === 'ALL' || r.method.toLowerCase() === method) &&
      toRegex(r.path).test(sample) &&
      (isKnownGuard(r.handler) || enforcesKeyAccess(r.handler)),
  );
  if (covered) return 'session';
  if (docPath.startsWith('/api/v1/scan/')) return 'scanner';
  return docPath.startsWith('/api/v1/') ? 'session' : 'public';
}

/**
 * Gives every operation a `security` that says who may call it: a route no key reaches reads as
 * session-only, a scanner route as a device, an open route as `[]` with `x-public`. A missing
 * `security` would read as open to anyone.
 */
export function withDecisions(app: OpenAPIHono<AppBindings>, doc: Doc): Doc {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object' || !op.responses || op.security !== undefined) continue;
      const name = `${method} ${path}`;
      if (PASS_TOKEN.has(name)) {
        op.security = [{ passToken: [] }];
        continue;
      }
      const decision = OPEN.has(name) ? 'public' : decide(app, method, path);
      if (decision === 'public') Object.assign(op, { security: [], 'x-public': true });
      else op.security = decision === 'scanner' ? [{ scanner: [] }] : [{ session: [] }];
    }
  }
  const schemes = (doc.components?.securitySchemes ?? {}) as Record<string, unknown>;
  doc.components = {
    ...doc.components,
    securitySchemes: {
      ...schemes,
      passToken: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'The pass authentication token, sent as `ApplePass <token>`.',
      },
      scanner: {
        type: 'http',
        scheme: 'bearer',
        description: 'A paired scanner device token. The pairing routes take a pairing code.',
      },
    },
  };
  return doc;
}

/** Declares `Idempotency-Key` on the operations that read it. */
export function withIdempotencyKey(doc: Doc): Doc {
  doc.components = {
    ...doc.components,
    parameters: {
      ...(doc.components?.parameters as Record<string, unknown> | undefined),
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description:
          '1 to 200 characters. A retry with the same key and body returns the first result.',
        schema: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
  };
  for (const name of IDEMPOTENT) {
    const [method = '', path = ''] = name.split(' ');
    const op = doc.paths?.[path]?.[method];
    if (op)
      op.parameters = [
        ...(op.parameters ?? []),
        name === 'post /api/v1/passes'
          ? {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              description:
                '1 to 200 characters. A retry with the same key and body returns the first result. Keys starting broadcast-create:, bulk-send: or rollout-tell: are reserved (422 IDEMPOTENCY_KEY_RESERVED).',
              schema: { type: 'string', minLength: 1, maxLength: 200 },
            }
          : { $ref: '#/components/parameters/IdempotencyKey' },
      ];
  }
  return doc;
}
