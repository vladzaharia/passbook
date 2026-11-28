import { Lock } from 'lucide-react';
import { useState } from 'react';
import { JOIN_LIMIT_MAX, JOIN_TEST_LIMIT_MAX, type JoinLinkDto } from '@/shared/contracts/join.ts';
import { JOIN_COPY } from '@/shared/copy/join.ts';
import { errorMessage, isApiError } from '../../../lib/errors.ts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DependentSettings,
  Label,
  NumberField,
  Select,
  Skeleton,
  SwitchRow,
  toast,
} from '../../../ui/index.ts';
import { type JoinScope, useJoinLink, useJoinLinkActions } from './api.ts';
import { JoinNeedsCode, JoinReadiness } from './join-readiness.tsx';
import { JoinShare } from './join-share.tsx';
import './join.css';

export interface JoinCardProps extends JoinScope {
  /** The org to open the print sign and the designer under (the console's org). */
  scopeOrgId: string | undefined;
  /** passes:operate: sees the link and turns it off. Without it the card is state only. */
  canOperate: boolean;
  /** templates:publish: turns it on, changes what it asks, raises the limit and makes a new link. */
  canPublish: boolean;
}

/** The public join link of a template, on its overview: on or off, what it asks, the limit, the link and its QR. */
export function JoinCard(props: JoinCardProps) {
  const { canOperate, canPublish, mode } = props;
  const state = useJoinLink(props);
  const { update, rotate } = useJoinLinkActions(props);
  const [confirming, setConfirming] = useState(false);
  if (state.isPending) return <JoinSkeleton />;
  // A template the viewer cannot read links for has no card, not an error.
  if (state.isError)
    return isApiError(state.error) && (state.error.isNotFound || state.error.isForbidden) ? null : (
      <Card>
        <CardHeader title={JOIN_COPY.card.title} />
        <CardBody>
          <p role="alert" className="text-sm text-danger">
            {errorMessage(state.error)}
          </p>
        </CardBody>
      </Card>
    );
  const { link, ready, issues } = state.data;
  const enabled = link?.enabled ?? false;
  const revision = link?.revision ?? 0;
  const test = mode === 'test';
  const limitMax = test ? JOIN_TEST_LIMIT_MAX : JOIN_LIMIT_MAX;

  async function save(body: Parameters<typeof update.mutateAsync>[0], done?: string) {
    try {
      await update.mutateAsync(body);
      if (done) toast.success(done);
    } catch (cause) {
      if (isApiError(cause) && cause.code === 'JOIN_LINK_CHANGED')
        toast.error(JOIN_COPY.errors.JOIN_LINK_CHANGED, 'Could not change the link');
      else toast.error(cause, 'Could not change the link');
    }
  }
  const toggle = (next: boolean) =>
    save({ enabled: next, revision }, next ? JOIN_COPY.toast.on : JOIN_COPY.toast.off);
  // Turning on needs a ready template and the publish grant; turning off, only operate.
  const unsupported = issues.some((i) => i.code === 'barcode_input');
  const switchOff = !canOperate || update.isPending || (!enabled && (!ready || !canPublish));

  return (
    <Card>
      <CardHeader
        title={JOIN_COPY.card.title}
        actions={
          link?.limitReached ? <Badge tone="warning">{JOIN_COPY.card.limitReached}</Badge> : null
        }
      />
      <CardBody className="flex flex-col gap-4">
        <SwitchRow
          label={JOIN_COPY.card.open}
          checked={enabled}
          disabled={switchOff}
          onCheckedChange={toggle}
        />
        {canOperate && !canPublish && !enabled ? (
          <p className="-mt-2 text-xs text-fg-muted">{JOIN_COPY.card.askAdmin}</p>
        ) : null}
        {!ready && !unsupported ? (
          <JoinReadiness
            issues={issues}
            mode={test ? 'Test' : 'Live'}
            templateId={props.templateId}
            orgId={props.scopeOrgId}
          />
        ) : null}
        <DependentSettings
          open={enabled}
          unsupported={
            unsupported ? (
              <JoinNeedsCode templateId={props.templateId} orgId={props.scopeOrgId} />
            ) : undefined
          }
        >
          <hr className="border-border" />
          <fieldset className="flex min-w-0 flex-col gap-3 border-0 p-0">
            <legend className="mb-1 p-0 text-sm font-medium text-fg-muted">
              {JOIN_COPY.card.askFor}
            </legend>
            <NameRow
              link={link}
              disabled={!canOperate || !canPublish || update.isPending}
              save={save}
              revision={revision}
            />
            <SwitchRow
              label={JOIN_COPY.card.email}
              checked={link?.askEmail ?? false}
              disabled={!canOperate || !canPublish || update.isPending}
              onCheckedChange={(askEmail) => save({ askEmail, revision })}
            />
          </fieldset>
          <hr className="border-border" />
          <LimitRow
            link={link}
            max={limitMax}
            disabled={!canOperate || update.isPending}
            canRaise={canPublish}
            save={(dailyLimit) => save({ dailyLimit, revision })}
          />
          {link?.url && canOperate ? (
            <JoinShare
              url={link.url}
              open={enabled}
              templateId={props.templateId}
              orgId={props.scopeOrgId}
              canRotate={canPublish}
              onRotate={() => setConfirming(true)}
            />
          ) : null}
        </DependentSettings>
      </CardBody>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={JOIN_COPY.rotateConfirm.title}
        description={JOIN_COPY.rotateConfirm.body}
        confirmLabel={JOIN_COPY.rotateConfirm.confirm}
        onConfirm={async () => {
          await rotate.mutateAsync();
          toast.success(JOIN_COPY.toast.rotated);
        }}
      />
    </Card>
  );
}

function JoinSkeleton() {
  return (
    <Card aria-busy="true">
      <CardHeader title={JOIN_COPY.card.title} />
      <CardBody className="flex flex-col gap-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-9 w-28" />
      </CardBody>
    </Card>
  );
}

type Save = (body: { nameInput?: string | null; revision: number }) => Promise<void>;

/** Name is always asked. Several inputs can hold it: the admin chooses which one it fills. */
function NameRow({
  link,
  disabled,
  save,
  revision,
}: {
  link: JoinLinkDto | null;
  disabled: boolean;
  save: Save;
  revision: number;
}) {
  const options = (link?.nameInputs ?? []).map((i) => ({
    value: i.key,
    label: JOIN_COPY.card.fills.replace('{label}', i.label),
  }));
  return (
    <div className="flex min-h-9 items-center justify-between gap-4">
      <span className="text-sm font-medium text-fg-strong">{JOIN_COPY.card.name}</span>
      {options.length > 1 ? (
        <Select
          aria-label={JOIN_COPY.card.name}
          className="max-w-56"
          options={options}
          value={link?.nameInput ?? undefined}
          disabled={disabled}
          onValueChange={(nameInput) => save({ nameInput, revision })}
        />
      ) : (
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Lock aria-hidden className="size-3.5" />
          Required
        </span>
      )}
    </div>
  );
}

/** Commits on blur or Enter. Lowering needs operate; raising needs publish and says so. */
function LimitRow({
  link,
  max,
  disabled,
  canRaise,
  save,
}: {
  link: JoinLinkDto | null;
  max: number;
  disabled: boolean;
  canRaise: boolean;
  save: (limit: number) => Promise<void>;
}) {
  const current = link?.dailyLimit ?? null;
  // undefined: not editing; null: the box was cleared.
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const shown = draft === undefined ? current : draft;
  const [error, setError] = useState<string>();
  async function commit() {
    const next = draft;
    setDraft(undefined);
    if (next === undefined || next === current || current === null) return;
    if (next === null) return setError(`1 to ${max}.`);
    if (!Number.isInteger(next) || next < 1 || next > max) return setError(`1 to ${max}.`);
    if (next > current && !canRaise) return setError(JOIN_COPY.card.askAdmin);
    setError(undefined);
    await save(next);
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="join-limit">{JOIN_COPY.card.dailyLimit}</Label>
      <div className="flex flex-wrap items-center gap-3">
        <NumberField
          id="join-limit"
          value={shown}
          placeholder={current === null ? 'No limit' : undefined}
          disabled={disabled || current === null}
          onValueChange={setDraft}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          min={1}
          max={max}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'join-limit-help' : undefined}
        />
        {link ? (
          <span className="text-sm text-fg-muted tabular-nums">
            {JOIN_COPY.card.today.replace('{n}', String(link.issuedToday))}
          </span>
        ) : null}
      </div>
      {error ? (
        <p id="join-limit-help" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
