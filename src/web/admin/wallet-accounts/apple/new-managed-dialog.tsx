import { useState } from 'react';
import { handleBase, MANAGED_PREFIX } from '@/shared/identity-handle.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import {
  Button,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  Select,
  toast,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useOrgList } from '../../orgs/queries.ts';
import { useStartManagedIdentity } from './managed-queries.ts';

const FORM_ID = 'new-managed-identity';
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
  const [picked, setPicked] = useState('');
  const [handle, setHandle] = useState('');
  const [formError, setFormError] = useState<string>();
  const orgId = fixedOrg ?? picked;
  const start = useStartManagedIdentity(orgId);
  const org = orgs.data?.items.find((o) => o.id === orgId);
  const typed = handle.trim().toLowerCase();
  const shown = typed || (org ? handleBase(org.slug) : '');
  const check = useFormErrors({
    ...(orgId ? {} : { org: 'Choose an organization.' }),
    ...(typed && !HANDLE.test(typed) ? { handle: '2 to 30 lowercase letters or digits.' } : {}),
  });

  function close() {
    onOpenChange(false);
    setPicked('');
    setHandle('');
    setFormError(undefined);
    check.reset();
  }

  async function submit() {
    setFormError(undefined);
    try {
      await start.mutateAsync(typed || undefined);
      toast.success('Setup started');
      close();
    } catch (cause) {
      setFormError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      dirty={Boolean(picked || handle)}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        title="New managed ID"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} loading={start.isPending}>
              Create
            </Button>
          </>
        }
      >
        <Form
          id={FORM_ID}
          className="flex flex-col gap-4"
          {...check.form}
          onValid={() => void submit()}
        >
          {fixedOrg ? null : (
            <FormField label="Organization" required error={check.errors.org}>
              {(p) => (
                <Select
                  {...p}
                  value={picked}
                  onValueChange={setPicked}
                  options={(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
                />
              )}
            </FormField>
          )}
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
          <p aria-live="polite" className="break-all font-mono text-sm text-fg-strong">
            {MANAGED_PREFIX}
            {shown || '<handle>'}
          </p>
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
