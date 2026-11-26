import { useState } from 'react';
import { handleBase, MANAGED_PREFIX } from '@/shared/identity-handle.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { FormDialog, FormField, Input, Select, toast, useFormErrors } from '@/web/ui/index.ts';
import { useOrgList } from '../../orgs/queries.ts';
import { useStartManagedIdentity } from './managed-queries.ts';

const HANDLE = /^[a-z][a-z0-9]{1,29}$/;

/** Starts a managed Apple identity for an organization; Apple's side takes a few minutes. */
export function NewManagedIdentityDialog({
  open,
  onOpenChange,
  orgId: fixedOrg,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when the organization is already chosen. */
  orgId?: string;
}) {
  const orgs = useOrgList();
  const scope = useOrgScope();
  const [picked, setPicked] = useState('');
  const [handle, setHandle] = useState('');
  const orgId = fixedOrg ?? picked;
  const start = useStartManagedIdentity(orgId);
  const org = orgs.data?.items.find((o) => o.id === orgId);
  const typed = fixedOrg ? '' : handle.trim().toLowerCase();
  const slug = org?.slug ?? (fixedOrg ? scope.membership?.orgSlug : undefined);
  const shown = typed || (slug ? handleBase(slug) : '');
  const check = useFormErrors({
    ...(orgId ? {} : { org: 'Choose an organization.' }),
    ...(typed && !HANDLE.test(typed) ? { handle: '2 to 30 lowercase letters or digits.' } : {}),
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New managed ID"
      dirty={Boolean(picked || handle)}
      check={check}
      submitLabel="Create"
      busy={start.isPending}
      onSubmit={async () => {
        await start.mutateAsync(typed || undefined);
        toast.success('Setup started');
        onOpenChange(false);
      }}
      onClose={() => {
        setPicked('');
        setHandle('');
      }}
    >
      {fixedOrg ? null : (
        <FormField label="Organization" required error={check.errors.org}>
          {(p) => (
            <Select
              {...p}
              data-autofocus
              value={picked}
              onValueChange={setPicked}
              options={(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
            />
          )}
        </FormField>
      )}
      {fixedOrg ? null : (
        <FormField label="Handle" error={check.errors.handle}>
          {(p) => (
            <Input
              {...p}
              value={handle}
              spellCheck={false}
              autoCapitalize="none"
              onChange={(e) => setHandle(e.target.value)}
            />
          )}
        </FormField>
      )}
      <p aria-live="polite" className="break-all font-mono text-sm text-fg-strong">
        {MANAGED_PREFIX}
        {shown || '<handle>'}
      </p>
    </FormDialog>
  );
}
