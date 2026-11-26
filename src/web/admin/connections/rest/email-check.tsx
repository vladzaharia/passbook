import { Check, TriangleAlert } from 'lucide-react';
import { Button } from '../../../ui/index.ts';
import type { EmailCheck } from './use-explorer.ts';

/** One line under the holder email: it reads on the single record, or it does not. */
export function EmailCheckLine({ check, onShow }: { check: EmailCheck; onShow: () => void }) {
  return (
    <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {check.state === 'checking' ? (
        <span className="text-fg-muted">Checking the record…</span>
      ) : null}
      {check.state === 'ok' ? (
        <span className="inline-flex items-center gap-1.5 text-success">
          <Check aria-hidden className="size-4" />
          On the single record.
        </span>
      ) : null}
      {check.state === 'missing' ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-warning">
            <TriangleAlert aria-hidden className="size-4" />
            Not on the single record. Pick it there.
          </span>
          <Button variant="outline" size="sm" onClick={onShow}>
            Show the record
          </Button>
        </>
      ) : null}
      {check.state === 'failed' ? (
        <span className="text-danger">
          {check.failure.line} <code className="font-mono text-xs">{check.failure.code}</code>
        </span>
      ) : null}
    </div>
  );
}
