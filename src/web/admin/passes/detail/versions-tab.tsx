import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { causeLabel } from '../../../lib/status.ts';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DiffViewer,
  ErrorState,
  FormField,
  Select,
  SkeletonRows,
  StatusPill,
} from '../../../ui/index.ts';
import { usePassDiff } from '../api.ts';
import { formatDate } from '../format.ts';

type Pass = z.infer<typeof PassDetailSchema>;

function show(v: unknown): string {
  return v === undefined ? '(none)' : JSON.stringify(v);
}

export function VersionsTab({
  pass,
  selected,
  onSelect,
}: {
  pass: Pass;
  selected: number | undefined;
  onSelect: (version: number | undefined) => void;
}) {
  const versions = useMemo(
    () => [...pass.versions].sort((a, b) => b.version - a.version),
    [pass.versions],
  );
  const [from, setFrom] = useState<number | undefined>(versions[1]?.version);
  const [to, setTo] = useState<number | undefined>(versions[0]?.version);
  const diff = usePassDiff(pass.id, from, to);
  const options = versions.map((v) => ({ value: String(v.version), label: `v${v.version}` }));

  const text = useMemo(() => {
    const changes = diff.data?.changes ?? [];
    return {
      before: changes.map((c) => `${c.path}: ${show(c.from)}`).join('\n'),
      after: changes.map((c) => `${c.path}: ${show(c.to)}`).join('\n'),
    };
  }, [diff.data]);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Versions" />
        <CardBody>
          <ul className="divide-y divide-border">
            {versions.map((v) => (
              <li
                key={v.version}
                className="flex flex-wrap items-center justify-between gap-3 py-2"
              >
                <div className="text-sm">
                  <span className="font-medium text-fg-strong">v{v.version}</span>
                  <span className="ml-3 text-xs text-fg-muted">
                    {causeLabel(v.cause)} · template {v.templateVersion.slice(0, 8)} ·{' '}
                    {formatDate(v.createdAt)}
                  </span>
                  {v.purged ? <Badge className="ml-2">Purged</Badge> : null}
                </div>
                {selected === v.version ||
                (selected === undefined && v.version === pass.version) ? (
                  <StatusPill status="showing" />
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={v.purged}
                    aria-label={`Render v${v.version}`}
                    onClick={() => onSelect(v.version === pass.version ? undefined : v.version)}
                  >
                    Render
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Compare" />
        <CardBody className="grid gap-4">
          <div className="flex flex-wrap gap-4">
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
          {from === to ? (
            <p className="text-sm text-fg-muted">Pick two different versions.</p>
          ) : diff.isPending && diff.fetchStatus !== 'idle' ? (
            <SkeletonRows rows={4} label="Loading changes" />
          ) : diff.isError ? (
            <ErrorState error={diff.error} onRetry={() => void diff.refetch()} />
          ) : diff.data ? (
            <DiffViewer before={text.before} after={text.after} />
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
