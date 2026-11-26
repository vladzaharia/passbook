import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { AppError, type FieldIssue } from './errors-core.ts';
import { isInternalCode } from './internal-codes.ts';

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
  signInUrl?: string;
  operationId?: string;
}

/** Where a `Problem.type` points: the catalog page of the code (docs/api/errors.json). */
const PROBLEM_TYPE_BASE = 'https://passbook.mobile/developers/errors/';

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
  let signInUrl: string | undefined;
  let operationId: string | undefined;

  if (error instanceof AppError && !isInternalCode(error.code)) {
    ({ status, code, issues, headers, feature, limit, used, signInUrl, operationId } = error);
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
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: TITLES[status] ?? 'Error',
    status,
    code,
    detail,
    ...(requestId ? { requestId } : {}),
    ...(issues?.length ? { issues } : {}),
    ...(feature ? { feature } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(used === undefined ? {} : { used }),
    ...(signInUrl ? { signInUrl } : {}),
    ...(operationId ? { operationId } : {}),
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
