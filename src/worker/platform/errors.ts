import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

export interface FieldIssue {
  path: string;
  message: string;
  code?: string;
}

export interface AppErrorOptions {
  detail?: string;
  issues?: FieldIssue[];
  headers?: Record<string, string>;
  cause?: unknown;
}

/** Domain errors carry a stable code; only this module maps them to HTTP. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues?: FieldIssue[];
  readonly headers?: Record<string, string>;

  constructor(code: string, status: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    if (options.issues) this.issues = options.issues;
    if (options.headers) this.headers = options.headers;
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
  constructor(message = 'You do not have access.', code = 'FORBIDDEN') {
    super(code, 403, message);
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
  constructor(retryAfterSeconds = 60, message = 'Too many requests. Try again later.') {
    super('RATE_LIMITED', 429, message, { headers: { 'retry-after': String(retryAfterSeconds) } });
  }
}
export class NotImplementedError extends AppError {
  constructor(message = 'Not implemented.') {
    super('NOT_IMPLEMENTED', 501, message);
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

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  requestId?: string;
  issues?: FieldIssue[];
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

  if (error instanceof AppError) {
    ({ status, code, issues, headers } = error);
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

/** Hono `onError` handler. Unexpected errors are logged with their cause; clients only get the code. */
export function handleError(error: unknown, c: Context): Response {
  const requestId = c.get('requestId') as string | undefined;
  const log = c.get('log') as { error: (event: string, data?: object) => void } | undefined;
  const problem = toProblem(error, requestId);
  if (problem.status >= 500 && problem.status !== 501) {
    log?.error('request.failed', {
      code: problem.code,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    });
  }
  return problemResponse(error, requestId);
}

export function notFoundHandler(c: Context): Response {
  return problemResponse(new NotFoundError(), c.get('requestId') as string | undefined);
}
