import { Badge, Button, Callout, CheckboxField, FormField, SwitchRow } from '@/web/ui/index.ts';
import { useScannerPages } from '../queries.ts';
import { type ScannerDraft, watchKind } from './scanner-draft.ts';
import { WatchFields } from './watch-fields.tsx';

export interface SetupFieldsProps {
  draft: ScannerDraft;
  onChange: (patch: Partial<ScannerDraft>) => void;
  errors: Partial<Record<string, string>>;
}

export function SetupFields({ draft, onChange, errors }: SetupFieldsProps) {
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
      {draft.deviceRole !== 'scan' ? (
        <FormField
          label="Legacy device role"
          help={
            draft.deviceRole === 'monitor'
              ? 'This standalone monitor is read-only unless Desk actions is on.'
              : 'Add new devices from a session.'
          }
        >
          {() => (
            <div className="flex min-h-9 items-center">
              <Badge>
                {draft.deviceRole === 'scan'
                  ? 'Scanner'
                  : draft.deviceRole === 'monitor'
                    ? 'Desk display'
                    : 'Customer display'}
              </Badge>
            </div>
          )}
        </FormField>
      ) : null}
      {draft.deviceRole !== 'scan' ? (
        <WatchFields draft={draft} onChange={onChange} error={errors.watch} />
      ) : null}
      {draft.deviceRole === 'monitor' ? (
        <>
          <SwitchRow
            label="Desk actions"
            help="Staff sign in here to let people in and mark them out. Guest limits ask for a Manager."
            checked={draft.deskActions}
            onCheckedChange={(deskActions) => onChange({ deskActions })}
          />
          {draft.deskActions ? (
            <Callout tone="info">
              Every action is signed by the staff member and shows in the pass’s activity.
            </Callout>
          ) : null}
        </>
      ) : null}
      {draft.deviceRole !== 'scan' && watchKind(draft.watch) === 'scanners' ? (
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
