import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  FormField,
  Input,
  SkeletonRows,
  StatusPill,
  toast,
} from '../ui/index.ts';
import { addEmail, myEmailsKey, myEmailsQuery, removeEmail } from './api.ts';

function CodeForm({ email, onDone }: { email: string; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const verify = useMutation({
    mutationFn: () => api.action('POST', '/auth/magic/consume', { email, code }),
    onSuccess: () => {
      toast.success('Email verified');
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code.');
    verify.mutate();
  }
  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2" noValidate>
      <FormField label="Code" error={error} className="w-40">
        {(control) => (
          <Input
            {...control}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        )}
      </FormField>
      <Button type="submit" size="sm" loading={verify.isPending}>
        Verify
      </Button>
    </form>
  );
}

export function EmailsSection() {
  const client = useQueryClient();
  const query = useQuery(myEmailsQuery);
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [entering, setEntering] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: myEmailsKey });

  const add = useMutation({
    mutationFn: (value: string) => addEmail(value),
    onSuccess: async (_res, value) => {
      setEmail('');
      setEntering(value);
      toast.success(`Verification sent to ${value}`);
      await refresh();
    },
    onError: (e) => setFieldError(errorMessage(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setFieldError(undefined);
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return setFieldError('Enter a valid email.');
    add.mutate(value);
  }

  return (
    <Card>
      <CardHeader title="Emails" />
      <CardBody className="flex flex-col gap-4">
        {query.isPending ? <SkeletonRows rows={2} /> : null}
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {query.data ? (
          <ul className="divide-y divide-border">
            {query.data.items.map((item) => (
              <li key={item.email} className="py-3 first:pt-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-fg-strong">{item.email}</span>
                    {item.primary ? <StatusPill status="owned">Primary</StatusPill> : null}
                    {item.verifiedAt ? null : <StatusPill status="waiting">Unverified</StatusPill>}
                  </div>
                  <div className="flex gap-1">
                    {item.verifiedAt ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setEntering(entering === item.email ? undefined : item.email)
                        }
                      >
                        Enter code
                      </Button>
                    )}
                    {item.primary ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${item.email}`}
                        onClick={() => setRemoving(item.email)}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
                {!item.verifiedAt && entering === item.email ? (
                  <CodeForm
                    email={item.email}
                    onDone={() => {
                      setEntering(undefined);
                      void refresh();
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <form onSubmit={submit} className="flex flex-wrap items-start gap-2" noValidate>
          <FormField label="Add email" error={fieldError} className="min-w-0 flex-1 basis-60">
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </FormField>
          <Button type="submit" variant="outline" className="mt-[1.375rem]" loading={add.isPending}>
            Add
          </Button>
        </form>
      </CardBody>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title="Remove email?"
        description={`Passes sent to ${removing ?? ''} stop appearing here.`}
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await removeEmail(removing);
          await refresh();
          toast.success('Email removed');
        }}
      />
    </Card>
  );
}
