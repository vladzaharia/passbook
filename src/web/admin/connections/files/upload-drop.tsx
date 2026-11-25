import { useState } from 'react';
import { Buddy, Callout, FileDrop, StepList } from '../../../ui/index.ts';
import type { UploadFailure } from './file-errors.ts';

const ACCEPT = '.csv,.xlsx,.json,.ndjson,.jsonl,.tsv,.txt,text/csv,application/json';

/** The failure under the drop: a warning for the hourly allowance, an error for a file we cannot take. */
export function FailureNote({ failure }: { failure: UploadFailure }) {
  return <Callout tone={failure.kind === 'rate' ? 'warning' : 'danger'}>{failure.text}</Callout>;
}

/**
 * The drop zone. A file dragged over it brings the buddy up to look; while the server reads the file
 * the zone gives way to a working step.
 */
export function UploadDrop({
  onFile,
  busy,
  failure,
  invalid,
  label = 'Drop a file or choose',
}: {
  onFile: (file: File) => void;
  busy: boolean;
  failure: UploadFailure | undefined;
  invalid?: boolean;
  label?: string;
}) {
  const [over, setOver] = useState(0);
  if (busy) {
    return (
      <StepList
        label="Upload"
        items={[{ id: 'read', state: 'working', label: 'Reading the file', detail: undefined }]}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only tracks the drag for the buddy; the drop itself is the kit's */}
      <div
        className="relative"
        onDragEnter={() => setOver((n) => n + 1)}
        onDragLeave={() => setOver((n) => Math.max(0, n - 1))}
        onDrop={() => setOver(0)}
      >
        <FileDrop
          label={label}
          hint="CSV, Excel or JSON · up to 5 MB"
          accept={ACCEPT}
          invalid={invalid || failure !== undefined}
          onFiles={(files) => files[0] && onFile(files[0])}
        />
        {over > 0 ? (
          <div aria-hidden className="pointer-events-none absolute top-20 right-6 h-0 w-16">
            <Buddy size="sm" mood="curious" scene="peek" />
          </div>
        ) : null}
      </div>
      {failure ? <FailureNote failure={failure} /> : null}
    </div>
  );
}
