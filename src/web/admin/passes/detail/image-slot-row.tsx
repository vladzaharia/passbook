import { type DragEvent, type ReactNode, useRef, useState } from 'react';
import { ACTION_ICON } from '../../../lib/action-icons.ts';
import { cn } from '../../../lib/cn.ts';
import { Button } from '../../../ui/index.ts';

export interface ImageSlotRowProps {
  label: string;
  /** Next to the label: "Custom". */
  badge?: ReactNode;
  /** The file on show, or null for an empty slot. */
  thumb: { url: string | null; onLoad?: (size: [number, number]) => void };
  /** The pass's or template's own color: the thumbnail sits on it, so a white logo stays visible. */
  ground?: string | undefined;
  /** What is there now: "@2x: 76 × 76 px". */
  detail?: string | undefined;
  /** What the slot takes. */
  needs: string;
  error?: string | undefined;
  warning?: string | undefined;
  /** A chosen or dropped file. */
  onFile: (file: File) => void;
  busy?: boolean;
  disabled?: boolean;
  replaceLabel: string;
  /** Remove or reset, after Replace. */
  trailing?: ReactNode;
  fresh?: boolean;
  /** data-target, for the designer's issue links. */
  target?: string;
  children?: ReactNode;
}

/** One image slot, on the pass's Images tab and in the designer: thumb, label, size, Replace, drop. */
export function ImageSlotRow(props: ImageSlotRowProps) {
  const { label, badge, thumb, ground, detail, needs, error, warning, busy, disabled } = props;
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (file: File | undefined) => {
    if (file && !busy && !disabled) props.onFile(file);
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files[0]);
  };
  return (
    <li
      data-new={props.fresh ? '' : undefined}
      data-over={over || undefined}
      data-target={props.target}
      tabIndex={props.target ? -1 : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className="wl-slot relative flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-raised p-3"
    >
      <div
        style={ground ? { background: ground } : undefined}
        className={cn(
          'wl-slot-thumb flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border',
          !ground && 'wl-checker',
        )}
      >
        {thumb.url ? (
          <img
            src={thumb.url}
            alt=""
            onLoad={(e) =>
              thumb.onLoad?.([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])
            }
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2 text-sm text-fg-strong">
          <span className="truncate">{label}</span>
          {badge}
        </p>
        <p className="text-xs text-fg-muted tabular-nums">
          {detail ? `${detail} · ` : ''}
          {needs}
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        ) : warning ? (
          <p className="mt-1 text-xs text-warning">{warning}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <input
          ref={input}
          type="file"
          accept=".png,image/png"
          hidden
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          iconStart={<ACTION_ICON.upload aria-hidden />}
          loading={busy}
          busy="bob"
          disabled={disabled}
          aria-label={props.replaceLabel}
          onClick={() => input.current?.click()}
        >
          <span className="max-sm:sr-only">Replace</span>
        </Button>
        {props.trailing}
      </div>
      {props.children}
    </li>
  );
}
