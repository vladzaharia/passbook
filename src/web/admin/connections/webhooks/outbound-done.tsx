import { Webhook } from 'lucide-react';
import type { z } from 'zod';
import type { WebhookEndpointCreatedSchema } from '@/shared/contracts/webhooks.ts';
import { SecretReveal } from '../../../ui/secret-reveal.tsx';
import { LiveCheck, SetupSteps } from '../../../ui/webhook-setup/index.ts';
import { VerifyGuide } from '../../../ui/webhooks/verify-guide.tsx';
import { useEndpointActions, useOutboundSetup } from './api.ts';
import { endpointHost } from './health.ts';

type Created = z.infer<typeof WebhookEndpointCreatedSchema>;

/** The dialog's title and icon once the endpoint exists. */
export const OUTBOUND_DONE = {
  title: 'Set up your server',
  icon: <Webhook aria-hidden />,
} as const;

/**
 * Both sides of the setup after the endpoint is made. PassBook's side: the signing secret (shown
 * once) and a test send that reads your server's answer. Your server's side: the guide's steps,
 * rendered from the server's own data. Done waits for "I saved the secret".
 */
export function OutboundDone({
  orgId,
  created,
  onDone,
}: {
  orgId: string;
  created: Created;
  onDone: () => void;
}) {
  const guide = useOutboundSetup(orgId);
  const { test } = useEndpointActions(created.endpoint.id);
  const steps = guide.data?.steps ?? [];
  return (
    <SecretReveal
      fields={[
        { label: 'Signing secret', value: created.secret, copyLabel: 'Copy signing secret' },
      ]}
      doneLabel="Done"
      onDone={onDone}
    >
      <LiveCheck
        mode="send"
        host={endpointHost(created.endpoint)}
        canSend
        hint={guide.data?.test.text}
        send={() => test.mutateAsync()}
      />
      {steps.length > 0 ? (
        <section aria-label="On your server" className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold text-fg-strong">On your server</h4>
          <SetupSteps
            steps={steps}
            values={{ secret: created.secret }}
            storageKey={`wb-outbound-setup:${created.endpoint.id}`}
          />
        </section>
      ) : (
        <VerifyGuide />
      )}
    </SecretReveal>
  );
}
