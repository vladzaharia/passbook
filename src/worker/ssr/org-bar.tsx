import type { PassView } from '../../shared/pass-view/index.ts';

/** The org's bar on hosted pages (AppShell's: 56 px with its border, sticky, page surface). */
export function OrgBar({
  orgName,
  icon,
}: {
  orgName: string;
  icon: PassView['images']['icon'] | undefined;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface-page pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-[calc(3.5rem-1px)] w-full max-w-5xl items-center gap-2.5 px-safe">
        {icon ? (
          <img
            src={icon.src}
            srcSet={icon.srcset}
            alt=""
            className="size-7 shrink-0 rounded-md object-contain"
          />
        ) : null}
        <span className="min-w-0 truncate text-base font-semibold text-fg-strong">{orgName}</span>
      </div>
    </header>
  );
}
