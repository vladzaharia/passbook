import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { z } from 'zod';
import type { ValidationReportSchema } from '@/shared/contracts/templates.ts';

type Report = z.infer<typeof ValidationReportSchema>;

/** Errors first, then warnings. Icon and word carry severity, not colour alone. */
export function ValidationReport({ report }: { report: Report }) {
  if (report.issues.length === 0) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-success">
        <CheckCircle2 aria-hidden className="size-4" />
        No issues
      </p>
    );
  }
  const sorted = [...report.issues].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1,
  );
  return (
    <ul className="grid gap-2">
      {sorted.map((issue, i) => {
        const error = issue.severity === 'error';
        const Icon = error ? XCircle : AlertTriangle;
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: issues repeat code and path
            key={i}
            className="flex items-start gap-2 text-sm"
          >
            <Icon
              aria-hidden
              className={`mt-0.5 size-4 shrink-0 ${error ? 'text-danger' : 'text-warning'}`}
            />
            <span>
              <span className="font-medium text-fg-strong">{error ? 'Error' : 'Warning'}</span>{' '}
              <span className="font-mono text-xs text-fg-muted">{issue.code}</span>
              {issue.path ? (
                <span className="font-mono text-xs text-fg-muted"> {issue.path}</span>
              ) : null}
              <span className="block text-fg">{issue.message}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
