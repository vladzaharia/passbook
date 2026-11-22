import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import type { JoinReadinessIssue } from '@/shared/contracts/join.ts';
import { JOIN_COPY, joinIssueLine } from '@/shared/copy/join.ts';

/** Why the link cannot be turned on, one line each, each with the place that fixes it. */
export function JoinReadiness({
  issues,
  mode,
  templateId,
  orgId,
}: {
  issues: readonly JoinReadinessIssue[];
  mode: 'Live' | 'Test';
  templateId: string;
  orgId: string | undefined;
}) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Before you turn it on">
      {issues.map((issue) => (
        <li
          key={`${issue.code}:${issue.input ?? ''}`}
          className="flex items-start gap-2 text-sm text-fg"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span className="min-w-0">
            {joinIssueLine(issue, { mode })}{' '}
            {issue.code === 'no_release' ? (
              <Link
                to="/admin/templates/$templateId"
                params={{ templateId }}
                search={{ orgId, tab: 'versions' }}
                className="text-accent-fg underline underline-offset-2"
              >
                Releases
              </Link>
            ) : issue.code === 'archived' ? null : (
              <Link
                to="/admin/templates/$templateId/design"
                params={{ templateId }}
                search={{ orgId }}
                className="text-accent-fg underline underline-offset-2"
              >
                Design
              </Link>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The template cannot have a join link at all: the one line shown in place of the settings. */
export function JoinNeedsCode({
  templateId,
  orgId,
}: {
  templateId: string;
  orgId: string | undefined;
}) {
  return (
    <>
      {JOIN_COPY.card.needsCode}{' '}
      <Link
        to="/admin/templates/$templateId/design"
        params={{ templateId }}
        search={{ orgId }}
        className="text-accent-fg underline underline-offset-2"
      >
        Design
      </Link>
    </>
  );
}
