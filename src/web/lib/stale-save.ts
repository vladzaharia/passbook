import { isApiError } from '@/web/lib/errors.ts';
import { toast } from '@/web/ui/toaster.tsx';

/** A save made from values older than the stored ones (409 `SETTINGS_CHANGED`). */
export const isStaleSave = (cause: unknown): boolean =>
  isApiError(cause) && cause.status === 409 && cause.code === 'SETTINGS_CHANGED';

/**
 * The one pattern for a stale settings, org or branding save: reload the current values, keep the
 * user's edits, say so. Returns true when `cause` was a stale save and is handled.
 */
export function handleStaleSave(cause: unknown, refetch: () => unknown): boolean {
  if (!isStaleSave(cause)) return false;
  void refetch();
  toast.info('Saved by someone else first. Your changes are kept. Review them, then save again.');
  return true;
}
