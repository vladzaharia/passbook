import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Download, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { Json } from '@/passkit/types.ts';
import { formatValue } from '@/shared/pass-view/format.ts';
import { isApiError } from '../lib/errors.ts';
import { PassCardStage } from '../pass-card/index.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CopyButton,
  ErrorState,
  KeyValue,
  PageHeader,
  Skeleton,
  StatusPill,
} from '../ui/index.ts';
import { myPassQuery } from './api.ts';
import { formatWhen, passName, toView } from './pass-view.ts';
import { RefreshButton } from './refresh-button.tsx';
import { AddToWalletButton, publicUrlOf, RemovePassButton } from './wallet-actions.tsx';

const CRUMBS = [{ label: 'My passes', to: '/' }];

const ABBREVIATIONS = new Set(['ID', 'VIP', 'URL', 'QR', 'SKU', 'ZIP', 'PIN', 'UPC', 'ETA', 'DOB']);

/** Pass labels are often written in capitals for the card; show them as a sentence. */
function sentenceCase(label: string): string {
  if (label.length < 2 || label !== label.toUpperCase()) return label;
  const words = label.split(' ').map((w, i) => {
    if (ABBREVIATIONS.has(w)) return w;
    const lower = w.toLowerCase();
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  });
  return words.join(' ');
}

function fieldRows(passJson: Record<string, unknown>) {
  const styles = ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass', 'posterGeneric'];
  const style = styles.find((s) => passJson[s] && typeof passJson[s] === 'object');
  if (!style) return [];
  const block = passJson[style] as Record<string, unknown>;
  const rows: { label: string; value: string }[] = [];
  for (const group of ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields']) {
    const list = block[group];
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      const spec = f as Record<string, unknown>;
      const { label, key, value } = spec;
      if (value === undefined || value === null || typeof value === 'object') continue;
      const text = formatValue(value as Json, spec, {
        locale: navigator.language,
        now: new Date(),
      }).text;
      rows.push({ label: sentenceCase(String(label ?? key ?? '')), value: text });
    }
  }
  return rows;
}

export function PassDetailPage({ passId }: { passId: string }) {
  const query = useQuery(myPassQuery(passId));
  const navigate = useNavigate();
  const [face, setFace] = useState<'front' | 'back'>('front');
  const [dip, setDip] = useState(0);

  if (query.isPending) {
    return (
      <>
        <PageHeader title="Pass" breadcrumbs={[...CRUMBS, { label: 'Pass' }]} />
        <Skeleton className="h-72" />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title="Pass" breadcrumbs={[...CRUMBS, { label: 'Pass' }]} />
        <ErrorState
          error={query.error}
          title={
            isApiError(query.error) && query.error.isNotFound ? 'Pass not found' : 'Could not load'
          }
          onRetry={
            isApiError(query.error) && query.error.isNotFound
              ? undefined
              : () => void query.refetch()
          }
        />
      </>
    );
  }

  const pass = query.data;
  const name = passName(pass);
  const view = toView(pass);
  const voided = pass.status === 'voided';
  const publicUrl = publicUrlOf(pass.downloadUrl);
  const rows = fieldRows(pass.passJson);

  return (
    <>
      <PageHeader
        size="lg"
        title={name}
        description={pass.orgName}
        breadcrumbs={[...CRUMBS, { label: name }]}
        actions={
          voided ? (
            <StatusPill status="voided" />
          ) : (
            <>
              <AddToWalletButton
                downloadUrl={pass.downloadUrl}
                onPress={() => setDip((n) => n + 1)}
              />
              <RefreshButton passId={pass.id} pass={pass} />
            </>
          )
        }
      />
      {view.expired && !voided ? (
        <p
          role="status"
          className="mb-4 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm"
        >
          This pass has expired.
        </p>
      ) : null}
      {voided ? (
        <p
          role="status"
          className="mb-4 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm"
        >
          This pass was voided.
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-[minmax(0,22rem)_1fr]">
        <div className="flex flex-col gap-3">
          <PassCardStage
            view={view}
            face={face}
            flippable
            mint={`${pass.modifiedAt}:${pass.lastRefreshedAt}`}
            dip={dip}
            transitionName={`pass-${pass.id}`}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFace(face === 'front' ? 'back' : 'front')}
          >
            {face === 'front' ? 'Details' : 'Front'}
          </Button>
        </div>
        <div className="flex flex-col gap-4">
          {rows.length ? (
            <Card>
              <CardHeader title="Details" />
              <CardBody>
                <KeyValue items={rows} />
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Pass" />
            <CardBody className="flex flex-col gap-3">
              <KeyValue
                items={[
                  { label: 'Updated', value: formatWhen(pass.modifiedAt) },
                  {
                    label: 'Last refreshed',
                    value: pass.lastRefreshedAt ? formatWhen(pass.lastRefreshedAt) : null,
                  },
                ]}
              />
              <div className="flex flex-wrap items-center gap-2">
                {voided ? null : (
                  <Button asChild variant="outline" size="sm" iconStart={<Download aria-hidden />}>
                    <a href={pass.downloadUrl} download>
                      Download .pkpass
                    </a>
                  </Button>
                )}
                {publicUrl ? (
                  <>
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      iconStart={<ExternalLink aria-hidden />}
                    >
                      <a href={publicUrl}>Public page</a>
                    </Button>
                    <CopyButton value={publicUrl} label="Copy public link" />
                  </>
                ) : null}
                <RemovePassButton
                  passId={pass.id}
                  passTitle={name}
                  onRemoved={() => void navigate({ to: '/' })}
                />
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
