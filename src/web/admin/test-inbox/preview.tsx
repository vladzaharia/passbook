import { Send } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type { CapturedEmailDetailSchema } from '@/shared/contracts/sandbox.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  Button,
  ErrorState,
  KeyValue,
  SegmentedControl,
  Sheet,
  SheetContent,
  Skeleton,
  toast,
} from '../../ui/index.ts';
import { previewSrc, useCapturedEmail, useSendToMe } from './queries.ts';

type Email = z.infer<typeof CapturedEmailDetailSchema>;
type View = 'html' | 'text';

const VIEWS = [
  { value: 'html', label: 'Preview' },
  { value: 'text', label: 'Text' },
] as const;

function Body({ email, orgName }: { email: Email; orgName: string | undefined }) {
  const [view, setView] = useState<View>('html');
  const send = useSendToMe();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <KeyValue
        items={[
          { label: 'Subject', value: email.subject },
          { label: 'Would go to', value: email.to },
          { label: 'Organization', value: orgName ?? null },
          { label: 'For', value: email.kind === 'bundle' ? 'A bundle' : 'A pass' },
          { label: 'Captured', value: formatDateTime(email.createdAt) },
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          label="Message view"
          options={VIEWS}
          value={view}
          onValueChange={setView}
        />
        <Button
          variant="outline"
          iconStart={<Send aria-hidden />}
          loading={send.isPending}
          onClick={() =>
            send.mutate(email.id, {
              onSuccess: ({ to }) => toast.success(`Sent to ${to}`),
              onError: (error) => toast.error(error, 'Could not send'),
            })
          }
        >
          Send to me
        </Button>
      </div>
      {view === 'html' ? (
        // No allow-* tokens: no script, no forms, no popups, no storage. The server's policy adds
        // the rest. The page behind it is white because email is designed for a light canvas.
        <iframe
          title="Email preview"
          sandbox=""
          src={previewSrc(email.id)}
          className="h-[32rem] w-full min-w-0 rounded-md border border-border bg-white"
        />
      ) : (
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-sunken p-3 font-mono text-xs text-fg [overflow-wrap:anywhere]">
          {email.text}
        </pre>
      )}
    </div>
  );
}

/** One captured message: the details, a sandboxed frame and Send to me. */
export function EmailPreview({
  id,
  orgName,
  onClose,
}: {
  id: string | undefined;
  orgName: (orgId: string) => string | undefined;
  onClose: () => void;
}) {
  const email = useCapturedEmail(id);
  return (
    <Sheet open={id !== undefined} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={email.data?.subject ?? 'Test email'} className="w-[min(100vw,40rem)]">
        {email.isError ? (
          <div className="p-4">
            <ErrorState inline error={email.error} onRetry={() => void email.refetch()} />
          </div>
        ) : email.data ? (
          <Body key={email.data.id} email={email.data} orgName={orgName(email.data.orgId)} />
        ) : (
          <div className="p-4">
            <Skeleton className="h-64 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
