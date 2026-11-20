import type { ChannelWindow } from '@/shared/contracts/channels.ts';
import { CHANNEL_COPY } from '@/shared/copy/channels.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { Callout, CheckboxField } from '../../../ui/index.ts';

/** Why codes cannot change now, ready to show. The server decides that a window holds them. */
export function refusalText(blocked: { name: string; closesAt: number | null }): string {
  return blocked.closesAt
    ? CHANNEL_COPY.replaceWindowOpen
        .replace('{name}', blocked.name)
        .replace('{time}', formatDateTime(blocked.closesAt))
    : CHANNEL_COPY.replaceWindowOpenNoEnd.replace('{name}', blocked.name);
}

export function windowWarnings(windows: readonly ChannelWindow[]): string[] {
  return windows.map((w) =>
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
  blocked,
  windows,
  loading = false,
  checked,
  onChange,
  note = true,
}: {
  supported: boolean;
  allOff: boolean;
  /** The server's refusal: an open event or session holds new codes. */
  blocked: { name: string; closesAt: number | null } | null;
  windows: readonly ChannelWindow[];
  /** A dry run is on its way: the box waits so a stale answer cannot land. */
  loading?: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** False when the caller's own summary already says what holders get. */
  note?: boolean;
}) {
  if (!supported) return <p className="text-xs text-fg-muted">{CHANNEL_COPY.replaceUnsupported}</p>;
  const refusal = checked && blocked ? refusalText(blocked) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <CheckboxField
        label={CHANNEL_COPY.replaceBox}
        checked={checked && !allOff}
        disabled={allOff || loading}
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
