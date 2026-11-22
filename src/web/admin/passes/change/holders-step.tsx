import { zoneLabel } from '../../../lib/timezones.ts';
import {
  Callout,
  DateTimeField,
  FormField,
  SegmentedControl,
  SwitchRow,
  Textarea,
} from '../../../ui/index.ts';
import { LockScreenNotice } from '../../messages/lock-screen.tsx';
import { CHANGE_COPY as C } from './copy.ts';
import { Estimate } from './estimate.tsx';
import type { ChangeWizard } from './use-change-wizard.ts';

export const MESSAGE_MAX = 120;

/** Fills `{Label}` with the sample pass's new value, as the holder would read it. */
export function withSample(
  text: string,
  changes: readonly { label: string; to: string | null }[] | undefined,
): string {
  return text.replace(/\{([^{}]+)\}/g, (all, label: string) => {
    const hit = changes?.find((c) => c.label.toLowerCase() === label.toLowerCase());
    return hit ? (hit.to ?? '') : all;
  });
}

/** C2: tell holders (off by default), or update quietly; start now or later. */
export function HoldersStep({
  w,
  org,
  error,
}: {
  w: ChangeWizard;
  org: { id: string; name: string };
  error?: string | undefined;
}) {
  const sample = w.preview.data?.samples[0];
  const labels = [
    ...new Set(w.preview.data?.samples.flatMap((s) => s.changes.map((c) => c.label))),
  ];
  const showMessage = w.notify && w.kind === 'fields';
  return (
    <div className="flex flex-col gap-6">
      <SwitchRow
        label={C.holders.notify}
        help={C.holders.notifyHelp}
        checked={w.notify}
        onCheckedChange={w.setNotify}
      />
      {showMessage ? (
        <div className="flex flex-col gap-2">
          <FormField label={C.holders.message} error={error} help={C.holders.tokens}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                maxLength={MESSAGE_MAX}
                value={w.message}
                onChange={(e) => w.setMessage(e.target.value)}
              />
            )}
          </FormField>
          <div className="flex flex-wrap items-center gap-2">
            {labels.map((label) => (
              <button
                key={label}
                type="button"
                aria-label={C.holders.insert(label)}
                className="rounded-full border border-border bg-surface-sunken px-2.5 py-0.5 text-xs text-fg hover:border-accent"
                onClick={() => w.setMessage(`${w.message}{${label}}`.slice(0, MESSAGE_MAX))}
              >
                {`{${label}}`}
              </button>
            ))}
            <span className="ml-auto text-xs tabular-nums text-fg-muted">
              {w.message.length}/{MESSAGE_MAX}
            </span>
          </div>
        </div>
      ) : null}
      <div className="wl-rise">
        <LockScreenNotice
          org={org}
          silent={!w.notify}
          text={withSample(w.message, sample?.changes)}
        />
      </div>
      {w.notify ? (
        <Estimate preview={w.preview.data} />
      ) : (
        <p className="text-sm text-fg-muted">{C.holders.silent}</p>
      )}
      <div className="flex flex-col gap-3">
        <SegmentedControl
          label={C.holders.start}
          options={[
            { value: 'now', label: C.holders.now },
            { value: 'later', label: C.holders.later },
          ]}
          value={w.start}
          onValueChange={w.setStart}
        />
        {w.start === 'later' ? (
          <FormField label={C.holders.at} help={zoneLabel(w.at.zone)}>
            {(control) => (
              <DateTimeField
                id={control.id}
                value={w.at}
                onChange={(v) => v && w.setAt(v)}
                defaultZone={w.at.zone}
              />
            )}
          </FormField>
        ) : null}
      </div>
      {w.preview.isError ? <Callout tone="warning">{w.preview.error.message}</Callout> : null}
    </div>
  );
}
