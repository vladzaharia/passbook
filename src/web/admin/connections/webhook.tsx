import { useState } from 'react';
import type { RecipeInfo } from '@/shared/contracts/connections.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CopyButton,
  FormField,
  KeyValue,
  SecretReveal,
  Select,
  toast,
} from '../../ui/index.ts';
import { signingSecretError } from './recipe-copy.ts';
import { SigningSecretField } from './recipe-picker.tsx';

const OVERLAPS = [
  { value: '0', label: 'No time' },
  { value: '3600', label: '1 hour' },
  { value: '86400', label: '1 day' },
  { value: '604800', label: '7 days' },
];

/** 32 random bytes as hex. The client generates it so the server never has to echo a secret. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Endpoint URL and the signing secret, with Rotate next to it; a new secret shows once. */
export function WebhookPanel({
  url,
  hasSecret,
  canManage,
  sender,
  prevUntil,
  onRotate,
}: {
  url: string | null;
  hasSecret: boolean;
  canManage: boolean;
  /** The recipe this connection reads, if it has one. */
  sender?: RecipeInfo | undefined;
  /** Until when the replaced secret still works. */
  prevUntil?: number | null | undefined;
  /** Saves a new secret; resolves once stored. */
  onRotate: (secret: string, overlapSeconds: number) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [turns, setTurns] = useState(0);
  const [pasted, setPasted] = useState('');
  const [overlap, setOverlap] = useState('86400');
  const paste = sender?.pasteSecret === true && sender.id !== 'custom';
  const pasteError = paste ? signingSecretError(sender.id, pasted) : undefined;
  const verb = paste ? 'Replace' : hasSecret ? 'Rotate' : 'Create';
  const older = prevUntil && prevUntil > Date.now() ? prevUntil : null;
  return (
    <Card>
      <CardHeader title="Webhook" />
      <CardBody className="flex min-w-0 flex-col gap-4">
        <KeyValue
          items={[
            ...(sender ? [{ label: 'Sender', value: sender.label }] : []),
            {
              label: 'Endpoint URL',
              value: url ? (
                <span className="flex items-start gap-1">
                  <span className="min-w-0 break-all font-mono text-xs">{url}</span>
                  <CopyButton value={url} label="Copy endpoint URL" className="-mt-1.5 shrink-0" />
                </span>
              ) : null,
            },
            {
              label: 'Signing secret',
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{hasSecret ? 'Set' : 'Not set'}</span>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      done={turns || undefined}
                      iconStart={<ACTION_ICON.rotate aria-hidden />}
                      onClick={() => setAsking(true)}
                    >
                      {verb}
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
        {older ? (
          <Callout tone="info">The old secret still works until {formatDateTime(older)}.</Callout>
        ) : null}
        {canManage && secret ? (
          <SecretReveal
            fields={[{ label: 'Signing secret', value: secret, copyLabel: 'Copy signing secret' }]}
            onDone={() => setSecret(undefined)}
          />
        ) : null}
      </CardBody>
      {canManage ? (
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          title={
            paste
              ? 'Replace the signing secret?'
              : hasSecret
                ? 'Rotate the signing secret?'
                : 'Create a signing secret?'
          }
          description={
            <span className="flex flex-col gap-3 text-left">
              {hasSecret ? (
                <span>
                  {overlap === '0'
                    ? 'Senders using the old secret are rejected at once.'
                    : 'Deliveries signed with the old secret are accepted for the time below.'}
                </span>
              ) : null}
              {paste ? (
                <SigningSecretField
                  recipe={sender.id as Exclude<typeof sender.id, 'custom'>}
                  value={pasted}
                  onChange={setPasted}
                  error={pasted ? pasteError : undefined}
                />
              ) : null}
              {hasSecret ? (
                <FormField label="Keep the old secret for">
                  {(c) => (
                    <Select {...c} options={OVERLAPS} value={overlap} onValueChange={setOverlap} />
                  )}
                </FormField>
              ) : null}
            </span>
          }
          confirmLabel={verb}
          destructive={hasSecret && !paste}
          confirmDisabled={Boolean(pasteError)}
          onConfirm={async () => {
            const next = paste ? pasted.trim() : generateSecret();
            await onRotate(next, Number(overlap));
            if (!paste) setSecret(next);
            setPasted('');
            setTurns((n) => n + 1);
            toast.success(hasSecret ? 'Secret replaced' : 'Secret created');
          }}
        />
      ) : null}
    </Card>
  );
}
