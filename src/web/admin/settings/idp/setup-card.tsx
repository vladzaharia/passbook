import { FlaskConical, KeyRound, Play } from 'lucide-react';
import { useState } from 'react';
import { SETUP_ACTIONS, type SetupItem } from '@/shared/contracts/idp-setup.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { applySetupConfirm, rotateScimConfirm } from '@/web/lib/confirms-idp.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatTime } from '@/web/lib/format.ts';
import { isStepUp } from '@/web/lib/step-up.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DropdownMenuItem,
  ErrorState,
  ListRows,
  MoreMenu,
  SkeletonRows,
  StatusPill,
  toast,
} from '@/web/ui/index.ts';
import { isUnavailable, useSetupActions, useSetupStatus } from './setup-queries.tsx';
import { SetupRow } from './setup-rows.tsx';

type Ask = 'apply' | 'rotate' | 'rotate_preview' | null;

const isAction = (item: SetupItem) => (SETUP_ACTIONS as readonly string[]).includes(item.key);

/**
 * Set up: the 12 items and what is left. Preview is the dry run and comes first; Apply asks, and a
 * session steps up. The run shows in the page's operation panel. It does not show when Polaris ID
 * cannot be reached.
 */
export function SetupCard({
  busy,
  onStarted,
}: {
  /** An operation is on screen: the controls wait for it. */
  busy: boolean;
  onStarted: (operationId: string) => void;
}) {
  const setup = useSetupStatus();
  const { setup: start, rotate } = useSetupActions();
  const [ask, setAsk] = useState<Ask>(null);
  if (isUnavailable(setup.error)) return null;
  const items = setup.data?.items ?? [];
  if (items.some((i) => i.key === 'binding' && i.reason === 'binding_unreachable')) return null;

  const done = items.filter((i) => i.status === 'done').length;
  const todo = items.some((i) => i.status === 'needed' && isAction(i));
  const blocked = items.some((i) => i.status === 'blocked');
  const connected = items.find((i) => i.key === 'scim_provider')?.status === 'done';
  const frozen = items.find((i) => i.key === 'binding')?.reason === 'frozen';
  const off = busy || frozen;

  // A step-up answer opens the kit's dialog; the person clicks again once signed in.
  const run = (go: () => Promise<{ id: string }>) => async () => {
    try {
      onStarted((await go()).id);
    } catch (cause) {
      if (!isStepUp(cause)) throw cause;
    }
  };
  async function preview() {
    try {
      await run(() => start.mutateAsync({ dryRun: true }))();
    } catch (cause) {
      toast.error(errorMessage(cause), 'Could not preview');
    }
  }
  const applyCopy = applySetupConfirm();
  const rotateCopy = rotateScimConfirm();
  const left = items.length - done;

  return (
    <Card>
      <CardHeader
        title="Set up"
        actions={
          <>
            {items.length > 0 ? (
              <StatusPill status="setup_progress" tone={left === 0 ? 'success' : 'info'}>
                {left === 0 ? 'Set up' : `${done} of ${items.length}`}
              </StatusPill>
            ) : null}
            <MoreMenu>
              <DropdownMenuItem
                disabled={off || !connected}
                onSelect={() => setAsk('rotate_preview')}
              >
                <FlaskConical aria-hidden />
                Preview token rotation
              </DropdownMenuItem>
              <DropdownMenuItem disabled={off || !connected} onSelect={() => setAsk('rotate')}>
                <KeyRound aria-hidden />
                Rotate SCIM token
              </DropdownMenuItem>
            </MoreMenu>
          </>
        }
      />
      <CardBody className="flex flex-col gap-4">
        {setup.isPending ? (
          <SkeletonRows label="Loading set up" />
        ) : setup.isError ? (
          <ErrorState inline subject="set up" error={setup.error} onRetry={() => setup.refetch()} />
        ) : (
          <>
            <ListRows label="Set up" className="wl-stagger">
              {items.map((item, n) => (
                <SetupRow key={item.key} item={item} n={n} />
              ))}
            </ListRows>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                iconStart={<FlaskConical aria-hidden />}
                disabled={off}
                loading={start.isPending && start.variables?.dryRun !== false}
                onClick={() => void preview()}
              >
                Preview
              </Button>
              <Button
                variant="outline"
                iconStart={<Play aria-hidden />}
                disabled={off || !todo || blocked}
                onClick={() => setAsk('apply')}
              >
                Apply
              </Button>
              <span className="ml-auto text-xs text-fg-muted">
                Read {formatTime(setup.dataUpdatedAt, DEFAULT_TIME_ZONE)}
              </span>
            </div>
          </>
        )}
      </CardBody>
      <ConfirmDialog
        open={ask === 'apply'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={applyCopy.title}
        description={applyCopy.description}
        confirmLabel={applyCopy.confirmLabel}
        onConfirm={run(() => start.mutateAsync({ dryRun: false }))}
      />
      <ConfirmDialog
        open={ask === 'rotate'}
        onOpenChange={(o) => !o && setAsk(null)}
        title={rotateCopy.title}
        description={rotateCopy.description}
        confirmLabel={rotateCopy.confirmLabel}
        onConfirm={run(() => rotate.mutateAsync(false))}
      />
      <ConfirmDialog
        open={ask === 'rotate_preview'}
        onOpenChange={(o) => !o && setAsk(null)}
        title="Preview the rotation?"
        description="Shows the steps and changes nothing."
        confirmLabel="Preview"
        onConfirm={run(() => rotate.mutateAsync(true))}
      />
    </Card>
  );
}
