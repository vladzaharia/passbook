import { ProblemSchema } from '@/shared/contracts/common.ts';

export interface ApiErrorInit {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  requestId?: string;
  fields?: Record<string, string>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly requestId: string | undefined;
  /** Field path to message, from problem `issues`. */
  readonly fields: Record<string, string>;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title ?? init.code);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title ?? init.code;
    this.requestId = init.requestId;
    this.fields = init.fields ?? {};
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409 || this.status === 412;
  }
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Maps a non-2xx response body (problem+json or anything else) to an ApiError. */
export function problemToError(status: number, body: unknown): ApiError {
  const parsed = ProblemSchema.safeParse(body);
  if (parsed.success) {
    const p = parsed.data;
    const fields: Record<string, string> = {};
    for (const issue of p.issues ?? []) {
      if (!(issue.path in fields)) fields[issue.path] = issue.message;
    }
    return new ApiError({
      status,
      code: p.code,
      title: p.title,
      detail: p.detail,
      requestId: p.requestId,
      fields,
    });
  }
  return new ApiError({
    status,
    code: status >= 500 ? 'server_error' : 'request_failed',
    detail: status >= 500 ? 'Server error. Try again.' : 'Request failed.',
  });
}

/** One sentence for the UI. Never exposes raw server text for 5xx. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 0) return 'Network error. Check your connection.';
    if (error.status === 403) return 'You do not have access.';
    if (error.status >= 500) return 'Server error. Try again.';
    return error.message;
  }
  return 'Something went wrong. Try again.';
}
