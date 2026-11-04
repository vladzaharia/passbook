import { EntityAvatar } from '../../ui/index.ts';

/**
 * The notification Wallet shows on the lock screen: the org's icon, its name and the message.
 * A drawing of it, not a screenshot: the text is the one the holder gets.
 */
export function LockScreenNotice({
  org,
  text,
  silent,
}: {
  org: { id: string; name: string; accent?: string | null };
  text: string;
  /** Nothing appears on the lock screen: the pass updates quietly. */
  silent?: boolean;
}) {
  return (
    <figure
      aria-label="Lock screen notification"
      className="m-0 rounded-2xl border border-border bg-surface-sunken p-4"
    >
      <div
        key={`${silent}-${text}`}
        data-silent={silent ? '' : undefined}
        className="wl-stage-swap flex min-h-16 items-start gap-3 rounded-xl border border-border bg-surface-raised p-3 shadow-elevation-1 data-[silent]:opacity-60"
      >
        <EntityAvatar kind="org" id={org.id} name={org.name} accent={org.accent} size={40} />
        <figcaption className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-semibold text-fg-strong">{org.name}</span>
            <span className="shrink-0 text-xs text-fg-muted">now</span>
          </div>
          {silent ? (
            <p className="mt-0.5 text-sm text-fg-muted">
              No notification. The pass updates quietly.
            </p>
          ) : (
            <p className="mt-0.5 break-words text-sm text-fg">
              {text.trim() || <span className="text-fg-subtle">Your message shows here.</span>}
            </p>
          )}
        </figcaption>
      </div>
    </figure>
  );
}
