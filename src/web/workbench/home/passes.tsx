import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { WB_HOME_COPY as C } from '../../../shared/copy/workbench-home.ts';
import { wbPath } from '../../../shared/workbench.ts';
import { Button } from '../../ui/button.tsx';
import { CardBody, CardLink } from '../../ui/card.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { ToolFailed } from '../states/states.tsx';
import { QrTile } from '../ui/preview-qr.tsx';
import type { PassRow } from './data.ts';
import { Panel } from './panel.tsx';

/** The latest pass's Test preview as a QR; until the device pass ships it is the whole card. */
export function PhoneCard({
  orgId,
  link,
  loading,
  seat,
}: {
  orgId: string;
  link: string | undefined;
  loading: boolean;
  seat?: ReactNode;
}) {
  let body: ReactNode;
  if (link)
    body = (
      <CardBody className="flex flex-wrap items-center gap-4">
        <QrTile value={link} alt={C.phone.qrAlt} />
        <div className="flex min-w-0 flex-1 basis-32 flex-col items-start gap-2">
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="max-w-full truncate font-mono text-xs text-accent-fg underline-offset-4 hover:underline"
          >
            {link.replace(/^https?:\/\//, '')}
          </a>
          <Button asChild variant="outline" size="sm">
            <a href={link} target="_blank" rel="noreferrer">
              {C.phone.open}
            </a>
          </Button>
        </div>
      </CardBody>
    );
  else if (loading)
    body = (
      <CardBody>
        <Skeleton className="size-32" />
      </CardBody>
    );
  else
    body = (
      <CardBody className="flex flex-col items-start gap-3">
        <p className="text-sm text-fg-muted">{C.phone.empty}</p>
        <Button asChild variant="outline" size="sm">
          <Link to={wbPath(orgId, 'design')}>{C.phone.emptyAction}</Link>
        </Button>
      </CardBody>
    );
  return (
    <Panel title={C.phone.title} seat={seat}>
      {body}
    </Panel>
  );
}

/** The latest Test passes, fanned. Each opens in Passes. */
export function PassesFan({
  orgId,
  rows,
  error,
  onRetry,
  seat,
}: {
  orgId: string;
  rows: readonly PassRow[] | undefined;
  error: unknown;
  onRetry: () => void;
  seat?: ReactNode;
}) {
  const shown = (rows ?? []).slice(0, 3);
  let body: ReactNode;
  if (!rows) body = error ? <ToolFailed error={error} onRetry={onRetry} /> : <PassesLoading />;
  else if (shown.length === 0)
    body = (
      <CardBody className="flex flex-col items-start gap-3">
        <p className="text-sm text-fg-muted">{C.passes.empty}</p>
        <Button asChild variant="outline" size="sm">
          <Link to={wbPath(orgId, 'design')}>{C.passes.action}</Link>
        </Button>
      </CardBody>
    );
  else
    body = (
      <div className="wb-home-fan flex justify-center px-4 pt-6 pb-8" data-n={shown.length}>
        {shown.map((p) => (
          <Link
            key={p.id}
            to={wbPath(orgId, 'passes', { hash: p.id })}
            className="relative flex h-40 w-36 flex-col gap-0.5 rounded-lg border border-border bg-surface-raised p-3 shadow-elevation-1 outline-none hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="mb-2 self-start rounded-sm bg-warning-subtle px-1.5 font-mono text-[0.625rem] font-semibold tracking-widest text-warning">
              TEST
            </span>
            <span className="text-sm font-semibold break-words text-fg-strong">
              {p.title ?? 'Untitled pass'}
            </span>
            {p.subtitle ? <span className="text-xs text-fg-muted">{p.subtitle}</span> : null}
            <span className="absolute top-3 right-3 font-mono text-xs text-fg-muted">
              v{p.version}
            </span>
          </Link>
        ))}
      </div>
    );
  return (
    <Panel
      title={C.passes.title}
      seat={seat}
      actions={<CardLink to={wbPath(orgId, 'passes')}>{C.passes.all}</CardLink>}
    >
      {body}
    </Panel>
  );
}

function PassesLoading() {
  return (
    <div role="status" aria-busy className="flex justify-center gap-3 p-6">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-40 w-36" />
      ))}
    </div>
  );
}
