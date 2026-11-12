import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiScopeSchema, type Mode } from '@/shared/contracts/common.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { getMode } from '@/web/lib/mode.ts';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  Label,
  Select,
  useFormErrors,
} from '@/web/ui/index.ts';
import { KeyDisclosure } from './key-disclosure.tsx';
import { type ApiKey, SCOPE_LABEL, useCreateKey } from './queries.ts';

const SCOPES = ApiScopeSchema.options;
const DAY = 86_400_000;
const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];
const MODES = [
  { value: 'live', label: 'Live' },
  { value: 'test', label: 'Test' },
];

export interface CreateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  principal: string;
  orgId: string | null;
  orgName: string;
}

function ScopeRows({
  value,
  onChange,
  error,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  error?: string | undefined;
}) {
  return (
    <fieldset
      className="flex min-w-0 flex-col"
      aria-describedby={error ? 'scopes-error' : undefined}
    >
      <legend className="mb-2 text-sm font-medium text-fg">
        Scopes
        <span aria-hidden className="ml-0.5 text-danger">
          *
        </span>
      </legend>
      <ul className="divide-y divide-border rounded-md border border-border-strong">
        {SCOPES.map((s, i) => {
          const id = `scope-${s.replace(':', '-')}`;
          // The first box carries the group's error, so a blocked submit focuses it once.
          const flagged = Boolean(error) && i === 0;
          return (
            <li key={s} className="flex min-h-11 items-center gap-3 px-3 py-2">
              <Checkbox
                id={id}
                aria-invalid={flagged || undefined}
                aria-describedby={flagged ? 'scopes-error' : undefined}
                checked={value.includes(s)}
                onCheckedChange={(c) =>
                  onChange(c === true ? [...value, s] : value.filter((x) => x !== s))
                }
              />
              <Label htmlFor={id} className="min-w-0 flex-1 font-normal">
                {SCOPE_LABEL[s] ?? s}
              </Label>
              <code className="shrink-0 font-mono text-xs text-fg-muted">{s}</code>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p id="scopes-error" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
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
  const [expiry, setExpiry] = useState('90');
  // A key made in Test mode is a Test key unless the admin picks Live.
  const [keyMode, setKeyMode] = useState<Mode>(getMode);
  const [openingMode, setOpeningMode] = useState<Mode>(getMode);
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [created, setCreated] = useState<ApiKey & { secret: string }>();
  const [reviewKey, setReviewKey] = useState(false);
  useEffect(() => {
    if (!open) return;
    const mode = getMode();
    setKeyMode(mode);
    setOpeningMode(mode);
  }, [open]);
  const check = useFormErrors({
    ...(name.trim() ? {} : { name: 'Required.' }),
    ...(scopes.length ? {} : { scopes: 'Pick at least one scope.' }),
  });
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };

  function close() {
    onOpenChange(false);
    setName('');
    setScopes([]);
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
      dirty={name.trim() !== '' || scopes.length > 0 || expiry !== '90' || keyMode !== openingMode}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title="New API key"
        description="Choose the mode, permissions and expiry for this credential."
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
          <FormField
            label="Mode"
            help={
              keyMode === 'test'
                ? 'Passes made with a Test key are test passes. Their emails stay in the Test inbox.'
                : 'Passes are real and emails are sent.'
            }
          >
            {(p) => (
              <Select
                {...p}
                value={keyMode}
                onValueChange={(v) => setKeyMode(v as Mode)}
                options={MODES}
              />
            )}
          </FormField>
          <ScopeRows value={scopes} onChange={setScopes} error={errors.scopes} />
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
