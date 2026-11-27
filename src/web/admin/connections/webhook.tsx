import { Link } from '@tanstack/react-router';
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
  CopyButton,
  Dialog,
  DialogContent,
  KeyValue,
  SecretReveal,
  toast,
} from '../../ui/index.ts';
import { RotateSecretForm, useRotateSecret } from '../../ui/webhook-setup/index.ts';
import { signingSecretError } from './recipe-copy.ts';
import { SigningSecretField } from './recipe-picker.tsx';
import { INBOUND_CHOICES } from './secret-step.tsx';
import { dropSecret } from './setup-handoff.ts';

/** 32 random bytes as hex. The client generates it so the server never has to echo a secret. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Endpoint URL and the signing secret, with Rotate next to it; a new secret shows once. */
export function WebhookPanel({
  connectionId,
  url,
  hasSecret,
  canManage,
  sender,
  prevUntil,
  awaiting,
  initialSecret,
  secretFormat,
  onRotate,
}: {
  connectionId: string;
  url: string | null;
  hasSecret: boolean;
  canManage: boolean;
  /** The recipe this connection reads, if it has one. */
  sender?: RecipeInfo | undefined;
  /** Until when the replaced secret still works. */
  prevUntil?: number | null | undefined;
  /** No correctly signed delivery has arrived yet: Setup picks up where it left off. */
  awaiting?: boolean;
  /** The secret made at Create, for a connection that has no setup page. Shown once. */
  initialSecret?: string | undefined;
  /** How the sender's own secret looks, for the paste check. */
  secretFormat?: { prefix: string | null; minLength: number } | undefined;
  /** Saves a new secret; resolves once stored. */
  onRotate: (secret: string, overlapSeconds: number) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [secret, setSecret] = useState(initialSecret);
  const [turns, setTurns] = useState(0);
  const [pasted, setPasted] = useState('');
  const paste = sender?.pasteSecret === true && sender.id !== 'custom';
  const pasteError = paste
    ? signingSecretError(
        secretFormat ?? { prefix: null, minLength: 16 },
        pasted,
        sender?.label ?? '',
      )
    : undefined;
  const verb = paste ? 'Replace' : hasSecret ? 'Rotate' : 'Create';
  const older = prevUntil && prevUntil > Date.now() ? prevUntil : null;
  const rotate = useRotateSecret(async (hours) => {
    if (paste && pasteError) throw new Error(pasteError);
    const next = paste ? pasted.trim() : generateSecret();
    await onRotate(next, hours * 3600);
    setPasted('');
    setTurns((n) => n + 1);
    toast.success(hasSecret ? 'Secret replaced' : 'Secret created');
    if (paste) {
      setAsking(false);
      return {};
    }
    return { secret: next };
  });
  const close = () => {
    setAsking(false);
    rotate.reset();
  };
  return (
    <Card>
      <CardHeader
        title="Webhook"
        actions={
          awaiting ? (
            <Link
              to="/admin/connections/$connectionId/setup"
              params={{ connectionId }}
              className="inline-flex min-h-8 items-center rounded-sm text-sm font-medium text-fg-strong underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:min-h-11"
            >
              Setup
            </Link>
          ) : undefined
        }
      />
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
            onDone={() => {
              dropSecret(connectionId);
              setSecret(undefined);
            }}
          />
        ) : null}
      </CardBody>
      {canManage ? (
        <Dialog open={asking} onOpenChange={(open) => (open ? setAsking(true) : close())}>
          <DialogContent
            title={rotate.secret ? 'New signing secret' : `${verb} the signing secret`}
            closeButton={!rotate.secret}
            size="md"
            footer={
              rotate.secret ? undefined : (
                <>
                  <Button variant="outline" onClick={close}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    form={rotate.formId}
                    loading={rotate.busy}
                    disabled={paste && Boolean(pasteError)}
                  >
                    {verb}
                  </Button>
                </>
              )
            }
          >
            <RotateSecretForm
              state={rotate}
              onDone={close}
              choices={INBOUND_CHOICES}
              extra={
                paste ? (
                  <SigningSecretField
                    value={pasted}
                    onChange={setPasted}
                    error={pasted ? pasteError : undefined}
                  />
                ) : null
              }
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}
