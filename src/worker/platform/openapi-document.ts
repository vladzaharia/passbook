import type { OpenAPIHono } from '@hono/zod-openapi';
import { API_VERSIONS } from './api-version.ts';
import type { AppBindings } from './context.ts';
import { sunsetLabel } from './deprecation.ts';
import { withErrorCodes } from './openapi-codes.ts';
import { withDecisions, withIdempotencyKey } from './openapi-decisions.ts';
import { withNamedBodies, withReference } from './openapi-reference.ts';
import { withSdkNames } from './openapi-sdk.ts';
import { withSecurity, withSignIn, withStepUp } from './openapi-security.ts';
import { registerWebhookEvents } from './openapi-webhooks.ts';

type Param = { name: string; in: string; deprecated?: boolean; 'x-platform-only'?: boolean };
type Op = {
  operationId?: string;
  tags?: string[];
  description?: string;
  deprecated?: boolean;
  'x-sunset'?: string;
  'x-deprecated'?: string;
  'x-operation-key'?: string;
  parameters?: Param[];
  requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, object> } }> };
};
type Doc = { paths?: Record<string, Record<string, Op | undefined>> } & Record<string, unknown>;

/** wrangler.jsonc PUBLIC_BASE_URL; operation paths carry the /api/v1 prefix. */
const PUBLIC_BASE_URL = 'https://passbook.mobile';
const API_PREFIX = /^\/api\/v1/;
const pascal = (s: string): string =>
  s.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, _sep, ch: string) => ch.toUpperCase());

/** `<tag>.<verb><Path>`: `GET /api/v1/passes/{id}/void` under tag `passes` is `passes.getPassesByIdVoid`. */
export function deriveOperationId(tag: string, method: string, path: string): string {
  const parts = path
    .replace(API_PREFIX, '')
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith('{') ? `By${pascal(seg.slice(1, -1))}` : pascal(seg)));
  return `${tag.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${method}${parts.join('')}`;
}

/** Lowercases each tag and turns runs of non-alphanumerics into `-`. Ids derive from the same form. */
export function withKebabTags(doc: Doc): Doc {
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (op?.tags) op.tags = op.tags.map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    }
  }
  return doc;
}

/** Gives every operation without an explicit `operationId` its derived one. */
export function withOperationIds(doc: Doc): Doc {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object' || op.operationId) continue;
      op.operationId = deriveOperationId(op.tags?.[0] ?? 'api', method, path);
    }
  }
  return doc;
}

/** Old spelling of a query parameter, and the alias that replaces it when an operation takes both. */
const DEPRECATED_BY: Record<string, string> = {
  from: 'createdAfter',
  to: 'createdBefore',
  since: 'updatedSince',
  after: 'cursor',
};

/**
 * Marks the old time and cursor names deprecated where their replacement exists, and `orgId` (a query
 * parameter, or the `POST /passes` body field) `x-platform-only`: org-bound keys never send it.
 */
export function withParamMarks(doc: Doc): Doc {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (!op || typeof op !== 'object') continue;
      const names = new Set(op.parameters?.map((p) => p.name));
      for (const p of op.parameters ?? []) {
        if (p.in !== 'query') continue;
        const alias = DEPRECATED_BY[p.name];
        if (alias && names.has(alias)) p.deprecated = true;
        if (p.name === 'orgId') p['x-platform-only'] = true;
      }
      const orgId = op.requestBody?.content?.['application/json']?.schema?.properties?.orgId;
      if (orgId && path === '/api/v1/passes') Object.assign(orgId, { 'x-platform-only': true });
    }
  }
  return doc;
}

/** Starts the description of a deprecated operation with "Deprecated: ends <date>." (after the reference text is merged). */
export function withDeprecationNotes(doc: Doc): Doc {
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item)) {
      if (!op?.deprecated || !op['x-sunset']) continue;
      const note = `Deprecated: ends ${sunsetLabel(op['x-sunset'])}.`;
      op.description = op.description ? `${note} ${op.description}` : note;
    }
  }
  return doc;
}

/** The full document (every operation, with ids and security). The route filters it per caller. */
export function buildOpenApiDocument(app: OpenAPIHono<AppBindings>): Doc {
  registerWebhookEvents(app);
  const doc = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'PassBook API', version: API_VERSIONS.at(-1) ?? '1.0.0' },
    servers: [{ url: PUBLIC_BASE_URL }],
  }) as unknown as Doc;
  const secured = withSecurity(
    app,
    withNamedBodies(
      withDeprecationNotes(
        withReference(withSdkNames(withParamMarks(withOperationIds(withKebabTags(doc))))) as never,
      ) as never,
    ) as never,
  );
  return withErrorCodes(
    withStepUp(
      app,
      withSignIn(
        app,
        withIdempotencyKey(withDecisions(app, secured as never) as never) as never,
      ) as never,
    ) as never,
  ) as unknown as Doc;
}
