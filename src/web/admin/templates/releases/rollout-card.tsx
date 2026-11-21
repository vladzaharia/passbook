import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { formatCount } from '../../../lib/format.ts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogContent,
  ErrorState,
  ListRow,
  ListRows,
  ProgressBar,
  Skeleton,
  toast,
} from '../../../ui/index.ts';
import { useRollout, useTellHolders } from './rollout-api.ts';
import { type ReleaseVersion, versionLabel } from './types.ts';

function TellHolders({
  templateId,
  orgId,
  mode,
  count,
  onClose,
}: {
  templateId: string;
  orgId: string;
  mode: Mode;
  count: number;
  onClose: () => void;
}) {
  const tell = useTellHolders(templateId, orgId, mode);
  const [key] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const formId = useId();
  async function submit() {
    setError(undefined);
    try {
      await tell.mutateAsync(key);
      toast.success('Holders will be told as their passes update');
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !tell.isPending && onClose()}>
      <DialogContent
        title="Tell holders"
        footer={
          <>
            <Button variant="outline" disabled={tell.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={tell.isPending}>
              Tell {formatCount(count)} {count === 1 ? 'holder' : 'holders'}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="grid gap-3 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p>
            Holders get the template's change message on their lock screen as each pass updates.
            Passes already updated stay quiet.
          </p>
          {error ? <Callout tone="danger">{error}</Callout> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Where the approved release stands for this organization's passes: progress, who is left, Tell holders. */
export function RolloutCard({
  templateId,
  orgId,
  mode,
  versions,
  canTell,
}: {
  templateId: string;
  orgId: string;
  mode: Mode;
  versions: readonly ReleaseVersion[];
  canTell: boolean;
}) {
  const rollout = useRollout(templateId, orgId, mode);
  const [telling, setTelling] = useState(false);
  const [listed, setListed] = useState(false);
  if (rollout.isError)
    return (
      <ErrorState
        inline
        subject="the rollout"
        error={rollout.error}
        onRetry={() => rollout.refetch()}
      />
    );
  if (!rollout.data)
    return (
      <div role="status" aria-busy>
        <span className="sr-only">Loading rollout</span>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  const r = rollout.data;
  if (!r.releaseVersion || r.total === 0) return null;
  const name = versionLabel(versions, r.releaseVersion);
  const updating = Math.max(0, r.remaining - r.failedCount);
  const done = r.remaining === 0;
  return (
    <Card>
      <CardHeader
        title={done ? `All passes are on ${name}` : `Updating passes to ${name}`}
        actions={
          canTell && updating > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setTelling(true)}>
              Tell holders
            </Button>
          ) : undefined
        }
      />
      <CardBody>
        <div className="grid gap-3">
          <p className="text-sm text-fg-muted">
            <b className="text-fg-strong">{formatCount(r.onRelease)}</b> of {formatCount(r.total)}
          </p>
          <ProgressBar
            label="Passes on the release"
            value={r.onRelease}
            max={r.total}
            valueText={`${r.onRelease} of ${r.total} passes`}
            tone={r.failedCount > 0 ? 'warning' : done ? 'success' : 'accent'}
          />
          <div className="flex flex-wrap gap-2">
            <Badge tone="success">
              {name} {formatCount(r.onRelease)}
            </Badge>
            {updating > 0 ? <Badge tone="neutral">Updating {formatCount(updating)}</Badge> : null}
            {r.failedCount > 0 ? (
              <Badge tone="warning">Can't update {formatCount(r.failedCount)}</Badge>
            ) : null}
          </div>
          {r.failedCount > 0 ? (
            <div className="grid gap-2">
              <Button
                size="sm"
                variant="outline"
                className="justify-self-start"
                aria-expanded={listed}
                onClick={() => setListed(!listed)}
              >
                {listed ? 'Hide' : 'Show'} {formatCount(r.failedCount)} that can't update
              </Button>
              {listed ? (
                <ListRows label="Passes that can't update">
                  {r.failed.map((p) => (
                    <ListRow
                      key={p.passId}
                      title={p.title ?? 'Untitled pass'}
                      meta={p.reason}
                      trailing={
                        <Button size="sm" variant="outline" asChild>
                          <Link to="/admin/passes/$passId" params={{ passId: p.passId }}>
                            Open
                          </Link>
                        </Button>
                      }
                    />
                  ))}
                </ListRows>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardBody>
      {telling ? (
        <TellHolders
          templateId={templateId}
          orgId={orgId}
          mode={mode}
          count={updating}
          onClose={() => setTelling(false)}
        />
      ) : null}
    </Card>
  );
}
