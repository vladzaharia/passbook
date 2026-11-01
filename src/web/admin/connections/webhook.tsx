import { useState } from 'react';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CopyButton,
  KeyValue,
  SecretReveal,
  toast,
} from '../../ui/index.ts';

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
  onRotate,
}: {
  url: string | null;
  hasSecret: boolean;
  /** Saves a new secret; resolves once stored. */
  onRotate: (secret: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [turns, setTurns] = useState(0);
  return (
    <Card>
      <CardHeader title="Webhook" />
      <CardBody className="flex min-w-0 flex-col gap-4">
        <KeyValue
          items={[
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
                  <Button
                    variant="ghost"
                    size="sm"
                    done={turns || undefined}
                    iconStart={<ACTION_ICON.rotate aria-hidden />}
                    onClick={() => setAsking(true)}
                  >
                    {hasSecret ? 'Rotate' : 'Create'}
                  </Button>
                </span>
              ),
            },
          ]}
        />
        {secret ? (
          <SecretReveal
            fields={[{ label: 'Signing secret', value: secret, copyLabel: 'Copy signing secret' }]}
            onDone={() => setSecret(undefined)}
          />
        ) : null}
      </CardBody>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={hasSecret ? 'Rotate the signing secret?' : 'Create a signing secret?'}
        description={hasSecret ? 'Senders using the old secret are rejected.' : undefined}
        confirmLabel={hasSecret ? 'Rotate' : 'Create'}
        destructive={hasSecret}
        onConfirm={async () => {
          const next = generateSecret();
          await onRotate(next);
          setSecret(next);
          setTurns((n) => n + 1);
          toast.success(hasSecret ? 'Secret rotated' : 'Secret created');
        }}
      />
    </Card>
  );
}
