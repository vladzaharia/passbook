import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { ApiScopeSchema } from '@/shared/contracts/common.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  Form,
  FormField,
  Input,
  Label,
  SecretReveal,
  Select,
  useFormErrors,
} from '@/web/ui/index.ts';
import { useOrgList } from '../orgs/queries.ts';
import { SCOPE_LABEL, useCreateKey } from './queries.ts';

const SCOPES = ApiScopeSchema.options;
const DAY = 86_400_000;
const EXPIRY = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];
const PLATFORM = 'platform';

export interface CreateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export function CreateKeyDialog({ open, onOpenChange }: CreateKeyDialogProps) {
  const orgs = useOrgList();
  const { orgId: scoped } = useOrgScope();
  const create = useCreateKey();
  const [name, setName] = useState('');
  const [org, setOrg] = useState(scoped ?? PLATFORM);
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('90');
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [secret, setSecret] = useState<string>();
  const check = useFormErrors({
    ...(name.trim() ? {} : { name: 'Required.' }),
    ...(scopes.length ? {} : { scopes: 'Pick at least one scope.' }),
  });
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };

  function close() {
    onOpenChange(false);
    setName('');
    setOrg(scoped ?? PLATFORM);
    setScopes([]);
    setExpiry('90');
    setServer({});
    check.reset();
    setFormError(undefined);
    setSecret(undefined);
  }

  async function submit() {
    setFormError(undefined);
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        orgId: org === PLATFORM ? null : org,
        scopes: scopes as (typeof SCOPES)[number][],
        expiresAt: expiry === 'never' ? null : Date.now() + Number(expiry) * DAY,
      });
      setSecret(created.secret);
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) setServer(cause.fields);
      else setFormError(errorMessage(cause));
    }
  }

  if (secret) {
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
          <SecretReveal
            fields={[{ label: 'API key', value: secret, copyLabel: 'Copy API key' }]}
            savedLabel="I saved the key"
            onDone={close}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      dirty={name.trim() !== '' || scopes.length > 0}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
      <DialogContent
        size="md"
        title="New API key"
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
          onValid={() => void submit()}
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
            <FormField label="Organization" error={errors.orgId}>
              {(p) => (
                <Select
                  {...p}
                  value={org}
                  onValueChange={setOrg}
                  options={[
                    { value: PLATFORM, label: 'All organizations' },
                    ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
                  ]}
                />
              )}
            </FormField>
            <FormField label="Expires" error={errors.expiresAt}>
              {(p) => <Select {...p} value={expiry} onValueChange={setExpiry} options={EXPIRY} />}
            </FormField>
          </div>
          <ScopeRows value={scopes} onChange={setScopes} error={errors.scopes} />
          {formError ? <p className="text-sm text-danger">{formError}</p> : null}
        </Form>
      </DialogContent>
    </Dialog>
  );
}
