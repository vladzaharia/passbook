import { useEffect, useState } from 'react';
import { MetaLink, Sheet, SheetContent } from '../../ui/index.ts';
import type { InboxHost } from './host.ts';
import { EmailDetail } from './preview.tsx';

/** One captured message in admin's right sheet. */
export function EmailPreview({
  id,
  orgId,
  userId,
  host,
  onClose,
}: {
  id: string;
  orgId: string;
  userId: string;
  host: InboxHost;
  onClose: () => void;
}) {
  const { mode } = host;
  const [opened] = useState(() => ({ orgId, userId, mode }));
  const current =
    mode === 'test' && opened.orgId === orgId && opened.userId === userId && opened.mode === mode;
  useEffect(() => {
    if (!current) onClose();
  }, [current, onClose]);
  return (
    <Sheet open={current} onOpenChange={(open) => !open && onClose()}>
      {current ? (
        <EmailDetail
          id={id}
          orgId={orgId}
          userId={userId}
          host={host}
          forLink={(email) => (
            <MetaLink
              to="/admin/passes/$passId"
              params={{ passId: email.passId as string }}
              search={{ orgId }}
            >
              {email.kind === 'bundle' ? 'A bundle' : 'A pass'}
            </MetaLink>
          )}
          frame={(title, body) => (
            <SheetContent title={title} className="w-[min(100vw,40rem)]">
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{body}</div>
            </SheetContent>
          )}
        />
      ) : null}
    </Sheet>
  );
}
