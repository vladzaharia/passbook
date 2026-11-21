import { WalletCards } from 'lucide-react';
import type { Mode } from '@/shared/contracts/common.ts';
import type {
  TemplateCandidate,
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
import { useReleaseLists, useWalletEnrolments } from './api.ts';
import { offReason, PROVIDER } from './labels.ts';
import { type ReleaseVersion, versionLabel } from './types.ts';

const WALLETS: readonly TemplateReleaseProvider[] = ['apple', 'google', 'samsung'];

/** "Ready", or how many things the wallet will not show, from the approved projection. */
function fidelityOf(candidate: TemplateCandidate | undefined): string {
  const projection = candidate?.projection as { approvedOmissions?: unknown } | undefined;
  const omitted = projection?.approvedOmissions;
  return Array.isArray(omitted) && omitted.length > 0 ? `${omitted.length} not shown` : 'Ready';
}

interface RowState {
  status: 'active' | 'on' | 'off' | 'not_configured';
  pill: 'success' | 'neutral' | 'warning';
  label: string;
  meta: string;
  off?: boolean;
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
  return {
    status: 'active',
    pill: 'success',
    label: 'Released',
    meta: `${versionLabel(versions, active.version)} · ${fidelityOf(source)}`,
  };
}

/** Google or Samsung when the platform and the organization have turned it on. */
function OnRow(props: RowProps & { orgId: string }) {
  const { templateId, orgId, mode, provider, versions } = props;
  const { releases, candidates } = useReleaseLists(templateId, { orgId, mode, provider });
  const state: RowState =
    releases.data && candidates.data
      ? releasedState(releases.data.active, candidates.data.items, versions)
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
          disabled={state.off}
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
  ...props
}: Omit<RowProps, 'provider'> & {
  orgId: string;
  /** The Apple release and candidates the panel already loaded. */
  apple: { active: TemplateRelease | null; candidates: readonly TemplateCandidate[] };
}) {
  const enrolments = useWalletEnrolments(orgId, props.mode);
  return (
    <Card>
      <CardHeader title="Wallets" />
      <CardBody>
        <ListRows label="Wallets">
          {WALLETS.map((provider) => {
            const row = { ...props, provider };
            if (provider === 'apple')
              return (
                <WalletRow
                  key={provider}
                  {...row}
                  state={releasedState(apple.active, apple.candidates, props.versions)}
                />
              );
            const enrolment = enrolments.data?.items.find((e) => e.provider === provider);
            if (enrolment?.state === 'on' && enrolment.issuance.state === 'enabled')
              return <OnRow key={provider} {...row} orgId={orgId} />;
            const released = enrolment?.issuance.state === 'enabled';
            return (
              <WalletRow
                key={provider}
                {...row}
                state={{
                  status: 'off',
                  pill: 'neutral',
                  label: 'Off',
                  meta: enrolments.isPending ? 'Checking.' : offReason(provider, released),
                  off: true,
                }}
              />
            );
          })}
        </ListRows>
      </CardBody>
    </Card>
  );
}
