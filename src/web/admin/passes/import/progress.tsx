import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { Buddy, Card, CardBody, CardHeader, ProgressBar } from '../../../ui/index.ts';

/** A running import: "120 of 160", polled by the page. */
export function ImportProgress({ imp }: { imp: PassImportDto }) {
  const total = (imp.counts?.create ?? 0) + (imp.counts?.update ?? 0);
  const done = Math.min(imp.progress?.done ?? 0, total);
  const text = C.progressText(done, total);
  return (
    <Card>
      <CardHeader title={C.progress.title} />
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <Buddy scene="count" size="sm" className="shrink-0" />
          <p aria-live="polite" className="text-base font-medium text-fg-strong tabular-nums">
            {text}
          </p>
        </div>
        <ProgressBar
          label="Passes handled"
          value={done}
          max={Math.max(total, 1)}
          valueText={text}
        />
      </CardBody>
    </Card>
  );
}
