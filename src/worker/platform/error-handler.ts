import type { Context, ErrorHandler } from 'hono';
import type { AppBindings } from './context.ts';
import { NotFoundError, problemResponse, toProblem } from './errors.ts';

/** Hono `onError` handler. Unexpected errors are logged with their cause; clients only get the code. */
export const handleError: ErrorHandler<AppBindings> = (error, c) => {
  const requestId = c.var.requestId;
  const problem = toProblem(error, requestId);
  if (problem.status >= 500 && problem.status !== 501) {
    c.var.log?.error('request.failed', {
      code: problem.code,
      method: c.req.method,
      route: c.req.routePath,
      error,
    });
  }
  return problemResponse(error, requestId);
};

export function notFoundHandler(c: Context<AppBindings>): Response {
  return problemResponse(new NotFoundError(), c.var.requestId);
}
