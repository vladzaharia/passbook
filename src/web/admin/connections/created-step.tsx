import { ChevronRight } from 'lucide-react';
import { Card, CardBody, CardHeader, CodeBlock, SecretReveal } from '../../ui/index.ts';

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
  onDone,
}: {
  url: string | null;
  secret: string;
  connectorType: string;
  onDone: () => void;
}) {
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
                    sheen: false,
                  },
                ]
              : []),
            { label: 'Signing secret', value: secret, copyLabel: 'Copy signing secret' },
          ]}
          onDone={onDone}
        >
          {url ? (
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
