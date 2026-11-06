import { Button, CheckboxField, FormField, Select } from '@/web/ui/index.ts';
import { useUserList } from '../../users/queries.ts';
import { useScannerPages } from '../queries.ts';
import type { ScannerFieldsProps } from './scanner-fields.tsx';

export function SetupFields({
  draft,
  onChange,
  newSetup,
  errors,
}: Pick<ScannerFieldsProps, 'draft' | 'onChange' | 'newSetup' | 'errors'>) {
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
      <FormField label="View">
        {(p) => (
          <Select
            {...p}
            value={draft.deviceRole}
            disabled={!newSetup && !!draft.adminUserId}
            onValueChange={(deviceRole) =>
              onChange({
                deviceRole: deviceRole as typeof draft.deviceRole,
                adminUserId: '',
                watch: {
                  ...draft.watch,
                  allOrg: deviceRole === 'customer' ? false : draft.watch.allOrg,
                },
                ...(deviceRole === 'scan' && draft.kind === 'display' ? { kind: 'device' } : {}),
              })
            }
            options={[
              { value: 'scan', label: 'Scanner' },
              { value: 'customer', label: 'Customer screen' },
              { value: 'monitor', label: 'Desk monitor' },
            ]}
          />
        )}
      </FormField>
      {newSetup && draft.deviceRole === 'scan' ? (
        <AdminOwner draft={draft} onChange={onChange} />
      ) : null}
      {draft.deviceRole !== 'scan' ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Follow scanners</legend>
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

function AdminOwner({ draft, onChange }: Pick<ScannerFieldsProps, 'draft' | 'onChange'>) {
  const users = useUserList({ status: 'active' });
  const admins =
    users.data?.pages.flatMap((p) => p.items).filter((u) => u.lastRoles.includes('admin')) ?? [];
  return (
    <>
      <FormField
        label="Admin session"
        help="Optional. Uses the admin’s sign-in instead of a pairing code."
      >
        {(p) => (
          <Select
            {...p}
            value={draft.adminUserId || 'paired'}
            onValueChange={(id) => onChange({ adminUserId: id === 'paired' ? '' : id })}
            options={[
              { value: 'paired', label: 'Pair a device' },
              ...admins.map((u) => ({ value: u.id, label: u.name ?? u.primaryEmail })),
            ]}
          />
        )}
      </FormField>
      {users.hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          loading={users.isFetchingNextPage}
          onClick={() => void users.fetchNextPage()}
        >
          More admins
        </Button>
      ) : null}
    </>
  );
}
