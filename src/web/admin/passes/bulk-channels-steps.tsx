import { isDigital } from '@/shared/channels.ts';
import { CHANNELS, type Channel } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY, CHANNEL_LABEL } from '@/shared/copy/channels.ts';
import { CheckboxField, SegmentedControl } from '../../ui/index.ts';

export type BulkAction = 'on' | 'off' | 'reset';
export type BulkStepId = 'channels' | 'holders' | 'review';

export const BULK_STEPS = [
  { id: 'channels', title: 'Channels', heading: 'Pick the channels' },
  { id: 'holders', title: 'Holders', heading: 'Tell holders' },
  { id: 'review', title: 'Review', heading: 'Check the change' },
] as const;

export const BULK_HINTS: Partial<Record<BulkStepId, string>> = { channels: 'Pick a channel.' };
export const BULK_FIELD_STEP: Record<string, BulkStepId> = {
  channels: 'channels',
  notify: 'holders',
};

const ACTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
  { value: 'reset', label: CHANNEL_COPY.useTemplate },
] as const;

/** New codes only follow turning a digital channel off. */
export const canReplaceCodes = (action: BulkAction, picked: readonly Channel[]) =>
  action === 'off' && picked.some(isDigital);

export const ACTION_WORD: Record<BulkAction, string> = {
  on: 'On',
  off: 'Off',
  reset: CHANNEL_COPY.useTemplate,
};

export function StepChannels({
  action,
  onAction,
  picked,
  onToggle,
  replace,
  onReplace,
  error,
}: {
  action: BulkAction;
  onAction: (a: BulkAction) => void;
  picked: readonly Channel[];
  onToggle: (c: Channel, on: boolean) => void;
  replace: boolean;
  onReplace: (on: boolean) => void;
  error: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl label="Change" options={ACTIONS} value={action} onValueChange={onAction} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium text-fg-strong">Channels</legend>
        {CHANNELS.map((c, i) => (
          <CheckboxField
            key={c}
            label={CHANNEL_LABEL[c]}
            checked={picked.includes(c)}
            onCheckedChange={(v) => onToggle(c, v === true)}
            data-autofocus={i === 0 ? true : undefined}
            aria-invalid={error ? true : undefined}
          />
        ))}
        {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      </fieldset>
      {canReplaceCodes(action, picked) ? (
        <div className="flex flex-col gap-1">
          <CheckboxField
            label={CHANNEL_COPY.replaceBox}
            checked={replace}
            onCheckedChange={(v) => onReplace(v === true)}
          />
          {replace ? <p className="text-xs text-fg-muted">{CHANNEL_COPY.bulkReplaced}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function StepHolders({
  notify,
  onNotify,
}: {
  notify: boolean;
  onNotify: (on: boolean) => void;
}) {
  return (
    <CheckboxField
      label={CHANNEL_COPY.bulkNotify}
      checked={notify}
      onCheckedChange={(v) => onNotify(v === true)}
      data-autofocus
    />
  );
}
