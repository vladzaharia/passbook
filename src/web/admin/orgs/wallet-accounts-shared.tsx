import { MODE_HEADER, type Mode } from '@/shared/contracts/common.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { Button } from '@/web/ui/index.ts';

export const headers = (mode: Mode) => ({ [MODE_HEADER]: mode });

// Server errors can include request details. Never put those details, or a submitted credential,
// in component state, the query/mutation caches, a toast, or the rendered error message.
export function safeError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401) return 'Your session has ended. Sign in and try again.';
    if (error.status === 403)
      return 'You do not have permission for this action in this organization.';
    if (error.code === 'WALLET_IDENTITY_IMMUTABLE')
      return 'The existing Google issuer or Samsung partner and card cannot be changed. Enter the original identifiers.';
    if (error.code === 'WALLET_ACCOUNT_INSTANCES_ACTIVE')
      return 'Revoke the provider objects and retire all linked wallet instances before revoking this account.';
    if (error.status === 409 || error.status === 412)
      return 'This account changed. Refresh its status and review the action again.';
    if (error.status === 400 || error.status === 422)
      return 'The provider details were rejected. Check the identifiers, keys and certificates, then enter the private key again.';
    if (error.status === 0) return 'Could not connect. Check your connection and try again.';
  }
  return 'Could not complete the request. Try again.';
}

export function Retry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
      <span>{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
