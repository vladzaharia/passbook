import { z } from 'zod';
import { IdSchema, JsonSchema } from './common.ts';
import { JsonPointerSchema, SourceFieldTypeSchema } from './connection-files.ts';

const ParamSchema = z.string().regex(/^[A-Za-z0-9_.$[\]-]{1,60}$/, 'Not a query parameter name.');
const SizeSchema = z.number().int().min(1).max(1000);
const CountSchema = z.number().int().nonnegative();
/** 0 to 1; higher is likelier. */
const ScoreSchema = z.number().min(0).max(1);
const SampleSchema = z.string().max(80);
/** `$.data[*].email`: what the explorer shows and the user clicks; the pointer is what the config stores. */
const JsonPathSchema = z.string().max(600);

/** How the REST connector walks a list (`list.pagination` of http-json v2). */
export const RestPaginationSchema = z.discriminatedUnion('style', [
  z.object({ style: z.literal('none') }),
  z.object({
    style: z.literal('cursor'),
    param: ParamSchema,
    cursorPointer: JsonPointerSchema,
    hasMorePointer: JsonPointerSchema.optional(),
    /** `last-id`: the page's last record ID is the next cursor (Stripe `starting_after`). */
    from: z.enum(['body', 'last-id']).default('body'),
  }),
  z.object({ style: z.literal('next-link'), nextPointer: JsonPointerSchema }),
  z.object({ style: z.literal('link-header') }),
  z.object({
    style: z.literal('page'),
    param: ParamSchema,
    start: z.union([z.literal(0), z.literal(1)]),
    sizeParam: ParamSchema.optional(),
    size: SizeSchema.optional(),
    totalPagesPointer: JsonPointerSchema.optional(),
    /** A response header with the page count (WooCommerce `X-WP-TotalPages`). */
    totalPagesHeader: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, 'Not a header name.')
      .optional(),
  }),
  z.object({
    style: z.literal('offset'),
    param: ParamSchema,
    sizeParam: ParamSchema,
    size: SizeSchema,
    totalPointer: JsonPointerSchema.optional(),
  }),
]);
export type RestPagination = z.infer<typeof RestPaginationSchema>;
/** How an updated-at value is written. */
export const RestTimeFormatSchema = z.enum(['iso', 'unix', 'unix-ms']);

/** One sentence of copy each (connectors design §5.5). */
export const ProbeErrorCodeSchema = z.enum([
  'AUTH',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'TIMEOUT',
  'UPSTREAM',
  'UNSAFE_URL',
  'REDIRECT_BLOCKED',
  'NOT_JSON',
  'TOO_LARGE',
  'NO_RECORDS',
  'OFF_ORIGIN',
  'CONFIG',
]);

const TargetFields = {
  target: z.enum(['list', 'record']),
  /** target `record`: the record to fetch. Default: config `testRef`. */
  ref: z.string().min(1).max(200).optional(),
  /** The previous result's `page.next`: fetches the page after it. */
  next: z.string().min(1).max(4096).optional(),
};
const ConfigSchema = z.record(z.string(), JsonSchema);
const SecretsSchema = z.record(z.string(), z.string().max(4096));

/** Probes an unsaved configuration. Nothing is stored; secrets are used once and dropped. */
export const ProbeConfigSchema = z.object({
  orgId: IdSchema,
  connectorType: z.literal('http-json'),
  config: ConfigSchema,
  secrets: SecretsSchema.optional(),
  ...TargetFields,
});
/**
 * Probes a saved connection: its stored config and secrets unless these are given. A config override
 * that changes the origin needs fresh secrets (`assertCredentialOrigin`), so stored ones never travel to
 * a new host. The unsaved probe calls `requireConnectorEntitled`. `next` is re-checked through the
 * pinned fetch, so a forged token cannot leave the connector's egress origins.
 */
export const ProbeConnectionSchema = z.object({
  config: ConfigSchema.optional(),
  secrets: SecretsSchema.optional(),
  ...TargetFields,
});

/** Record pointers are absolute; the others sit inside a record of the first records candidate. */
export const ProbeDetectionsSchema = z.object({
  records: z
    .array(
      z.object({
        pointer: JsonPointerSchema,
        jsonPath: JsonPathSchema,
        count: CountSchema,
        score: ScoreSchema,
        reason: z.enum(['root', 'name', 'shape']),
      }),
    )
    .max(5),
  pagination: z
    .array(
      z.object({
        confidence: z.enum(['high', 'medium', 'low']),
        config: RestPaginationSchema,
        /** What gave it away, as a code: `header:link`, `field:/meta/next_cursor`, `query:page`. */
        evidence: z.string().max(200),
      }),
    )
    .max(3),
  id: z
    .array(
      z.object({
        pointer: JsonPointerSchema,
        jsonPath: JsonPathSchema,
        unique: z.boolean(),
        score: ScoreSchema,
      }),
    )
    .max(5),
  updatedAt: z
    .array(
      z.object({
        pointer: JsonPointerSchema,
        jsonPath: JsonPathSchema,
        format: RestTimeFormatSchema,
        score: ScoreSchema,
      }),
    )
    .max(5),
  holderEmail: z.array(z.object({ pointer: JsonPointerSchema, jsonPath: JsonPathSchema })).max(3),
  fields: z
    .array(
      z.object({
        pointer: JsonPointerSchema,
        jsonPath: JsonPathSchema,
        label: z.string().max(200),
        type: SourceFieldTypeSchema,
        samples: z.array(SampleSchema).max(3),
        /** Distinct values, most common first; absent for a free-form field. */
        values: z
          .array(z.object({ value: SampleSchema, count: CountSchema }))
          .max(20)
          .optional(),
      }),
    )
    .max(100),
  rateLimit: z
    .object({
      limit: CountSchema.optional(),
      windowSeconds: CountSchema.optional(),
      remaining: CountSchema.optional(),
    })
    .nullable(),
});

/**
 * The live answer for the explorer, built by the same request and pagination code as a sync. Only a 2xx JSON
 * body is returned, pruned, with every secret value masked; an error returns its status and code only.
 */
export const ProbeResultSchema = z.object({
  ok: z.boolean(),
  errorCode: ProbeErrorCodeSchema.optional(),
  /** RATE_LIMITED: how long to wait. */
  retryAfterMs: CountSchema.optional(),
  durationMs: CountSchema,
  /** Null when no request went out. The URL is masked. */
  request: z
    .object({
      method: z.literal('GET'),
      url: z.string().max(4096),
      status: z.number().int(),
      bytes: CountSchema,
      contentType: z.string().max(200).nullable(),
    })
    .nullable(),
  /** Allow-listed response headers, masked; never `set-cookie`. */
  headers: z.record(z.string(), z.string().max(2000)),
  /** The 2xx JSON answer: arrays cut to 25 items, strings to 500 characters, 12 levels, 20,000 nodes. */
  body: JsonSchema.optional(),
  /** What pruning cut from `body`; null without one. */
  pruned: z
    .object({
      arrays: z
        .array(z.object({ pointer: JsonPointerSchema, total: CountSchema, shown: CountSchema }))
        .max(500),
      strings: CountSchema,
      depthCut: z.boolean(),
      nodesCut: z.boolean(),
    })
    .nullable(),
  /** Null without a body. */
  detections: ProbeDetectionsSchema.nullable(),
  /** target `list`: where this page sits. Records are numbered from 1. */
  page: z
    .object({
      /** 1 for the first page. */
      index: z.number().int().positive(),
      from: CountSchema,
      to: CountSchema,
      /** IDs repeated from the previous page; 0 is the pass condition. */
      overlap: CountSchema,
      /** Opaque; send back as `next`. Null on the last page. */
      next: z.string().max(4096).nullable(),
    })
    .nullable(),
});
