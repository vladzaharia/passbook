import { Send } from 'lucide-react';
import { useMemo } from 'react';
import { PHONE, useMediaQuery } from '../../../lib/media.ts';
import { useSession } from '../../../lib/session.ts';
import {
  Badge,
  Buddy,
  Button,
  Sheet,
  SheetContent,
  Skeleton,
  StepList,
} from '../../../ui/index.ts';
import { useTemplate } from '../api.ts';
import { nextAction } from './next-action.ts';
import { useOnPhone, useTryFlow } from './try-flow.ts';
import { Stage } from './try-stage.tsx';

/**
 * Try on my phone: a drawer (a bottom sheet on a phone) that releases the version to Test, makes a
 * Test pass from the sample, shows the QR (or Add to Apple Wallet) and waits for the phone to
 * register. Release sits in the footer; it is never blocked, it only leads once the phone is on.
 */
export default function TrySheet({
  templateId,
  orgId,
  version,
  name,
  onClose,
  onRelease,
}: {
  templateId: string;
  orgId: string;
  version: string;
  name: (hash: string | null) => string;
  onClose: () => void;
  onRelease: (version: string) => void;
}) {
  const detail = useTemplate(templateId, orgId);
  const user = useSession().authed?.user;
  const phone = useMediaQuery(PHONE);
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        title="Try on my phone"
        side={phone ? 'bottom' : 'right'}
        header={
          <span className="flex items-center gap-2">
            <span className="text-base font-semibold text-fg-strong">Try on my phone</span>
            <Badge tone="warning">Test</Badge>
          </span>
        }
        className="sm:w-[26rem]"
      >
        {detail.data ? (
          <Body
            templateId={templateId}
            orgId={orgId}
            version={version}
            label={name(version)}
            sample={detail.data.sample}
            email={user?.primaryEmail ?? null}
            holder={user?.name ?? user?.primaryEmail ?? undefined}
            onClose={onClose}
            onRelease={onRelease}
          />
        ) : (
          <div aria-busy className="p-4">
            <Skeleton className="h-32" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Body({
  templateId,
  orgId,
  version,
  label,
  sample,
  email,
  holder,
  onClose,
  onRelease,
}: {
  templateId: string;
  orgId: string;
  version: string;
  label: string;
  sample: Record<string, unknown>;
  email: string | null;
  holder: string | undefined;
  onClose: () => void;
  onRelease: (version: string) => void;
}) {
  const input = useMemo(
    () => ({ templateId, orgId, version, sample, email }),
    [templateId, orgId, version, sample, email],
  );
  const { phase, retry, attempt } = useTryFlow(input);
  const watch = useOnPhone(phase.step === 'waiting' ? phase.pass.id : undefined);
  const made = phase.step === 'waiting';
  const released = phase.step === 'making' || made;
  const release = made ? nextAction(phase.result.state.next, label) : null;
  // One live region for the whole sheet: it exists before its text changes, so it is announced.
  const said =
    phase.step === 'releasing'
      ? `Releasing ${label} to Test`
      : phase.step === 'making'
        ? 'Making your pass'
        : phase.step === 'failed'
          ? phase.message
          : watch.on
            ? 'On your phone'
            : watch.gaveUp
              ? 'Not on your phone yet'
              : 'Waiting for your phone';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p role="status" className="sr-only">
        {said}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <StepList
          label="Progress"
          items={[
            {
              id: 'release',
              label: `Release ${label} to Test`,
              state:
                phase.step === 'failed' && phase.at === 'releasing'
                  ? 'failed'
                  : released || phase.step === 'failed'
                    ? 'done'
                    : 'working',
            },
            ...(released || (phase.step === 'failed' && phase.at === 'making')
              ? [
                  {
                    id: 'make',
                    label: 'Make your pass',
                    state: made
                      ? ('done' as const)
                      : phase.step === 'failed'
                        ? ('failed' as const)
                        : ('working' as const),
                    detail: made ? holder : undefined,
                  },
                ]
              : []),
          ]}
        />
        <div className="relative mt-16">
          <div aria-hidden>
            <Buddy
              key={watch.on ? 'on' : phase.step === 'failed' ? 'failed' : 'wait'}
              mood={watch.on ? 'happy' : phase.step === 'failed' ? 'sad' : 'curious'}
              scene={watch.on ? 'cheer' : phase.step === 'failed' ? 'plug' : 'tuck'}
              replay={attempt}
              size="sm"
            />
          </div>
          <div className="rounded-lg border border-border bg-surface-raised px-4 pt-8 pb-4">
            <Stage phase={phase} watch={watch} onRetry={retry} />
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-4">
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
        {release ? (
          <Button
            variant={watch.on ? 'primary' : 'outline'}
            iconStart={<Send aria-hidden />}
            onClick={() => {
              onClose();
              onRelease(version);
            }}
          >
            {release.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
