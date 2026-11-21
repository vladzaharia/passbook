type Json = Record<string, unknown>;
type Media = { example?: unknown; examples?: unknown; schema?: unknown };
type Op = {
  operationId?: string;
  description?: string;
  'x-sdk'?: unknown;
  requestBody?: { content?: Record<string, Media> };
  responses?: Record<string, { content?: Record<string, Media> }>;
};
type Doc = {
  paths?: Record<string, Record<string, Op | undefined>>;
  components?: { schemas?: Record<string, unknown> } & Json;
} & Json;

/** What docs/api/reference/<tag>.json holds per operationId. */
export interface OpReference {
  description?: string;
  request?: unknown;
  /** Named request examples, shown beside `request`: one per way to call it. */
  requests?: Record<string, unknown>;
  response?: unknown;
}

const files = import.meta.glob<Record<string, OpReference>>('../../../docs/api/reference/*.json', {
  eager: true,
  import: 'default',
});

/** Every reference entry by operationId; the tests check the keys against the document. */
export const REFERENCE: Record<string, OpReference> = {};
for (const file of Object.values(files))
  for (const [id, entry] of Object.entries(file)) REFERENCE[id] = { ...REFERENCE[id], ...entry };

const JSON_TYPE = 'application/json';
const pascal = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const operations = (doc: Doc): Op[] =>
  Object.values(doc.paths ?? {}).flatMap((item) =>
    Object.values(item).filter((op): op is Op => !!op && typeof op === 'object'),
  );

/** Sets descriptions and request and response examples from docs/api/reference. */
export function withReference(doc: Doc): Doc {
  for (const op of operations(doc)) {
    const ref = op.operationId ? REFERENCE[op.operationId] : undefined;
    if (!ref) continue;
    if (ref.description) op.description = ref.description;
    const request = op.requestBody?.content?.[JSON_TYPE];
    if (request && ref.request !== undefined) request.example = ref.request;
    if (request && ref.requests)
      request.examples = Object.fromEntries(
        Object.entries(ref.requests).map(([summary, value]) => [summary, { summary, value }]),
      );
    const ok = Object.entries(op.responses ?? {}).find(([code]) => code.startsWith('2'));
    const response = ok?.[1].content?.[JSON_TYPE];
    if (response && ref.response !== undefined) response.example = ref.response;
  }
  return doc;
}

/** `passes.create` -> `PassesCreateParams`: each SDK body is a named component, so SDKs get a type for it. */
export function withNamedBodies(doc: Doc): Doc {
  const components = doc.components ?? {};
  const schemas = components.schemas ?? {};
  doc.components = { ...components, schemas };
  for (const op of operations(doc)) {
    const sdk = op['x-sdk'] as { resource: string; method: string; sdk?: boolean } | undefined;
    const media = op.requestBody?.content?.[JSON_TYPE];
    if (!sdk || sdk.sdk === false || !media?.schema) continue;
    if (typeof media.schema === 'object' && '$ref' in media.schema) continue;
    const name = `${[...sdk.resource.split('.'), sdk.method].map(pascal).join('')}Params`;
    if (name in schemas) throw new Error(`request body name ${name} is taken (${op.operationId})`);
    schemas[name] = media.schema;
    media.schema = { $ref: `#/components/schemas/${name}` };
  }
  return doc;
}
