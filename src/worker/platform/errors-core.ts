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
  /** An IDP_SIGN_IN_REQUIRED refusal: the sign-in path that keeps the caller's place. */
  signInUrl?: string;
  /** An OPERATION_RUNNING refusal: the operation already doing this. */
  operationId?: string;
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
  readonly signInUrl?: string;
  readonly operationId?: string;

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
    if (options.signInUrl) this.signInUrl = options.signInUrl;
    if (options.operationId) this.operationId = options.operationId;
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
  constructor(message = 'Not found.', code = 'NOT_FOUND', issues?: FieldIssue[]) {
    super(code, 404, message, issues ? { issues } : undefined);
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
