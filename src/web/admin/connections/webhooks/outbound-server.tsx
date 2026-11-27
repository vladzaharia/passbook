import type { z } from 'zod';
import type { SetupGuideSchema } from '@/shared/contracts/connection-setup.ts';
import { pluralize } from '../../../lib/format.ts';
import {
  CopyRow,
  HeldSecret,
  type RotateSecretState,
  type SendResult,
  SetupFinish,
  SetupSteps,
  TwoSided,
} from '../../../ui/webhook-setup/index.ts';
import { VerifyGuide } from '../../../ui/webhook-setup/verify-guide.tsx';

type Guide = z.infer<typeof SetupGuideSchema>;

/** PassBook's side: where it sends, what, and whether the secret was kept. */
function PassbookSide({
  url,
  events,
  copied,
}: {
  url: string;
  events: number;
  copied: boolean | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <CopyRow label="Endpoint URL" value={url} />
      <p className="text-sm text-fg">Sends {pluralize(events, 'event')}</p>
      {copied === undefined ? null : (
        <p className="text-sm text-fg-muted">{copied ? 'Secret copied' : 'Secret not copied'}</p>
      )}
    </div>
  );
}

/**
 * Your server's side: the guide's steps (the headers and rules once, in the guide), the code that
 * checks a request, and PassBook's side beside it. Resumed without the secret, step 1 offers a new one.
 */
export function OutboundVerifyStep({
  guide,
  endpointId,
  url,
  events,
  copied,
  rotate,
  onRotated,
}: {
  guide: Guide | undefined;
  endpointId: string;
  url: string;
  events: number;
  /** Whether the secret was copied in this session; unknown on resume. */
  copied: boolean | undefined;
  /** Resumed: no secret is held, so a new one comes from the rotation. */
  rotate: RotateSecretState | undefined;
  onRotated: () => void;
}) {
  const steps = guide?.steps ?? [];
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  return (
    <TwoSided
      guideLabel="On your server"
      guide={
        <div className="flex min-w-0 flex-col gap-6">
          {rotate ? (
            <section aria-label="Secret" className="flex flex-col gap-3">
              <h3 className="text-sm font-medium text-fg-strong">Secret</h3>
              <HeldSecret
                held={undefined}
                saved={false}
                onSaved={() => undefined}
                rotate={rotate}
                onRotated={onRotated}
              />
            </section>
          ) : null}
          {steps.length > 0 ? (
            <SetupSteps
              steps={steps}
              values={{}}
              storageKey={`wallet-outbound-setup:${endpointId}`}
            />
          ) : null}
          <section aria-label="Verify in code" className="flex flex-col gap-3">
            <h3 className="text-sm font-medium text-fg-strong">Verify in code</h3>
            <VerifyGuide url={url} rules={steps.length === 0} />
          </section>
        </div>
      }
      panel={<PassbookSide url={url} events={events} copied={copied} />}
      strip={
        <p className="truncate text-sm text-fg">{`${host} · ${pluralize(events, 'event')}`}</p>
      }
    />
  );
}

/** Done: the test passed, so say what was proven. */
export function OutboundFinish({
  host,
  result,
  events,
  onOpen,
  onAnother,
}: {
  host: string;
  result: SendResult;
  events: number;
  onOpen: () => void;
  onAnother: () => void;
}) {
  return (
    <SetupFinish
      title={`${host} is set up`}
      facts={[
        `Delivered · ${result.status ?? 200} in ${result.durationMs} ms`,
        `Sends ${pluralize(events, 'event')}`,
      ]}
      openLabel="Open endpoint"
      onOpen={onOpen}
      onAnother={onAnother}
      anotherLabel="Add another"
    />
  );
}
