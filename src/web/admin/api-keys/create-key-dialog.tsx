import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { getMode } from '@/web/lib/mode.ts';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  Select,
  useFormErrors,
} from '@/web/ui/index.ts';
import { KeyDisclosure } from './key-disclosure.tsx';
import { type ApiKey, useCreateKey } from './queries.ts';
import { type SCOPES, ScopeRows, TerminalRows } from './scope-rows.tsx';

const DAY = 86_400_000;
const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

export interface CreateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  principal: string;
  orgId: string | null;
  orgName: string;
}

export function CreateKeyDialog({
  open,
  onOpenChange,
  principal,
  orgId,
  orgName,
}: CreateKeyDialogProps) {
  const create = useCreateKey(principal);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  const scansWrite = scopes.includes('scans:write');
  const [expiry, setExpiry] = useState('90');
  // The server gives a key the mode the console is in, so the dialog shows it and offers no choice.
  const [keyMode, setKeyMode] = useState<Mode>(getMode);
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [created, setCreated] = useState<ApiKey & { secret: string }>();
  const [reviewKey, setReviewKey] = useState(false);
  useEffect(() => {
    if (!open) return;
    setKeyMode(getMode());
  }, [open]);
  const check = useFormErrors({
    ...(name.trim() ? {} : { name: 'Required.' }),
    ...(scopes.length ? {} : { scopes: 'Pick at least one scope.' }),
    ...(!scansWrite || terminalIds.length ? {} : { terminalIds: 'Pick at least one terminal.' }),
  });
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };

  function close() {
    onOpenChange(false);
    setName('');
    setScopes([]);
    setTerminalIds([]);
    setExpiry('90');
    setKeyMode(getMode());
    setServer({});
    check.reset();
    setFormError(undefined);
    setCreated(undefined);
    setReviewKey(false);
  }

  async function submit() {
    setFormError(undefined);
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        orgId,
        scopes: scopes as (typeof SCOPES)[number][],
        ...(scansWrite ? { terminalIds } : {}),
        mode: keyMode,
        expiresAt: expiry === 'never' ? null : Date.now() + Number(expiry) * DAY,
      });
      setCreated(result);
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      else setFormError(errorMessage(cause));
    }
  }

  if (created) {
    return (
      <Dialog open={open} onOpenChange={() => undefined}>
        <DialogContent
          size="md"
          closeButton={false}
          title={
            <span className="inline-flex items-center gap-2">
              <span data-verb-done="" className="inline-flex text-accent-fg [&>svg]:size-4">
                <KeyRound aria-hidden />
              </span>
              Copy your key
            </span>
          }
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <KeyDisclosure
            created={created}
            organization={
              created.orgId === null
                ? 'Platform-wide'
                : created.orgId === orgId
                  ? orgName
                  : created.orgId
            }
            onDone={close}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      dirty={name.trim() !== '' || scopes.length > 0 || expiry !== '90'}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title="New API key"
        description="Choose the permissions and expiry for this credential."
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form="new-key" loading={create.isPending}>
              Create
            </Button>
          </>
        }
      >
        <Form
          id="new-key"
          className="flex flex-col gap-4"
          {...check.form}
          onValid={() => setReviewKey(true)}
        >
          <FormField label="Name" required error={errors.name}>
            {(p) => (
              <Input
                {...p}
                data-autofocus
                autoComplete="off"
                placeholder="Box office sync"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setServer({});
                }}
              />
            )}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium text-fg">Organization</p>
              <p className="mt-2 text-sm text-fg-strong">{orgName}</p>
              {errors.orgId ? <p className="mt-1 text-xs text-danger">{errors.orgId}</p> : null}
            </div>
            <FormField label="Expires" error={errors.expiresAt}>
              {(p) => <Select {...p} value={expiry} onValueChange={setExpiry} options={EXPIRY} />}
            </FormField>
          </div>
          <div>
            <p className="text-sm font-medium text-fg">Mode</p>
            <p className="mt-2 text-sm text-fg-strong">{keyMode === 'test' ? 'Test' : 'Live'}</p>
            <p className="mt-1 text-xs text-fg-muted">
              {keyMode === 'test'
                ? 'Test passes. Their emails stay in the Test inbox. Switch the console to Live for a Live key.'
                : 'Real passes and real emails. Switch the console to Test for a Test key.'}
            </p>
          </div>
          <ScopeRows
            value={scopes}
            onChange={setScopes}
            error={errors.scopes}
            platform={orgId === null}
          />
          {scansWrite && orgId !== null ? (
            <TerminalRows
              orgId={orgId}
              value={terminalIds}
              onChange={setTerminalIds}
              error={errors.terminalIds}
            />
          ) : null}
          {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </Form>
      </DialogContent>
      <ConfirmDialog
        open={reviewKey}
        onOpenChange={setReviewKey}
        title={orgId === null ? 'Create a platform-wide key?' : 'Review service key'}
        description={
          <span className="block">
            <span className="block">
              {orgId === null ? (
                <>
                  This key can access all organizations in {keyMode === 'test' ? 'Test' : 'Live'}{' '}
                  mode.
                </>
              ) : (
                <>
                  This key is bound to {orgName} in {keyMode === 'test' ? 'Test' : 'Live'} mode.
                </>
              )}
            </span>
            <span className="mt-3 block">Name: {name.trim()}</span>
            <span className="block">Permissions: {scopes.join(', ')}</span>
            <span className="block">
              {expiry === 'never'
                ? 'It will not expire.'
                : `It expires after ${expiry === '365' ? '1 year' : `${expiry} days`}.`}
            </span>
            <span className="mt-3 block">
              No secret has been issued yet. It will be shown once after creation.
            </span>
          </span>
        }
        confirmLabel="Create key"
        onConfirm={submit}
      />
    </Dialog>
  );
}
