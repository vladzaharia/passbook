/**
 * The org's bar on hosted pages (AppShell's: 56 px with its border, sticky, page surface). It
 * names the org; a pass's icon is a notification square drawn per pass, never the org's mark.
 */
export function OrgBar({ orgName }: { orgName: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface-page pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-[calc(3.5rem-1px)] w-full max-w-5xl items-center px-safe">
        <span className="min-w-0 truncate text-base font-semibold text-fg-strong">{orgName}</span>
      </div>
    </header>
  );
}
