/** Fields of an RFC 9457 problem+json body, as the API sends them. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  requestId?: string;
  issues?: Array<{ path: string; message: string; code?: string }>;
  feature?: string;
  limit?: number;
  used?: number;
}

const ERRORS_PAGE = 'https://passbook.mobile/developers/errors/';

export class PassBookError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The request never produced a response: a network failure or a timeout. */
export class ConnectionError extends PassBookError {}

/** The API answered with a non-2xx status. Branch on `code`, which is stable. */
export class ApiError extends PassBookError {
  readonly status: number;
  /** Stable, upper-case, such as `VALIDATION` or `RATE_LIMITED`. */
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string | undefined;
  readonly issues: NonNullable<Problem['issues']>;
  /** FEATURE_NOT_INCLUDED and FEATURE_LIMIT_REACHED name the entitlement and the cap. */
  readonly feature: string | undefined;
  readonly limit: number | undefined;
  readonly used: number | undefined;
  /** The problem `type`: a URL, or a `urn:wallet:problem:` name on older deployments. */
  readonly type: string;
  readonly headers: Headers;

  constructor(problem: Problem & { status: number }, headers: Headers) {
    const detail = problem.detail ?? problem.title ?? `HTTP ${problem.status}`;
    super(detail);
    this.status = problem.status;
    this.code = problem.code ?? 'HTTP_ERROR';
    this.title = problem.title ?? '';
    this.detail = detail;
    this.requestId = problem.requestId;
    this.issues = problem.issues ?? [];
    this.feature = problem.feature;
    this.limit = problem.limit;
    this.used = problem.used;
    this.type =
      problem.type ?? `urn:wallet:problem:${this.code.toLowerCase().replaceAll('_', '-')}`;
    this.headers = headers;
  }

  /** The error's page in the docs. */
  get docsUrl(): string {
    return this.type.startsWith('https://')
      ? this.type
      : `${ERRORS_PAGE}${this.code.toLowerCase().replaceAll('_', '-')}`;
  }
}

export class BadRequestError extends ApiError {}
export class AuthenticationError extends ApiError {}
export class PermissionDeniedError extends ApiError {}
export class NotFoundError extends ApiError {}
export class ConflictError extends ApiError {}
export class ValidationError extends ApiError {}
export class ServerError extends ApiError {}
export class RateLimitError extends ApiError {
  /** Seconds from the `Retry-After` header, when sent. */
  get retryAfter(): number | undefined {
    const seconds = Number(this.headers.get('retry-after'));
    return Number.isFinite(seconds) && this.headers.has('retry-after') ? seconds : undefined;
  }
}

const BY_STATUS: Record<number, typeof ApiError> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: ValidationError,
  429: RateLimitError,
};

/** Reads the problem body, if there is one, and picks the class for the status. */
export async function apiErrorFrom(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let problem: Problem = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') problem = parsed as Problem;
  } catch {
    problem = { detail: text.slice(0, 200) || res.statusText };
  }
  const Class = BY_STATUS[res.status] ?? (res.status >= 500 ? ServerError : ApiError);
  return new Class({ ...problem, status: res.status }, res.headers);
}

export class WebhookSignatureError extends PassBookError {
  readonly reason: 'missing_header' | 'malformed' | 'timestamp_out_of_range' | 'mismatch';
  constructor(reason: WebhookSignatureError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}
