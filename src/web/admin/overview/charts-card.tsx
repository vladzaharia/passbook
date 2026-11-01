import { Table2 } from 'lucide-react';
import { useState } from 'react';
import type { MetricsOverview, SeriesKey } from '@/shared/contracts/metrics.ts';
import { Button, Card, CardBody, CardHeader, LoadingRail } from '@/web/ui/index.ts';
import { LineChart, type Range } from './chart.tsx';

const CHARTS: { key: SeriesKey; title: string }[] = [
  { key: 'issued', title: 'Issued' },
  { key: 'updated', title: 'Updated' },
  { key: 'downloads', title: 'Downloads' },
  { key: 'pushes', title: 'Pushes' },
];

/** Four small charts; one toggle swaps every plot for its numbers at the same height. */
export function ChartsCard({
  data,
  range,
  enter,
  busy,
}: {
  data: MetricsOverview;
  range: Range;
  enter: boolean;
  busy: boolean;
}) {
  const [showData, setShowData] = useState(false);
  return (
    <Card aria-busy={busy || undefined}>
      <LoadingRail show={busy} />
      <CardHeader
        title="Activity"
        actions={
          <>
            {data.source === 'd1' ? (
              <span className="px-2 text-xs text-fg-muted">Approximate</span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showData}
              iconStart={<Table2 aria-hidden />}
              className="aria-pressed:bg-accent-subtle aria-pressed:text-fg-strong"
              onClick={() => setShowData((v) => !v)}
            >
              Show data
            </Button>
          </>
        }
      />
      <CardBody className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        {CHARTS.map((c) => (
          <LineChart
            key={c.key}
            title={c.title}
            points={data.series[c.key]}
            range={range}
            unavailable={data.unavailable.includes(c.key)}
            enter={enter}
            showData={showData}
          />
        ))}
      </CardBody>
    </Card>
  );
}
