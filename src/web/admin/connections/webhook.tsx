import { useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  ConfirmDialog,
  KeyValue,
  toast,
} from '../../ui/index.ts';

/** 32 random bytes as hex. The client generates it so the server never has to echo a secret. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function SecretOnce({ url, secret }: { url: string | null; secret: string }) {
  return (
    <div
      role="status"
      className="grid gap-3 rounded-lg border border-warning-border bg-warning-subtle p-4"
    >
      <p className="text-sm font-medium text-fg-strong">
        Copy the webhook secret now. It is not shown again.
      </p>
      {url ? <CodeBlock label="Webhook URL" code={url} maxHeight="max-h-24" /> : null}
      <CodeBlock label="Webhook secret" code={secret} maxHeight="max-h-24" />
    </div>
  );
}

export function WebhookPanel({
  url,
  hasSecret,
  onRotate,
}: {
  url: string | null;
  hasSecret: boolean;
  onRotate: (secret: string) => Promise<unknown>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [secret, setSecret] = useState<string>();
  return (
    <Card className="max-w-2xl">
      <CardHeader
        title="Webhook"
        actions={
          <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
            {hasSecret ? 'Rotate secret' : 'Create secret'}
          </Button>
        }
      />
      <CardBody className="grid gap-4">
        <KeyValue
          items={[
            { label: 'URL', value: url, mono: true },
            { label: 'Secret', value: hasSecret ? 'Set' : 'Not set' },
          ]}
        />
        {secret ? <SecretOnce url={null} secret={secret} /> : null}
      </CardBody>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={hasSecret ? 'Rotate webhook secret?' : 'Create webhook secret?'}
        description={hasSecret ? 'Senders using the old secret are rejected.' : undefined}
        confirmLabel={hasSecret ? 'Rotate' : 'Create'}
        destructive={hasSecret}
        onConfirm={async () => {
          const next = generateSecret();
          await onRotate(next);
          setSecret(next);
          toast.success('Secret saved');
        }}
      />
    </Card>
  );
}
