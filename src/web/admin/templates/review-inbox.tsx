import { Link } from '@tanstack/react-router';
import { Eye } from 'lucide-react';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useTemplateReviews } from '../../lib/template-reviews.ts';
import { Badge, Button, RelTime, useNow } from '../../ui/index.ts';

/** Open review requests for the caller: one row each, straight into the review. */
export function ReviewInbox() {
  const { orgId, membership } = useOrgScope();
  const reviews = useTemplateReviews(
    orgId,
    Boolean(membership?.capabilities.includes('templates:review')),
  );
  const items = reviews.data?.items ?? [];
  const now = useNow();
  if (!orgId || items.length === 0) return null;
  return (
    <section aria-labelledby="needs-review" className="mb-6 grid gap-2">
      <h2
        id="needs-review"
        className="flex items-center gap-2 text-sm font-semibold text-fg-strong"
      >
        Needs your review
        <Badge tone="accent">{items.length}</Badge>
      </h2>
      <ul className="grid gap-2">
        {items.map((r) => (
          <li
            key={`${r.templateId}:${r.version}`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-fg-strong">
                {r.templateName}
              </span>
              <span className="text-xs text-fg-muted">
                {r.requestedBy ? `${r.requestedBy} · ` : ''}
                <RelTime at={r.requestedAt} now={now} />
              </span>
            </span>
            <Button asChild size="sm" variant="outline" iconStart={<Eye aria-hidden />}>
              <Link
                to="/admin/o/$orgId/templates/$templateId"
                params={{ orgId, templateId: r.templateId }}
                search={{ review: r.version }}
              >
                Review
                <span className="sr-only"> {r.templateName}</span>
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
