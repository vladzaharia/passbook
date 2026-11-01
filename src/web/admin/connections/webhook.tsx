import { Card, CardBody, CardHeader, CodeBlock, CopyButton, KeyValue } from '../../ui/index.ts';

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
  secret,
}: {
  url: string | null;
  hasSecret: boolean;
  secret?: string;
}) {
  return (
    <Card className="max-w-3xl">
      <CardHeader title="Webhook" />
      <CardBody className="grid gap-4">
        <KeyValue
          items={[
            {
              label: 'URL',
              value: url ? (
                <span className="flex items-start gap-1">
                  <span className="min-w-0 break-all font-mono text-xs">{url}</span>
                  <CopyButton value={url} label="Copy webhook URL" className="-mt-1.5 shrink-0" />
                </span>
              ) : null,
            },
            { label: 'Secret', value: hasSecret ? 'Set' : 'Not set' },
          ]}
        />
        {secret ? <SecretOnce url={null} secret={secret} /> : null}
      </CardBody>
    </Card>
  );
}
