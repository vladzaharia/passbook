import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { EntitlementKey } from '../../shared/contracts/entitlements.ts';
import { sandboxQuota } from '../../shared/copy/developer.ts';
import { ENTITLEMENT_LABEL, limitRefusal } from '../../shared/copy/entitlements.ts';

export interface FieldIssue {
  path: string;
  message: string;
  code?: string;
}

export interface AppErrorOptions {
  detail?: string;
  issues?: FieldIssue[];
  headers?: Record<string, string>;
  /** The entitlement key a FEATURE_NOT_INCLUDED refusal names. */
  feature?: string;
  /** A FEATURE_LIMIT_REACHED refusal: the cap and what the organization holds. */
  limit?: number;
  used?: number;
  cause?: unknown;
}

/** Domain errors carry a stable code; only this module maps them to HTTP. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues?: FieldIssue[];
  readonly headers?: Record<string, string>;
  readonly feature?: string;
  readonly limit?: number;
  readonly used?: number;

  constructor(code: string, status: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    if (options.issues) this.issues = options.issues;
    if (options.headers) this.headers = options.headers;
    if (options.feature) this.feature = options.feature;
    if (options.limit !== undefined) this.limit = options.limit;
    if (options.used !== undefined) this.used = options.used;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request.', issues: FieldIssue[] = [], code = 'VALIDATION') {
    super(code, 422, message, { issues });
  }
}
export class BadRequestError extends AppError {
  constructor(message = 'Bad request.', code = 'BAD_REQUEST') {
    super(code, 400, message);
  }
}
export class UnauthenticatedError extends AppError {
  constructor(message = 'Sign in to continue.', code = 'UNAUTHENTICATED') {
    super(code, 401, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have access.',
    code = 'FORBIDDEN',
    options: AppErrorOptions = {},
  ) {
    super(code, 403, message, options);
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found.', code = 'NOT_FOUND') {
    super(code, 404, message);
  }
}
export class ConflictError extends AppError {
  constructor(message = 'The resource changed. Reload and retry.', code = 'CONFLICT') {
    super(code, 409, message);
  }
}
export class PreconditionFailedError extends AppError {
  constructor(message = 'The resource changed. Reload and retry.', code = 'VERSION_CONFLICT') {
    super(code, 412, message);
  }
}
export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body is too large.', code = 'PAYLOAD_TOO_LARGE') {
    super(code, 413, message);
  }
}
export class RateLimitedError extends AppError {
  constructor(
    retryAfterSeconds = 60,
    message = 'Too many requests. Try again later.',
    headers: Record<string, string> = {},
  ) {
    super('RATE_LIMITED', 429, message, {
      headers: { ...headers, 'retry-after': String(retryAfterSeconds) },
    });
  }
}
export class UpstreamError extends AppError {
  constructor(message = 'Upstream request failed.', code = 'UPSTREAM') {
    super(code, 502, message);
  }
}
export class UnavailableError extends AppError {
  constructor(message = 'Service unavailable. Try again later.', code = 'UNAVAILABLE') {
    super(code, 503, message);
  }
}

/** 403 `FEATURE_NOT_INCLUDED`: the organization's entitlements lack `feature` (the request guard's refusal). */
export class FeatureNotIncludedError extends AppError {
  constructor(feature: string, message: string) {
    super('FEATURE_NOT_INCLUDED', 403, message, { feature });
  }
}

/**
 * Why a grant refused (section 1.2). Ordered by deny precedence: org first, stale last. `staff` is a
 * bound staff member who changed (409, the device stays paired). `entitlement` and `limit` are the org's
 * Features (design-multi-tenancy.md section 2): a feature that is not included, or a cap that is reached.
 */
export const DENY_REASONS = [
  'org',
  'actor',
  'staff',
  'config',
  'lineage',
  'release',
  'retention',
  'entitlement',
  'limit',
  'stale',
  'proof',
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** The limit a refused grant ran into: the entitlement key, its cap and the org's count. */
export interface LimitHit {
  key: EntitlementKey;
  limit: number;
  used: number;
  /** The org is a developer sandbox: the refusal is SANDBOX_QUOTA. */
  sandbox?: true;
}

/**
 * 403 `FEATURE_LIMIT_REACHED`: a create at the organization's cap; the problem carries the key, cap and
 * count. A `ForbiddenError`, so callers that treat a refused write as a rejection keep doing so.
 */
export class FeatureLimitError extends ForbiddenError {
  constructor({ key, limit, used }: LimitHit) {
    super(limitRefusal(key, limit, used), 'FEATURE_LIMIT_REACHED', { feature: key, limit, used });
  }
}

/** 403 `SANDBOX_QUOTA`: a create at a developer sandbox's cap. Same problem fields as `FeatureLimitError`. */
export class SandboxQuotaError extends ForbiddenError {
  constructor({ key, limit, used }: LimitHit) {
    super(sandboxQuota(ENTITLEMENT_LABEL[key], used, limit), 'SANDBOX_QUOTA', {
      feature: key,
      limit,
      used,
    });
  }
}

export interface DenialOptions {
  /** A scanner whose credential no longer matches must re-pair (401), not retry. */
  scanner?: boolean;
  /** Per-purpose codes, for example `{ stale: 'PASS_CHANGED' }`. */
  codes?: Partial<Record<DenyReason, string>>;
}

/** Maps a classified grant refusal to the HTTP error. Unknown reasons are a plain 403. */
export function authorityDenied(
  reason: DenyReason | string,
  options: DenialOptions = {},
): AppError {
  const code = options.codes?.[reason as DenyReason];
  switch (reason) {
    case 'org':
      return new ForbiddenError(
        'Organization access changed. Reload and retry.',
        code ?? 'ORG_ACCESS_CHANGED',
      );
    case 'actor':
      return options.scanner
        ? new UnauthenticatedError('Pair this device again.', code ?? 'SCANNER_REPAIR')
        : new ForbiddenError('You no longer have access.', code ?? 'ACTOR_CHANGED');
    case 'config':
      return new ConflictError(
        'Configuration changed. Reload and retry.',
        code ?? 'SCAN_CONFIG_CHANGED',
      );
    case 'lineage':
      return new ConflictError('The pass changed. Reload and retry.', code ?? 'LINEAGE_CHANGED');
    case 'release':
      return new ConflictError(
        'The template release changed. Reload and retry.',
        code ?? 'TEMPLATE_RELEASE_CHANGED',
      );
    case 'retention':
      return new ConflictError(
        'This record is retained. Reload and retry.',
        code ?? 'RETENTION_CHANGED',
      );
    case 'staff':
      return new ConflictError(
        'Staff changed. Sign in again and retry.',
        code ?? 'SCAN_STAFF_CHANGED',
      );
    case 'entitlement':
      return new ForbiddenError(
        "This isn't included for this organization. Ask PassBook to turn it on.",
        code ?? 'FEATURE_NOT_INCLUDED',
      );
    case 'limit':
      return new ForbiddenError(
        'This organization has reached its limit. Ask PassBook for more.',
        code ?? 'FEATURE_LIMIT_REACHED',
      );
    case 'stale':
      return new ConflictError('The resource changed. Reload and retry.', code ?? 'STALE');
    // A written row and its retention proof disagree: a server fault, never a retained or quarantined record.
    case 'proof':
      return new AppError(
        code ?? 'SCAN_PROOF_MISMATCH',
        500,
        'The record could not be signed. Try again.',
      );
    default:
      return new ForbiddenError('You do not have access.', code ?? 'AUTHORITY_DENIED');
  }
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  requestId?: string;
  issues?: FieldIssue[];
  feature?: string;
  limit?: number;
  used?: number;
}

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthenticated',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  412: 'Precondition failed',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Validation failed',
  429: 'Too many requests',
  500: 'Internal error',
  501: 'Not implemented',
  502: 'Bad gateway',
  503: 'Service unavailable',
};

export function zodIssues(error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

export function toProblem(
  error: unknown,
  requestId?: string,
): Problem & { headers?: Record<string, string> } {
  let status = 500;
  let code = 'INTERNAL';
  let detail = 'Something went wrong. Try again later.';
  let issues: FieldIssue[] | undefined;
  let headers: Record<string, string> | undefined;
  let feature: string | undefined;
  let limit: number | undefined;
  let used: number | undefined;

  if (error instanceof AppError) {
    ({ status, code, issues, headers, feature, limit, used } = error);
    detail = error.message;
  } else if (error instanceof ZodError) {
    status = 422;
    code = 'VALIDATION';
    detail = 'Invalid request.';
    issues = zodIssues(error);
  } else if (error instanceof HTTPException) {
    status = error.status;
    code = status === 404 ? 'NOT_FOUND' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'HTTP_ERROR';
    detail = status < 500 ? error.message || TITLES[status] || 'Request failed.' : detail;
  }
  return {
    type: `urn:wallet:problem:${code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[status] ?? 'Error',
    status,
    code,
    detail,
    ...(requestId ? { requestId } : {}),
    ...(issues?.length ? { issues } : {}),
    ...(feature ? { feature } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(used === undefined ? {} : { used }),
    ...(headers ? { headers } : {}),
  };
}

export function problemResponse(error: unknown, requestId?: string): Response {
  const { headers, ...body } = toProblem(error, requestId);
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: {
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}
