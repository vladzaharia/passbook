import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import type { ValidationIssue } from '@/passkit/types.ts';
import { useDesigner } from './context.tsx';
import { contrastWarnings } from './contrast.ts';
import { type Selection, sectionLabel } from './model.ts';
import { issueTarget, platformManaged } from './targets.ts';

interface Row {
  id: string;
  severity: 'error' | 'warning';
  message: string;
  target: Selection | null;
  managed?: boolean;
}

const ORDER = { error: 0, warning: 1 } as const;

/** What the dry run and the colors say, each linked to the part it is about. */
export function Issues({
  issues,
  checking,
  failed,
}: {
  issues: readonly ValidationIssue[];
  checking: boolean;
  /** The check itself failed (network, server); the list may be stale. */
  failed?: string | undefined;
}) {
  const { doc, focusTarget } = useDesigner();
  // The dry run already says it; the local check only fills in while it has not answered.
  const server = issues.some(
    (i) => i.code === 'COLOR_CONTRAST' && /^(foreground|label)Color$/.test(i.path ?? ''),
  );
  const rows: Row[] = [
    ...issues
      .filter((i) => i.severity !== 'info')
      .map((i, n) => ({
        id: `${i.code}:${i.path ?? ''}:${n}`,
        severity: i.severity as 'error' | 'warning',
        message: i.message,
        target: issueTarget(i, doc),
        managed: platformManaged(i),
      })),
    ...(server ? [] : contrastWarnings(doc.passJson)).map((w) => ({
      id: `contrast:${w.key}`,
      severity: 'warning' as const,
      message: w.message,
      target: { section: 'colors' } as Selection,
    })),
  ].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const errors = rows.filter((r) => r.severity === 'error').length;
  return (
    <section aria-label="Issues" className="grid gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
        Issues
        <span className="text-xs font-normal text-fg-muted" role="status">
          {checking
            ? 'Checking'
            : errors > 0
              ? `${errors} to fix`
              : rows.length > 0
                ? `${rows.length} to review`
                : 'None'}
        </span>
      </h2>
      {failed ? (
        <p role="alert" className="text-xs text-danger">
          {failed}
        </p>
      ) : null}
      {rows.length === 0 && !checking && !failed ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <CircleCheck aria-hidden className="size-4 text-success" />
          Ready to save.
        </p>
      ) : (
        <ul className="grid gap-1">
          {rows.map((row) => {
            const Icon = row.severity === 'error' ? CircleAlert : TriangleAlert;
            const body = (
              <>
                <Icon
                  aria-hidden
                  className={
                    row.severity === 'error'
                      ? 'size-4 shrink-0 text-danger'
                      : 'size-4 shrink-0 text-warning'
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-fg-strong">{row.message}</span>
                  {row.target ? (
                    <span className="text-xs text-fg-muted">
                      {sectionLabel(row.target.section)}
                      {row.target.key ? `: ${row.target.key}` : ''}
                    </span>
                  ) : row.managed ? (
                    <span className="text-xs text-fg-muted">Set by PassBook</span>
                  ) : null}
                </span>
              </>
            );
            return (
              <li key={row.id}>
                {row.target ? (
                  <button
                    type="button"
                    className="dz-issue"
                    onClick={() => focusTarget(row.target as Selection)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="dz-issue" data-static>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
