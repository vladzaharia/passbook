import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import type { z } from 'zod';
import type { Mode } from '@/shared/contracts/common.ts';
import type { TemplateRollout } from '@/shared/contracts/template-rollout.ts';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { formatCount } from '../../../lib/format.ts';
import { useMode } from '../../../lib/mode.ts';
import type { useOrgScope } from '../../../lib/org-filter.tsx';
import { Buddy } from '../../../ui/art/index.ts';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  ErrorState,
  FormField,
  Input,
  ListRow,
  ListRows,
  ProgressBar,
  Skeleton,
  toast,
} from '../../../ui/index.ts';
import { vOf } from '../versions.ts';
import { useRollout, useTellHolders } from './rollout-api.ts';

type Tell = NonNullable<TemplateRollout['tell']>;

function TellHolders({
  templateId,
  orgId,
  mode,
  tell,
  count,
  onClose,
}: {
  templateId: string;
  orgId: string;
  mode: Mode;
  tell: Tell;
  count: number;
  onClose: () => void;
}) {
  const send = useTellHolders(templateId, orgId, mode);
  const [idem] = useState(() => crypto.randomUUID());
  const [text, setText] = useState(tell.text ?? '');
  const [error, setError] = useState<string>();
  const formId = useId();
  const message = tell.path === 'message';
  async function submit() {
    setError(undefined);
    try {
      await send.mutateAsync({ tell, text: text.trim(), idem });
      toast.success(message ? 'Message sent' : 'Holders will be told as their passes update');
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !send.isPending && onClose()}>
      <DialogContent
        title="Tell holders"
        footer={
          <>
            <Button variant="outline" disabled={send.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              loading={send.isPending}
              disabled={message && !text.trim()}
            >
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
          {message ? (
            <>
              <p>Passes have already updated. Send holders a message on their lock screen.</p>
              <FormField label="Message" required>
                {(control) => (
                  <Input
                    {...control}
                    value={text}
                    maxLength={120}
                    onChange={(event) => setText(event.target.value)}
                  />
                )}
              </FormField>
            </>
          ) : (
            <p>
              Holders get the template's change message on their lock screen as each pass updates.
              Passes already updated stay quiet.
            </p>
          )}
          {error ? <Callout tone="danger">{error}</Callout> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Where the approved release stands for this organization's passes: progress, who is left, Tell holders. */
export function RolloutCard({
  template,
  scope,
}: {
  template: Pick<z.infer<typeof TemplateDetailSchema>, 'id' | 'versions'>;
  scope: Pick<ReturnType<typeof useOrgScope>, 'orgId' | 'membership'>;
}) {
  const orgId = scope.orgId;
  const capabilities = scope.membership?.capabilities ?? [];
  const mode = useMode();
  const templateId = template.id;
  const name = (hash: string | null) => vOf(template, hash);
  const canTell =
    capabilities.includes('messages:manage') && capabilities.includes('passes:operate');
  const rollout = useRollout(templateId, orgId ?? '', mode, Boolean(orgId && scope.membership));
  const [telling, setTelling] = useState(false);
  const [listed, setListed] = useState(false);
  if (!orgId || !scope.membership) return null;
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
        <Skeleton className="h-20 w-full" />
      </div>
    );
  const r = rollout.data;
  if (!r.releaseVersion || r.total === 0) return null;
  const version = name(r.releaseVersion);
  const updating = Math.max(0, r.remaining - r.failedCount);
  const done = r.remaining === 0;
  const tellCount = r.tell?.path === 'message' ? r.onRelease : updating;
  return (
    <section aria-label="Rollout" className="relative mt-11 grid gap-3">
      <Buddy size="sm" at="end" scene={done ? 'cheer' : 'wave'} mood={done ? 'happy' : 'curious'} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">
          {done ? `All passes are on ${version}` : `Updating passes to ${version}`}
        </h3>
        {canTell && r.tell ? (
          <Button size="sm" variant="outline" onClick={() => setTelling(true)}>
            Tell holders
          </Button>
        ) : null}
      </div>
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
          {version} {formatCount(r.onRelease)}
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
      {telling && r.tell ? (
        <TellHolders
          templateId={templateId}
          orgId={orgId}
          mode={mode}
          tell={r.tell}
          count={tellCount}
          onClose={() => setTelling(false)}
        />
      ) : null}
    </section>
  );
}
