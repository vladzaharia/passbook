import { useState } from 'react';

/**
 * The org's real pass email (rendered by the Worker with sample holder data), in an iframe that
 * cannot run scripts. `version` reloads it after a logo or icon upload.
 */
export function PassEmailPreview({
  orgId,
  buddy,
  version,
}: {
  orgId: string;
  buddy: boolean;
  version: number;
}) {
  const [height, setHeight] = useState(520);
  const src = `/api/v1/orgs/${encodeURIComponent(orgId)}/email-preview?buddy=${buddy ? 1 : 0}&v=${version}`;
  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <iframe
        key={src}
        title="Sample pass email"
        src={src}
        // Same origin only so the images load with the admin session; no scripts, forms or popups.
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ height }}
        className="w-full rounded-lg border border-border bg-surface-page"
        onLoad={(e) => {
          const h = e.currentTarget.contentDocument?.documentElement.scrollHeight;
          if (h) setHeight(h);
        }}
      />
      <p className="text-xs text-fg-muted">Sample email</p>
    </div>
  );
}
