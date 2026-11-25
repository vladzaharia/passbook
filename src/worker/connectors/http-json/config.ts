import { z } from 'zod';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../lib/hmac.ts';
import { HEADER_NAME, isAllowedHeaderName } from '../lib/http.ts';
import { isPointer } from '../lib/pointer.ts';

export const MAX_PAGES_CAP = 1000;
export const DEFAULT_MAX_PAGES = 200;

const pointer = z.string().max(200).refine(isPointer, 'Not a JSON pointer.');
const path = z
  .string()
  .max(300)
  .refine((v) => v.startsWith('/') && !/[?#]/.test(v) && !v.includes('..'), 'Invalid path.');
const paramName = z.string().regex(/^[A-Za-z0-9_.$[\]-]{1,60}$/, 'Invalid parameter name.');
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f]/;
const plainValue = z
  .string()
  .max(200)
  .refine((v) => !CONTROL.test(v), 'Invalid value.');

/** A static header must not carry a credential: those go through the auth helper and are encrypted. */
const SECRET_LOOKING = /^(authorization|cookie|proxy-.*)$|key|token|secret|signature/i;
const staticHeader = z.object({
  name: z
    .string()
    .refine((n) => HEADER_NAME.test(n) && isAllowedHeaderName(n), 'Header not allowed.')
    .refine((n) => !SECRET_LOOKING.test(n), 'Use Authentication for credentials.'),
  value: plainValue,
});

const pagination = z.discriminatedUnion('style', [
  z.object({ style: z.literal('none') }),
  z.object({
    style: z.literal('cursor'),
    param: paramName.default('cursor'),
    cursorPointer: pointer.default('/cursor'),
    hasMorePointer: pointer.optional(),
    from: z.enum(['body', 'last-id']).default('body'),
  }),
  z.object({ style: z.literal('next-link'), nextPointer: pointer }),
  z.object({ style: z.literal('link-header') }),
  z.object({
    style: z.literal('page'),
    param: paramName.default('page'),
    start: z.union([z.literal(0), z.literal(1)]).default(1),
    sizeParam: paramName.optional(),
    size: z.number().int().min(1).max(1000).optional(),
    totalPagesPointer: pointer.optional(),
    totalPagesHeader: z.string().refine(isAllowedHeaderName).optional(),
  }),
  z.object({
    style: z.literal('offset'),
    param: paramName.default('offset'),
    sizeParam: paramName.default('limit'),
    size: z.number().int().min(1).max(1000).default(100),
    totalPointer: pointer.optional(),
  }),
]);

const incremental = z.object({
  param: paramName,
  field: pointer,
  format: z.enum(['iso', 'unix', 'unix-ms']).default('iso'),
  overlapSeconds: z.number().int().min(0).max(86_400).default(300),
});

const list = z
  .object({
    path: path.meta({
      'x-label': 'List path',
      'x-widget': 'text',
      'x-help': 'Returns the records page by page.',
      'x-placeholder': '/members',
    }),
    query: z
      .array(z.object({ name: paramName, value: plainValue }))
      .max(10)
      .default([]),
    listing: z.enum(['full', 'feed']).default('full'),
    recordsPointer: pointer.default('/items').meta({ 'x-label': 'Records' }),
    idPointer: pointer.default('/id').meta({ 'x-label': 'Record ID' }),
    recordPointer: pointer.default('').meta({ 'x-label': 'Record location' }),
    deletedPointer: pointer.optional().meta({ 'x-label': 'Deleted flag' }),
    pagination: pagination.default({ style: 'none' }),
    incremental: incremental.optional(),
    maxPages: z.number().int().min(1).max(MAX_PAGES_CAP).default(DEFAULT_MAX_PAGES),
  })
  .refine((l) => !l.incremental || l.listing === 'full', {
    message: 'Incremental needs a full listing.',
    path: ['incremental'],
  })
  .meta({ 'x-label': 'List endpoint' });

const object = z.object({
  baseUrl: z
    .url()
    .max(500)
    .refine((v) => {
      if (!URL.canParse(v)) return true;
      const u = new URL(v);
      return !u.search && !u.hash && !u.username && !u.password;
    }, 'No query, fragment or credentials.')
    .meta({
      'x-label': 'Base URL',
      'x-help': 'HTTPS. No query string.',
      'x-placeholder': 'https://api.example.com/v1',
      'x-order': 1,
    }),
  recordPath: path
    .refine((v) => v.split('{ref}').length === 2, 'Must contain {ref} once.')
    .optional()
    .meta({
      'x-label': 'Record path',
      'x-widget': 'text',
      'x-help': 'Added to the base URL. {ref} is the record ID.',
      'x-placeholder': '/members/{ref}',
      'x-order': 2,
    }),
  recordPointer: pointer.default('').meta({
    'x-label': 'Record location',
    'x-help': 'JSON pointer to the record in the response. Empty means the whole body.',
    'x-placeholder': '/data',
    'x-order': 3,
  }),
  holderEmailPointer: pointer.optional().meta({
    'x-label': 'Holder email',
    'x-help': 'JSON pointer to the email in the response.',
    'x-placeholder': '/email',
    'x-order': 4,
  }),
  testRef: z.string().max(200).optional().meta({
    'x-label': 'Test record ID',
    'x-help': 'Fetched by Test.',
    'x-placeholder': 'm-001',
    'x-order': 5,
  }),
  auth: z
    .object({
      type: z
        .enum(['none', 'bearer', 'basic', 'header', 'query'])
        .default('none')
        .meta({
          'x-label': 'Authentication',
          'x-enumLabels': {
            none: 'None',
            bearer: 'Bearer token',
            basic: 'Basic',
            header: 'Header',
            query: 'Query parameter',
          },
        }),
      headerName: z
        .string()
        .refine(isAllowedHeaderName, 'Header not allowed.')
        .optional()
        .meta({ 'x-label': 'Header name', 'x-placeholder': 'X-Api-Key', 'x-auth': ['header'] }),
      queryParam: paramName
        .optional()
        .meta({ 'x-label': 'Parameter name', 'x-placeholder': 'api_key', 'x-auth': ['query'] }),
    })
    .default({ type: 'none' })
    .meta({ 'x-label': 'Authentication' }),
  headers: z.array(staticHeader).max(5).default([]).meta({ 'x-label': 'Headers' }),
  list: list.optional(),
  webhook: z
    .object({
      eventIdPointer: pointer.default('/id').meta({ 'x-label': 'Event ID' }),
      refsPointer: pointer.default('/refs').meta({ 'x-label': 'Record IDs' }),
      signatureHeader: z
        .string()
        .refine(isAllowedHeaderName)
        .default(SIGNATURE_HEADER)
        .meta({ 'x-label': 'Signature header' }),
      timestampHeader: z
        .string()
        .refine(isAllowedHeaderName)
        .default(TIMESTAMP_HEADER)
        .meta({ 'x-label': 'Timestamp header' }),
    })
    .default({
      eventIdPointer: '/id',
      refsPointer: '/refs',
      signatureHeader: SIGNATURE_HEADER,
      timestampHeader: TIMESTAMP_HEADER,
    })
    .meta({ 'x-label': 'Webhook' }),
});

/** Without a list there is nothing else to run, so the per-record path defaults as it did in v1. */
export const config = object.transform((c) =>
  c.list || c.recordPath ? c : { ...c, recordPath: '/{ref}' },
);

/** `x-auth` names the auth types a secret belongs to, so the form shows only those. */
export const secrets = z.object({
  token: z
    .string()
    .max(4096)
    .optional()
    .meta({ 'x-label': 'Token', 'x-auth': ['bearer'] }),
  username: z
    .string()
    .max(256)
    .optional()
    .meta({ 'x-label': 'Username', 'x-auth': ['basic'] }),
  password: z
    .string()
    .max(1024)
    .optional()
    .meta({ 'x-label': 'Password', 'x-auth': ['basic'] }),
  headerValue: z
    .string()
    .max(4096)
    .optional()
    .meta({ 'x-label': 'Header value', 'x-auth': ['header'] }),
  queryValue: z
    .string()
    .max(4096)
    .optional()
    .meta({ 'x-label': 'Parameter value', 'x-auth': ['query'] }),
});

export type Config = z.infer<typeof config>;
export type Secrets = z.infer<typeof secrets>;
export type ListConfig = NonNullable<Config['list']>;
