import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppBindings } from './context.ts';
import { withSecurity } from './openapi-security.ts';

type Op = { operationId?: string; tags?: string[]; 'x-operation-key'?: string };
type Doc = { paths?: Record<string, Record<string, Op | undefined>> } & Record<string, unknown>;

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

/** The full document (every operation, with ids and security). The route filters it per caller. */
export function buildOpenApiDocument(app: OpenAPIHono<AppBindings>): Doc {
  const doc = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'PassBook API', version: '1.0.0' },
    servers: [{ url: '/' }],
  }) as unknown as Doc;
  return withSecurity(app, withOperationIds(doc) as never) as unknown as Doc;
}
