import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { formatCount } from '../../../lib/format.ts';
import { useMode } from '../../../lib/mode.ts';
import type { useOrgScope } from '../../../lib/org-filter.tsx';
import { Buddy } from '../../../ui/art/index.ts';
import { Badge, Button, ErrorState, ListRow, ListRows, ProgressBar } from '../../../ui/index.ts';
import { vOf } from '../versions.ts';
import { PlanSummary } from './plan-summary.tsx';
import { useRollout } from './rollout-api.ts';
import { TellHolders } from './rollout-tell.tsx';

export type RolloutTemplate = Pick<
  z.infer<typeof TemplateDetailSchema>,
  'id' | 'name' | 'versions'
>;
export type RolloutScope = Pick<ReturnType<typeof useOrgScope>, 'orgId' | 'membership'>;

/** Where the approved release stands for this organization's passes: progress, who is left, Tell holders. */
export function RolloutCard({
  template,
  scope,
}: {
  template: RolloutTemplate;
  scope: RolloutScope;
}) {
  const mode = useMode();
  const orgId = scope.orgId;
  if (!orgId || !scope.membership) return null;
  return (
    <RolloutBody
      key={`${orgId}:${mode}`}
      template={template}
      orgId={orgId}
      mode={mode}
      canTell={scope.membership.capabilities.includes('messages:manage')}
    />
  );
}

function RolloutBody({
  template,
  orgId,
  mode,
  canTell,
}: {
  template: RolloutTemplate;
  orgId: string;
  mode: ReturnType<typeof useMode>;
  canTell: boolean;
}) {
  const rollout = useRollout(template.id, orgId, mode, true);
  const [telling, setTelling] = useState(false);
  const [listed, setListed] = useState(false);
  const [changed, setChanged] = useState(false);
  const wrap = (child: React.ReactNode) => (
    <div id="rollout" className="mb-4 border-b border-border pb-4">
      {child}
    </div>
  );
  if (rollout.isError)
    return wrap(
      <ErrorState
        inline
        subject="the rollout"
        error={rollout.error}
        onRetry={() => rollout.refetch()}
      />,
    );
  // No placeholder: most templates have no rollout, and a block that vanishes shifts the page.
  if (!rollout.data) return null;
  const r = rollout.data;
  // Done and nothing left to tell: the card has nothing more to say.
  if (!r.releaseVersion || r.total === 0 || (r.remaining === 0 && !r.tell)) return null;
  const name = (hash: string | null) => vOf(template, hash);
  const version = name(r.releaseVersion);
  const waiting = Math.max(0, r.remaining - r.failedCount);
  const done = r.remaining === 0;
  const heading = done
    ? `All passes are on ${version}`
    : waiting > 0
      ? `Updating passes to ${version}`
      : `${formatCount(r.failedCount)} ${r.failedCount === 1 ? "pass can't" : "passes can't"} move to ${version}`;
  return wrap(
    <section aria-label="Rollout" className="relative mt-11 grid gap-3">
      <Buddy size="sm" at="end" scene={done ? 'cheer' : 'wave'} mood={done ? 'happy' : 'curious'} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg-strong">{heading}</h3>
        {canTell && r.tell ? (
          <Button size="sm" variant="outline" onClick={() => setTelling(true)}>
            Tell holders
          </Button>
        ) : null}
      </div>
      <p role="status" className="text-sm text-fg-muted">
        <b className="text-fg-strong">{formatCount(r.onRelease)}</b> of {formatCount(r.total)}
      </p>
      <ProgressBar
        label="Passes on the release"
        value={r.onRelease}
        max={r.total}
        valueText={`${formatCount(r.onRelease)} of ${formatCount(r.total)} passes`}
        tone={r.failedCount > 0 ? 'warning' : done ? 'success' : 'accent'}
      />
      <div className="flex flex-wrap gap-2">
        {r.onRelease > 0 ? (
          <Badge tone="success">
            {version} · {formatCount(r.onRelease)}
          </Badge>
        ) : null}
        {r.updating.map((u) => (
          <Badge key={u.version} tone="neutral">
            {name(u.version)} · {formatCount(u.count)}
          </Badge>
        ))}
        {r.failedCount > 0 ? (
          <Badge tone="warning">Can't update · {formatCount(r.failedCount)}</Badge>
        ) : null}
      </div>
      {r.stalled ? (
        <p className="text-sm text-fg-muted">
          The rebuild did not start. These passes will not move on their own.
        </p>
      ) : null}
      {r.failed.length > 0 ? (
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
                      <Link
                        to="/admin/passes/$passId"
                        params={{ passId: p.passId }}
                        aria-label={`Open ${p.title ?? 'pass'}`}
                      >
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
      {r.changes.length > 0 && r.fromVersion ? (
        <div className="grid gap-2">
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            aria-expanded={changed}
            onClick={() => setChanged(!changed)}
          >
            What changed {name(r.fromVersion)} → {version}
          </Button>
          {changed ? (
            <PlanSummary
              plan={{ diff: r.changes, modes: {} }}
              templateId={template.id}
              orgId={orgId}
            />
          ) : null}
        </div>
      ) : null}
      {telling && r.tell && r.releaseVersion ? (
        <TellHolders
          templateId={template.id}
          templateName={template.name}
          orgId={orgId}
          mode={mode}
          version={r.releaseVersion}
          versionName={version}
          tell={r.tell}
          stillUpdating={waiting}
          onClose={() => setTelling(false)}
        />
      ) : null}
    </section>,
  );
}
