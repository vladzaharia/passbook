import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CreatedApiKeySchema } from '@/shared/contracts/api-keys.ts';
import { ApiScopeSchema } from '@/shared/contracts/common.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import {
  Button,
  CheckboxField,
  CodeBlock,
  Dialog,
  DialogContent,
  FormField,
  Input,
  Select,
} from '@/web/ui/index.ts';
import { useOrgList } from '../orgs/queries.ts';

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

export function CreateKeyDialog({ open, onOpenChange }: CreateKeyDialogProps) {
  const client = useQueryClient();
  const orgs = useOrgList();
  const [name, setName] = useState('');
  const [org, setOrg] = useState(PLATFORM);
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('90');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [secret, setSecret] = useState<string>();

  const create = useMutation({
    mutationFn: (body: unknown) => api.post('/api/v1/api-keys', CreatedApiKeySchema, body),
    onSuccess: () => client.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  function reset() {
    setName('');
    setOrg(PLATFORM);
    setScopes([]);
    setExpiry('90');
    setErrors({});
    setFormError(undefined);
    setSecret(undefined);
  }

  function close() {
    onOpenChange(false);
    reset();
  }

  async function submit() {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Required.';
    if (scopes.length === 0) next.scopes = 'Pick at least one scope.';
    setErrors(next);
    setFormError(undefined);
    if (Object.keys(next).length > 0) return;
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        orgId: org === PLATFORM ? null : org,
        scopes,
        expiresAt: expiry === 'never' ? null : Date.now() + Number(expiry) * DAY,
      });
      setSecret(created.secret);
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) {
        setErrors(cause.fields);
      } else {
        setFormError(errorMessage(cause));
      }
    }
  }

  if (secret) {
    return (
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent
          title="Copy your key"
          description="This is the only time the secret is shown."
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          footer={<Button onClick={close}>Done</Button>}
        >
          <CodeBlock code={secret} label="API key secret" maxHeight="max-h-24" />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        title="New API key"
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button loading={create.isPending} onClick={() => void submit()}>
              Create
            </Button>
          </>
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FormField label="Name" required error={errors.name}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <FormField label="Organization" error={errors.orgId}>
            {(p) => (
              <Select
                {...p}
                value={org}
                onValueChange={setOrg}
                options={[
                  { value: PLATFORM, label: 'Platform (all orgs)' },
                  ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
                ]}
              />
            )}
          </FormField>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium text-fg-strong">Scopes</legend>
            {SCOPES.map((s) => (
              <CheckboxField
                key={s}
                label={s}
                checked={scopes.includes(s)}
                onCheckedChange={(c) =>
                  setScopes((prev) => (c === true ? [...prev, s] : prev.filter((x) => x !== s)))
                }
              />
            ))}
            {errors.scopes ? (
              <p role="alert" className="text-xs text-danger">
                {errors.scopes}
              </p>
            ) : null}
          </fieldset>
          <FormField label="Expires" error={errors.expiresAt}>
            {(p) => <Select {...p} value={expiry} onValueChange={setExpiry} options={EXPIRY} />}
          </FormField>
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
