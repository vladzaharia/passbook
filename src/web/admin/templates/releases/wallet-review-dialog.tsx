import { useEffect, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import type { TemplateCandidate } from '@/shared/contracts/template-releases.ts';
import { isApiError } from '../../../lib/errors.ts';
import { prefersReducedMotion } from '../../../lib/motion.ts';
import {
  Badge,
  Button,
  Callout,
  CheckboxField,
  Dialog,
  DialogContent,
  EmptyState,
  Skeleton,
  toast,
} from '../../../ui/index.ts';
import { useReleaseLists } from './api.ts';
import { PROVIDER } from './labels.ts';
import { type ReleaseVersion, versionLabel } from './types.ts';
import { type Omission, walletReview } from './wallet-review.ts';
import { useWalletApproval } from './wallet-review-api.ts';

export interface WalletReviewDialogProps {
  templateId: string;
  orgId: string;
  mode: Mode;
  provider: 'google' | 'samsung';
  versions: readonly ReleaseVersion[];
  capabilities: readonly OrgCapability[];
  /** The release state's `alone`: the one shared rule for approving your own work. */
  alone: boolean;
  onClose: () => void;
}

/** A candidate already requested for exactly these omissions on this version. */
function requested(
  candidates: readonly TemplateCandidate[],
  version: string,
  keys: readonly string[],
): TemplateCandidate | undefined {
  const want = JSON.stringify([...keys].sort());
  return candidates.find((c) => {
    const p = c.projection as { schema?: unknown; approvedOmissions?: unknown } | undefined;
    return (
      c.version === version &&
      c.approvals.length === 0 &&
      p?.schema === 2 &&
      Array.isArray(p.approvedOmissions) &&
      JSON.stringify([...(p.approvedOmissions as string[])].sort()) === want
    );
  });
}

function OmissionRow({
  item,
  state,
  checked,
  onChange,
}: {
  item: Omission;
  state: 'approved' | 'new' | 'open';
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-2">
        <CheckboxField
          className="min-w-0 flex-1 items-start"
          checked={checked}
          disabled={state === 'approved'}
          onCheckedChange={(v) => onChange(v === true)}
          label={
            <span className="grid min-w-0 gap-1">
              <span className="text-fg-strong">{item.message}</span>
              <span className="font-mono text-xs break-words text-fg-muted">
                {item.capability}
                {item.path ? ` · ${item.path}` : ''}
              </span>
            </span>
          }
        />
        <span className="flex shrink-0 items-center gap-1.5">
          {state === 'new' ? <Badge tone="warning">New</Badge> : null}
          <Badge>{item.group === 'door' ? 'Door' : 'Customers'}</Badge>
        </span>
      </div>
    </li>
  );
}

/** One wallet's omissions, approved item by item; a Q21 pause shows only what is new to approve. */
export default function WalletReviewDialog({
  templateId,
  orgId,
  mode,
  provider,
  versions,
  capabilities,
  alone,
  onClose,
}: WalletReviewDialogProps) {
  const name = `${PROVIDER[provider]} Wallet`;
  const { releases, candidates } = useReleaseLists(templateId, { orgId, mode, provider });
  const approval = useWalletApproval(templateId, { orgId, mode, provider });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState(false);
  const busy = approval.isPending || done;
  const current = candidates.data?.current;
  const loading = !candidates.isError && !releases.isError && (!candidates.data || !releases.data);
  const review =
    current && releases.data && candidates.data
      ? walletReview(current, releases.data.active, candidates.data.items)
      : null;
  const author = capabilities.includes('templates:author');
  const reviewer = capabilities.includes('templates:review');
  const publisher = capabilities.includes('templates:publish');

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(onClose, prefersReducedMotion() ? 0 : 500);
    return () => clearTimeout(timer);
  }, [done, onClose]);

  const items = review && 'items' in review ? review.items : [];
  const pending = review && 'pending' in review ? review.pending : [];
  const keys = items.map((i) => i.key);
  const existing =
    current && candidates.data
      ? requested(candidates.data.items, current.version, keys)
      : undefined;
  const complete = pending.every((i) => checked.has(i.key));
  const open = review && 'items' in review && review.kind !== 'released';
  const generation = (releases.data?.items ?? []).reduce(
    (max, r) => Math.max(max, r.generation),
    0,
  );
  const canApprove = reviewer && (author || existing !== undefined);

  async function submit(mode: 'approve' | 'release' | 'request') {
    if (!current) return;
    try {
      await approval.mutateAsync({
        current,
        keys,
        existing,
        approve: mode !== 'request',
        alone,
        publishAt: mode === 'release' ? generation : undefined,
      });
      toast.success(
        mode === 'release'
          ? `Released to ${name}`
          : mode === 'approve'
            ? `Approved for ${name}`
            : 'Review requested',
      );
      setDone(true);
    } catch {
      // Shown below from the mutation's own error.
    }
  }

  const error = approval.error
    ? isApiError(approval.error)
      ? approval.error.message
      : 'Could not save the review.'
    : null;

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent
        title={`Review ${name}`}
        description={current ? versionLabel(versions, current.version) : undefined}
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {open ? 'Cancel' : 'Close'}
            </Button>
            {open && !canApprove && author ? (
              <Button
                loading={approval.isPending}
                disabled={busy || existing !== undefined}
                onClick={() => void submit('request')}
              >
                {existing ? 'Review requested' : 'Request review'}
              </Button>
            ) : null}
            {open && canApprove ? (
              <Button
                variant={publisher ? 'outline' : 'primary'}
                loading={approval.isPending}
                disabled={busy || !complete}
                onClick={() => void submit('approve')}
              >
                Approve
              </Button>
            ) : null}
            {open && canApprove && publisher ? (
              <Button
                loading={approval.isPending}
                disabled={busy || !complete}
                onClick={() => void submit('release')}
              >
                Approve and release
              </Button>
            ) : null}
          </>
        }
      >
        <div className="grid gap-4">
          {loading ? (
            <div role="status" aria-busy className="grid gap-3">
              <span className="sr-only">Loading review</span>
              <Skeleton className="h-6 w-56" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : !review ? (
            <Callout tone="warning">Could not check {name}. Try again.</Callout>
          ) : review.kind === 'off' ? (
            <EmptyState art="wallet" title={`${name} is off for this template`} />
          ) : review.kind === 'blocked' ? (
            <Callout tone="danger" title="Blocked">
              {review.reason}
            </Callout>
          ) : (
            <>
              {review.kind === 'review' ? (
                <Callout
                  tone="warning"
                  title={
                    pending.length > 0 ? 'Review needed: new omission' : 'Review needed: new type'
                  }
                >
                  {review.typeChanged
                    ? `Now ${review.typeChanged.to}, approved as ${review.typeChanged.from}.`
                    : null}
                </Callout>
              ) : null}
              {items.length === 0 ? (
                <EmptyState art="wallet" title="Nothing is left out" />
              ) : (
                <fieldset className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <legend className="text-sm font-medium text-fg-strong">Omissions</legend>
                    {pending.length > 0 && canApprove ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || complete}
                        onClick={() => setChecked(new Set(pending.map((i) => i.key)))}
                      >
                        Check all
                      </Button>
                    ) : null}
                  </div>
                  <ul className="divide-y divide-border">
                    {items.map((item) => {
                      const isApproved = review.approved.has(item.key);
                      return (
                        <OmissionRow
                          key={item.key}
                          item={item}
                          state={
                            isApproved ? 'approved' : review.kind === 'review' ? 'new' : 'open'
                          }
                          checked={isApproved || checked.has(item.key)}
                          onChange={(on) =>
                            setChecked((prev) => {
                              const next = new Set(prev);
                              if (on) next.add(item.key);
                              else next.delete(item.key);
                              return next;
                            })
                          }
                        />
                      );
                    })}
                  </ul>
                </fieldset>
              )}
              {open && canApprove && alone ? (
                <Callout tone="info">
                  You are the only reviewer. This approves your own work.
                </Callout>
              ) : null}
              {open && !canApprove && !existing ? (
                <Callout tone="info">No review is requested yet.</Callout>
              ) : null}
            </>
          )}
          {error ? <Callout tone="danger">{error}</Callout> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
