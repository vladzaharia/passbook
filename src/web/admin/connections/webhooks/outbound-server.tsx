import type { z } from 'zod';
import type { SetupGuideSchema } from '@/shared/contracts/connection-setup.ts';
import { pluralize } from '../../../lib/format.ts';
import { Callout } from '../../../ui/callout.tsx';
import { CheckboxField } from '../../../ui/checkbox.tsx';
import { CopyField } from '../../../ui/secret-reveal.tsx';
import { CopyRow, SetupSteps, TwoSided } from '../../../ui/webhook-setup/index.ts';
import { VerifyGuide } from '../../../ui/webhook-setup/verify-guide.tsx';

type Guide = z.infer<typeof SetupGuideSchema>;

/** The secret PassBook made at Create: shown once, and Next waits for the copy. */
export function OutboundSecretStep({
  secret,
  saved,
  onSaved,
}: {
  secret: string;
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  return (
    <div className="flex max-w-xl min-w-0 flex-col gap-4">
      <Callout tone="warning">Copy the secret now. It is not shown again.</Callout>
      <CopyField label="Signing secret" value={secret} copyLabel="Copy signing secret" />
      <CheckboxField
        label="I saved the secret"
        checked={saved}
        onCheckedChange={(v) => onSaved(v === true)}
        className="w-fit"
      />
    </div>
  );
}

/** What PassBook sends and signs with: the facts your server needs, beside the guide. */
function PassbookSide({ host, events }: { host: string; events: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-fg">
        Sends <span className="font-medium">{pluralize(events, 'event')}</span> to{' '}
        <span className="font-mono text-xs break-all">{host}</span>
      </p>
      <CopyRow label="Signature header" value="x-passbook-signature" />
      <CopyRow label="Timestamp header" value="x-passbook-timestamp" />
      <p className="text-sm text-fg-muted">Secret copied.</p>
    </div>
  );
}

/** Your server's side: the guide's steps, the code to verify a request, and PassBook's side beside it. */
export function OutboundVerifyStep({
  guide,
  secret,
  endpointId,
  url,
  host,
  events,
}: {
  guide: Guide | undefined;
  secret: string;
  endpointId: string;
  url: string;
  host: string;
  events: number;
}) {
  const steps = guide?.steps ?? [];
  return (
    <TwoSided
      guideLabel="On your server"
      guide={
        <div className="flex min-w-0 flex-col gap-6">
          {steps.length > 0 ? (
            <SetupSteps
              steps={steps}
              values={{ secret }}
              storageKey={`wallet-outbound-setup:${endpointId}`}
            />
          ) : null}
          <VerifyGuide url={url} />
        </div>
      }
      panel={<PassbookSide host={host} events={events} />}
      strip={
        <p className="truncate text-sm text-fg">{`${host} · ${pluralize(events, 'event')}`}</p>
      }
    />
  );
}
