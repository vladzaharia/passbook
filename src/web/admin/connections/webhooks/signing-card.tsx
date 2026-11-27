import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { Button, Card, CardBody, CardHeader, KeyValue, useNow } from '../../../ui/index.ts';
import { VerifyGuide } from '../../../ui/webhook-setup/index.ts';

/**
 * Signing: when the secret was made and whether an old one still signs. The secret itself is
 * shown once, on add and on rotate, and never again.
 */
export function SigningCard({
  endpoint: e,
  canManage,
  onRotate,
}: {
  endpoint: WebhookEndpointDto;
  canManage: boolean;
  onRotate: () => void;
}) {
  const now = useNow();
  const overlap = e.previousSecretExpiresAt !== null && e.previousSecretExpiresAt > now;
  return (
    <Card>
      <CardHeader title="Signing" />
      <CardBody className="flex flex-col gap-4">
        <KeyValue
          items={[
            { label: 'Secret set', value: formatDateTime(e.secretCreatedAt, '—') },
            ...(overlap
              ? [
                  {
                    label: 'Old secret signs until',
                    value: formatDateTime(e.previousSecretExpiresAt),
                  },
                ]
              : []),
          ]}
        />
        {canManage ? (
          <Button
            variant="outline"
            className="self-start"
            iconStart={<ACTION_ICON.rotate aria-hidden />}
            onClick={onRotate}
          >
            Rotate secret
          </Button>
        ) : null}
        <section aria-label="Verify requests" className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-fg-strong">Verify requests</h3>
          <VerifyGuide />
        </section>
      </CardBody>
    </Card>
  );
}
