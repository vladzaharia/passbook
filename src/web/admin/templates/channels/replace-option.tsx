import type { ChannelWindow } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { Callout, CheckboxField } from '../../../ui/index.ts';

/** An open scheduled event or session refuses a code change; the server says the same on save. */
export const blockingWindow = (windows: readonly ChannelWindow[]): ChannelWindow | undefined =>
  windows.find((w) => w.open && w.scheduled);

/** Why codes cannot change now, ready to show; undefined when nothing is open. */
export function windowRefusal(windows: readonly ChannelWindow[]): string | undefined {
  const w = blockingWindow(windows);
  if (!w) return undefined;
  return w.closesAt
    ? CHANNEL_COPY.replaceWindowOpen
        .replace('{name}', w.name)
        .replace('{time}', formatDateTime(w.closesAt))
    : CHANNEL_COPY.replaceWindowOpenNoEnd.replace('{name}', w.name);
}

export function windowWarnings(windows: readonly ChannelWindow[]): string[] {
  return windows
    .filter((w) => !(w.open && w.scheduled))
    .map((w) =>
      !w.scheduled
        ? CHANNEL_COPY.replaceWindowNoHours.replace('{name}', w.name)
        : CHANNEL_COPY.replaceWindowSoon
            .replace('{name}', w.name)
            .replace('{time}', formatDateTime(w.opensAt)),
    );
}

/**
 * "Also issue new codes" under a turn-off: offered only when the barcode is the scan code and a
 * digital channel stays on. Ticked, it shows the holder effect, the refusal inside an open window
 * and the events or sessions opening within 48 hours.
 */
export function ReplaceOption({
  supported,
  allOff,
  windows,
  checked,
  onChange,
  note = true,
}: {
  supported: boolean;
  allOff: boolean;
  windows: readonly ChannelWindow[];
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** False when the caller's own summary already says what holders get. */
  note?: boolean;
}) {
  if (!supported) return <p className="text-xs text-fg-muted">{CHANNEL_COPY.replaceUnsupported}</p>;
  const refusal = checked ? windowRefusal(windows) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <CheckboxField
        label={CHANNEL_COPY.replaceBox}
        checked={checked && !allOff}
        disabled={allOff}
        onCheckedChange={(v) => onChange(v === true)}
      />
      {allOff ? <p className="text-xs text-fg-muted">{CHANNEL_COPY.replaceAllOff}</p> : null}
      {checked && !allOff ? (
        <>
          {note ? <p className="text-xs text-fg-muted">{CHANNEL_COPY.replaceNote}</p> : null}
          {refusal ? <Callout tone="danger">{refusal}</Callout> : null}
          {windowWarnings(windows).map((line) => (
            <Callout key={line} tone="warning">
              {line}
            </Callout>
          ))}
        </>
      ) : null}
    </div>
  );
}
