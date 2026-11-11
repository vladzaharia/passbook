import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { Button, EntityPicker } from '@/web/ui/index.ts';

/** One sentence for why a real pass cannot be previewed. */
export function previewErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 404) return 'That pass is not in this template and mode. Pick another.';
    if (error.status === 403) return 'You cannot preview passes in this organization.';
  }
  return errorMessage(error);
}

export function RealPassPicker({
  passId,
  error,
  onPick,
  onRetry,
}: {
  passId: string | null;
  error: unknown;
  onPick: (id: string) => void;
  onRetry: () => void;
}) {
  return (
    <>
      <div className="sp-pass-id">
        <EntityPicker
          kind="pass"
          aria-label="Pass"
          value={passId ?? undefined}
          valueLabel="Selected pass"
          placeholder="Find a pass"
          onValueChange={onPick}
        />
      </div>
      {error ? (
        <p className="sp-error" role="alert">
          {previewErrorMessage(error)}{' '}
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </p>
      ) : null}
    </>
  );
}
