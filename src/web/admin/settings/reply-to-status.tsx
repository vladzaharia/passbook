import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ReplyToStatusSchema } from '@/shared/contracts/settings.ts';
import { api } from '@/web/lib/api.ts';
import { Button, toast } from '@/web/ui/index.ts';
import { useSettings } from './queries.ts';

/**
 * Whether replies to pass emails go to the support address. A new address waits until its owner
 * follows the emailed link; `?confirmReplyTo=<token>` on this page completes it.
 */
export function ReplyToStatus({ orgId }: { orgId: string }) {
  const client = useQueryClient();
  const support = useSettings(`org:${orgId}`).data?.items.find((i) => i.key === 'support.email');
  const key = ['settings', `org:${orgId}`, 'reply-to', support?.value ?? null] as const;
  const status = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api.get('/api/v1/settings/reply-to', ReplyToStatusSchema, { query: { orgId }, signal }),
  });
  const done = (data: unknown) => client.setQueryData(key, data);
  const resend = useMutation({
    mutationFn: () => api.post('/api/v1/settings/reply-to/resend', ReplyToStatusSchema, { orgId }),
    onSuccess: (data) => {
      done(data);
      toast.success('Link sent');
    },
    onError: (error) => toast.error(error, 'Could not send the link'),
  });
  const confirm = useMutation({
    mutationFn: (token: string) =>
      api.post('/api/v1/settings/reply-to/confirm', ReplyToStatusSchema, { orgId, token }),
    onSuccess: (data) => {
      done(data);
      toast.success('Reply-to confirmed');
    },
    onError: (error) => toast.error(error, 'Could not confirm the address'),
  });
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current) return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get('confirmReplyTo');
    if (!token) return;
    tried.current = true;
    url.searchParams.delete('confirmReplyTo');
    window.history.replaceState(null, '', url);
    confirm.mutate(token);
  }, [confirm]);

  const data = status.data;
  if (!data || data.state === 'none') return null;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {data.state === 'confirmed' ? (
        <span className="text-fg-muted">Replies go to {data.address}.</span>
      ) : (
        <>
          <span className="text-fg-muted">Waiting for confirmation from {data.address}.</span>
          <Button
            size="sm"
            variant="secondary"
            loading={resend.isPending}
            onClick={() => resend.mutate()}
          >
            Resend
          </Button>
        </>
      )}
    </div>
  );
}
