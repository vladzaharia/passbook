import { ZodError } from 'zod';
import { ValidationError } from '../../platform/errors.ts';

/**
 * A body whose only fault is target keys the target does not define is 422 `BROADCAST_UNSUPPORTED_FILTER`,
 * naming each field. Any other failure stays a plain validation error.
 */
export function unsupportedFilter(error: unknown): ValidationError | undefined {
  if (!(error instanceof ZodError)) return undefined;
  const keys: string[] = [];
  for (const issue of error.issues) {
    if (issue.code !== 'unrecognized_keys' || issue.path.length !== 1 || issue.path[0] !== 'target')
      return undefined;
    keys.push(...issue.keys);
  }
  if (keys.length === 0) return undefined;
  return new ValidationError(
    `A target does not filter by ${keys.join(', ')}.`,
    keys.map((key) => ({
      path: `target.${key}`,
      message: 'Not a filter a target takes.',
      code: 'unrecognized_keys',
    })),
    'BROADCAST_UNSUPPORTED_FILTER',
  );
}
