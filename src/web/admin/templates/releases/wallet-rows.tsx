import { WalletCards } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import type {
  TemplateCandidate,
  TemplateCandidateCurrent,
  TemplateRelease,
  TemplateReleaseProvider,
} from '@/shared/contracts/template-releases.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ListRow,
  ListRows,
  StatusPill,
} from '../../../ui/index.ts';
import { useReleaseLists } from './api.ts';
import { PROVIDER } from './labels.ts';
import { type ReleaseVersion, versionLabel } from './types.ts';
import { fidelityWords, newestRelease, walletReview } from './wallet-review.ts';

const WalletReviewDialog = lazy(() => import('./wallet-review-dialog.tsx'));

const WALLETS: readonly TemplateReleaseProvider[] = ['apple', 'google', 'samsung'];

/** "Ready", or how many things the wallet will not show, from the approved projection. */
function fidelityOf(candidate: TemplateCandidate | undefined): string {
  const projection = candidate?.projection as { approvedOmissions?: unknown } | undefined;
  const omitted = projection?.approvedOmissions;
  return Array.isArray(omitted) && omitted.length > 0 ? `${omitted.length} not shown` : 'Ready';
}

interface RowState {
  status: 'active' | 'on' | 'off' | 'not_configured' | 'blocked';
  pill: 'success' | 'neutral' | 'warning' | 'danger';
  label: string;
  meta: string;
}

function releasedState(
  active: TemplateRelease | null,
  candidates: readonly TemplateCandidate[],
  versions: readonly ReleaseVersion[],
): RowState {
  if (!active)
    return {
      status: 'not_configured',
      pill: 'warning',
      label: 'No release',
      meta: '',
    };
  const source = candidates.find((c) => c.id === active.candidateId);
  if (active.googleReview === 'rejected')
    return {
      status: 'off',
      pill: 'warning',
      label: 'Rejected by Google',
      meta: versionLabel(versions, active.version),
    };
  if (active.googleReview === 'waiting')
    return {
      status: 'on',
      pill: 'neutral',
      label: 'Waiting for Google review',
      meta: versionLabel(versions, active.version),
    };
  return {
    status: 'active',
    pill: 'success',
    label: 'Released',
    meta: `${versionLabel(versions, active.version)} · ${fidelityOf(source)}`,
  };
}

/**
 * Google or Samsung from the report the server compiles now and the release it serves: Blocked
 * and Review needed (Q21) outrank a plain release; a class under Google's review comes next.
 */
function nativeState(
  current: TemplateCandidateCurrent | undefined,
  active: TemplateRelease | null,
  candidates: readonly TemplateCandidate[],
  versions: readonly ReleaseVersion[],
  previous: TemplateRelease | null,
): RowState {
  if (!current) return releasedState(active, candidates, versions);
  const review = walletReview(current, active, candidates, previous);
  const meta = versionLabel(versions, current.version);
  if (review.kind === 'off') return { status: 'off', pill: 'neutral', label: 'Off', meta: '' };
  if (review.kind === 'blocked')
    return { status: 'blocked', pill: 'danger', label: 'Blocked', meta: review.reason };
  if (active?.googleReview === 'rejected') return releasedState(active, candidates, versions);
  if (review.kind === 'review')
    return {
      status: 'blocked',
      pill: 'warning',
      label: review.pending.length > 0 ? 'Review needed: new omission' : 'Review needed: new type',
      meta:
        review.pending.length > 0
          ? review.pending.map((item) => item.message).join(' · ')
          : `Now ${review.typeChanged?.to ?? ''}, approved as ${review.typeChanged?.from ?? ''}.`,
    };
  if (review.kind === 'released' && active?.googleReview === 'waiting')
    return releasedState(active, candidates, versions);
  if (review.kind === 'released')
    return {
      status: 'active',
      pill: 'success',
      label: 'Released',
      meta: `${meta} · ${fidelityWords(review.items.length)}`,
    };
  return review.kind === 'omissions'
    ? {
        status: 'on',
        pill: 'warning',
        label: fidelityWords(review.items.length),
        meta,
      }
    : { status: 'on', pill: 'success', label: 'Ready', meta };
}

/** Google or Samsung when the platform and the organization have turned it on. */
function OnRow(props: RowProps & { orgId: string }) {
  const { templateId, orgId, mode, provider, versions } = props;
  const { releases, candidates } = useReleaseLists(templateId, { orgId, mode, provider });
  const state: RowState =
    releases.data && candidates.data
      ? nativeState(
          candidates.data.current,
          releases.data.active,
          candidates.data.items,
          versions,
          newestRelease(releases.data.items),
        )
      : { status: 'on', pill: 'neutral', label: 'On', meta: 'Loading release.' };
  return <WalletRow {...props} state={state} />;
}

interface RowProps {
  templateId: string;
  mode: Mode;
  provider: TemplateReleaseProvider;
  versions: readonly ReleaseVersion[];
  selected: TemplateReleaseProvider;
  onSelect: (provider: TemplateReleaseProvider) => void;
}

function WalletRow({ provider, selected, onSelect, state }: RowProps & { state: RowState }) {
  const name = `${PROVIDER[provider]} Wallet`;
  return (
    <ListRow
      leading={<WalletCards aria-hidden />}
      title={name}
      pills={
        <StatusPill status={state.status} tone={state.pill}>
          {state.label}
        </StatusPill>
      }
      meta={state.meta}
      trailing={
        <Button
          size="sm"
          variant="outline"
          aria-pressed={selected === provider}
          aria-label={`Review ${name}`}
          onClick={() => onSelect(provider)}
        >
          Review
        </Button>
      }
    />
  );
}

/** One row per wallet: its state, what it will not show, and the review below. */
export function WalletRows({
  orgId,
  apple,
  capabilities,
  alone,
  ...base
}: Omit<RowProps, 'provider'> & {
  orgId: string;
  capabilities: readonly OrgCapability[];
  /** The release state's `alone`: the shared rule for approving your own work. */
  alone: boolean;
  /** The Apple release and candidates the panel already loaded. */
  apple: { active: TemplateRelease | null; candidates: readonly TemplateCandidate[] };
}) {
  const [reviewing, setReviewing] = useState<'google' | 'samsung' | null>(null);
  const props = {
    ...base,
    onSelect: (provider: TemplateReleaseProvider) => {
      base.onSelect(provider);
      if (provider !== 'apple') setReviewing(provider);
    },
  };
  // The template's own lists say whether a wallet is open for this organization, to anyone who can review.
  const scopes = { orgId, mode: props.mode };
  const google = useReleaseLists(props.templateId, { ...scopes, provider: 'google' });
  const samsung = useReleaseLists(props.templateId, { ...scopes, provider: 'samsung' });
  // Google and Samsung ship dark: a row exists only once the wallet is on for this organization.
  const on = WALLETS.filter(
    (provider) =>
      (provider === 'google' ? google : provider === 'samsung' ? samsung : null)?.candidates.data
        ?.wallet === 'on',
  );
  if (on.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Wallets" />
      <CardBody>
        <ListRows label="Wallets">
          <WalletRow
            {...props}
            provider="apple"
            state={releasedState(apple.active, apple.candidates, props.versions)}
          />
          {on.map((provider) => (
            <OnRow key={provider} {...props} provider={provider} orgId={orgId} />
          ))}
        </ListRows>
      </CardBody>
      {reviewing ? (
        <Suspense fallback={null}>
          <WalletReviewDialog
            templateId={props.templateId}
            orgId={orgId}
            mode={props.mode}
            provider={reviewing}
            versions={props.versions}
            capabilities={capabilities}
            alone={alone}
            onClose={() => setReviewing(null)}
          />
        </Suspense>
      ) : null}
    </Card>
  );
}
