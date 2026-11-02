import { ArrowRight, Eye } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { causeLabel } from '../../../lib/status.ts';
import { LayersArt } from '../../../ui/art/layers.tsx';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  FormField,
  ListRow,
  ListRows,
  Select,
  SkeletonRows,
  StatusPill,
} from '../../../ui/index.ts';
import { usePassDiff } from '../api.ts';

function show(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function Changes({ id, from, to }: { id: string; from: number; to: number }) {
  const diff = usePassDiff(id, from, to);
  // Rows rise once, the first time a comparison lands; later picks swap in place.
  const [rise, setRise] = useState(true);
  const landed = Boolean(diff.data);
  useEffect(() => {
    if (!landed) return;
    const t = setTimeout(() => setRise(false), 400);
    return () => clearTimeout(t);
  }, [landed]);
  if (diff.isPending && diff.fetchStatus !== 'idle')
    return <SkeletonRows rows={3} label="Loading changes" />;
  if (diff.isError)
    return <ErrorState inline error={diff.error} onRetry={() => void diff.refetch()} />;
  const changes = diff.data?.changes ?? [];
  if (changes.length === 0) return <p className="text-sm text-fg-muted">No field changes.</p>;
  return (
    <ul
      aria-label="Changes"
      className={rise ? 'wl-diff-rise divide-y divide-border' : 'divide-y divide-border'}
    >
      {changes.map((c, i) => (
        <li
          key={c.path}
          style={{ '--i': i } as CSSProperties}
          className="grid gap-1 py-2 first:pt-0 last:pb-0 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4"
        >
          <span className="truncate font-mono text-xs text-fg-muted">{c.path}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="truncate text-fg-muted line-through decoration-fg-subtle">
              {show(c.from)}
            </span>
            <ArrowRight aria-label="to" className="size-3.5 shrink-0 text-fg-subtle" />
            <span className="truncate text-fg-strong">{show(c.to)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Retained versions; Preview drives the stage. Compare shows when there are two or more. */
export function VersionsTab({
  pass,
  selected,
  onSelect,
}: {
  pass: PassDetailDto;
  selected: number | undefined;
  onSelect: (version: number | undefined) => void;
}) {
  const versions = useMemo(
    () => [...pass.versions].sort((a, b) => b.version - a.version),
    [pass.versions],
  );
  const kept = versions.filter((v) => !v.purged);
  const [from, setFrom] = useState(kept[1]?.version);
  const [to, setTo] = useState(kept[0]?.version);
  const options = kept.map((v) => ({ value: String(v.version), label: `v${v.version}` }));
  const showing = selected ?? pass.version;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="Versions" />
        <CardBody>
          <ListRows label="Versions">
            {versions.map((v) => (
              <ListRow
                key={v.version}
                title={<span className="tabular-nums">v{v.version}</span>}
                pills={
                  <>
                    {v.version === pass.version ? <Badge>Current</Badge> : null}
                    {v.purged ? <Badge>Purged</Badge> : null}
                  </>
                }
                meta={`${causeLabel(v.cause)} · ${formatDateTime(v.createdAt)}`}
                trailing={
                  v.version === showing ? (
                    <StatusPill status="showing" />
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      iconStart={<Eye aria-hidden />}
                      disabled={v.purged}
                      aria-label={`Preview v${v.version}`}
                      onClick={() => onSelect(v.version === pass.version ? undefined : v.version)}
                    >
                      Preview
                    </Button>
                  )
                }
              />
            ))}
          </ListRows>
        </CardBody>
      </Card>
      {kept.length > 1 ? (
        <Card>
          <CardHeader title="Compare" />
          <CardBody className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <FormField label="From">
                {(c) => (
                  <Select
                    {...c}
                    className="w-28"
                    options={options}
                    value={from === undefined ? undefined : String(from)}
                    onValueChange={(v) => setFrom(Number(v))}
                  />
                )}
              </FormField>
              <FormField label="To">
                {(c) => (
                  <Select
                    {...c}
                    className="w-28"
                    options={options}
                    value={to === undefined ? undefined : String(to)}
                    onValueChange={(v) => setTo(Number(v))}
                  />
                )}
              </FormField>
            </div>
            {from === undefined || to === undefined || from === to ? (
              <div className="flex flex-col items-center gap-1.5 py-4 text-center" data-art-host="">
                <LayersArt size="sm" compare />
                <p className="text-sm font-medium text-fg-strong">Pick two versions</p>
              </div>
            ) : (
              <Changes id={pass.id} from={from} to={to} />
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
