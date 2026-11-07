import { Badge, Button, CheckboxField, FormField } from '@/web/ui/index.ts';
import { useScannerPages } from '../queries.ts';
import type { ScannerFieldsProps } from './scanner-fields.tsx';

export function SetupFields({
  draft,
  onChange,
  errors,
}: Pick<ScannerFieldsProps, 'draft' | 'onChange' | 'errors'>) {
  const scanners = useScannerPages(
    draft.orgId || undefined,
    false,
    !!draft.orgId && draft.deviceRole !== 'scan',
  );
  const sources =
    scanners.data?.pages
      .flatMap((p) => p.items)
      .filter(
        (s) => s.deviceRole === 'scan' && s.orgId === draft.orgId && s.status !== 'revoked',
      ) ?? [];
  return (
    <>
      <FormField
        label="Legacy device role"
        help={
          draft.deviceRole === 'monitor'
            ? 'This standalone monitor remains read-only. Create a session device for the action-capable Operator view.'
            : 'New devices use session layouts: Scanner, Operator or Customer display.'
        }
      >
        {() => (
          <div className="flex min-h-9 items-center">
            <Badge>
              {draft.deviceRole === 'scan'
                ? 'Scanner'
                : draft.deviceRole === 'monitor'
                  ? 'Desk monitor'
                  : 'Customer display'}
            </Badge>
          </div>
        )}
      </FormField>
      {draft.deviceRole !== 'scan' ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Follow scanners</legend>
          <p className="text-xs text-fg-muted">
            This display shows results from the selected scanners.
          </p>
          {draft.deviceRole === 'monitor' ? (
            <CheckboxField
              label="All scanners in this organization"
              checked={draft.watch.allOrg}
              onCheckedChange={(checked) =>
                onChange({ watch: { ...draft.watch, allOrg: checked === true } })
              }
            />
          ) : null}
          {sources.map((source) => (
            <CheckboxField
              key={source.id}
              label={source.name}
              checked={draft.watch.scannerIds.includes(source.id)}
              disabled={
                draft.watch.allOrg ||
                (draft.watch.scannerIds.length >= 8 && !draft.watch.scannerIds.includes(source.id))
              }
              onCheckedChange={(checked) =>
                onChange({
                  watch: {
                    allOrg: false,
                    scannerIds:
                      checked === true
                        ? [...draft.watch.scannerIds, source.id]
                        : draft.watch.scannerIds.filter((id) => id !== source.id),
                  },
                })
              }
            />
          ))}
          {sources.length === 0 ? (
            <p className="text-sm text-fg-muted">Create a scanner first.</p>
          ) : null}
          {scanners.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              loading={scanners.isFetchingNextPage}
              onClick={() => void scanners.fetchNextPage()}
            >
              More scanners
            </Button>
          ) : null}
          {errors.watch ? (
            <p role="alert" className="text-sm text-danger">
              {errors.watch}
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </>
  );
}
