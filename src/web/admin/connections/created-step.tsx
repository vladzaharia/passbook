import { ChevronRight } from 'lucide-react';
import type { RecipeInfo } from '@/shared/contracts/connections.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  CopyField,
  SecretReveal,
} from '../../ui/index.ts';
import { RECIPE_COPY } from './recipe-copy.ts';

/** The default body each connector reads: records pushed whole, or refs to fetch. */
const BODY: Record<string, string> = {
  'webhook-push': '{"id":"evt-1","records":[{"ref":"m-001","record":{"name":"Maya Chen"}}]}',
};
const REFS_BODY = '{"id":"evt-1","refs":["m-001"]}';

/** A signed sample call: the signature is HMAC-SHA256 over "<timestamp>.<body>". */
export function exampleRequest(url: string, connectorType = ''): string {
  const body = BODY[connectorType] ?? REFS_BODY;
  return [
    `body='${body}'`,
    'ts=$(date +%s)',
    'sig=$(printf "%s.%s" "$ts" "$body" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" -hex | sed "s/^.* //")',
    `curl -X POST '${url}' \\`,
    "  -H 'content-type: application/json' \\",
    '  -H "x-wallet-timestamp: $ts" \\',
    '  -H "x-wallet-signature: v1=$sig" \\',
    '  -d "$body"',
  ].join('\n');
}

/** Shown once after creating a webhook connection: endpoint, secret, an example, then Done. */
export function CreatedStep({
  url,
  secret,
  connectorType,
  sender,
  onDone,
}: {
  url: string | null;
  /** None when the sender made it and it was pasted. */
  secret: string | undefined;
  connectorType: string;
  sender?: RecipeInfo | undefined;
  onDone: () => void;
}) {
  const topics = sender && sender.id !== 'custom' ? RECIPE_COPY[sender.id].topics : [];
  const setup =
    topics.length > 0 ? (
      <p className="text-sm text-fg-muted">
        Add this URL in {sender?.label.split(' ')[0]} and subscribe to: {topics.join(', ')}.
      </p>
    ) : null;
  // The sender made the secret and it was pasted: nothing secret to show once.
  if (!secret)
    return (
      <Card className="max-w-2xl">
        <CardHeader title="Connect your system" />
        <CardBody className="flex flex-col gap-4">
          {url ? (
            <CopyField
              label="Endpoint URL"
              value={url}
              copyLabel="Copy endpoint URL"
              secret={false}
              sheen={false}
            />
          ) : null}
          {setup}
          <div>
            <Button onClick={onDone}>Done</Button>
          </div>
        </CardBody>
      </Card>
    );
  return (
    <Card className="max-w-2xl">
      <CardHeader title="Connect your system" />
      <CardBody>
        <SecretReveal
          fields={[
            ...(url
              ? [
                  {
                    label: 'Endpoint URL',
                    value: url,
                    copyLabel: 'Copy endpoint URL',
                    // Not a secret: the Webhook tab shows it in full too.
                    secret: false,
                    sheen: false,
                  },
                ]
              : []),
            { label: 'Signing secret', value: secret, copyLabel: 'Copy signing secret' },
          ]}
          onDone={onDone}
        >
          {setup}
          {url && !sender ? (
            <details className="group min-w-0">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm font-medium text-fg [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-4 text-fg-muted transition-transform duration-(--wl-dur-hover) group-open:rotate-90 motion-reduce:transition-none"
                />
                Example request
              </summary>
              <CodeBlock
                code={exampleRequest(url, connectorType)}
                label="Example request"
                maxHeight="max-h-56"
                className="mt-2"
              />
            </details>
          ) : null}
        </SecretReveal>
      </CardBody>
    </Card>
  );
}
