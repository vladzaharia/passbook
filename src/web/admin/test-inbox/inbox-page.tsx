import { FlaskConical, Mail } from 'lucide-react';
import { formatRelative } from '../../lib/format.ts';
import { setMode, useMode } from '../../lib/mode.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  ListRow,
  ListRows,
  LoadMore,
  PageHeader,
  RowLink,
  SkeletonRows,
} from '../../ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { EmailPreview } from './preview.tsx';
import { useCapturedEmails } from './queries.ts';

export interface InboxSearch {
  email?: string | undefined;
}

export const parseInboxSearch = (raw: Record<string, unknown>): InboxSearch => ({
  email: typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim() : undefined,
});

/** Mail that Test mode held back, newest first. Nothing in it was sent. */
export function InboxPage({
  search,
  onSearch,
}: {
  search: InboxSearch;
  onSearch: (next: InboxSearch) => void;
}) {
  const mode = useMode();
  const { orgId } = useOrgScope();
  const orgName = useOrgNames();
  const list = useCapturedEmails(orgId);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Test inbox"
        description="Emails for test passes and bundles land here. Nothing is sent."
      />
      {mode !== 'test' ? (
        <EmptyState
          art="envelope"
          title="Test mode is off"
          description="Turn it on to see mail from test passes."
          action={
            <Button
              variant="outline"
              iconStart={<FlaskConical aria-hidden />}
              onClick={() => setMode('test')}
            >
              Turn on Test mode
            </Button>
          }
        />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <SkeletonRows label="Loading test inbox" />
      ) : rows.length === 0 ? (
        <EmptyState art="envelope" title="No test emails yet" />
      ) : (
        <>
          <Card>
            <CardBody>
              <ListRows label="Test emails">
                {rows.map((m) => (
                  <ListRow
                    key={m.id}
                    rowId={m.id}
                    leading={<Mail aria-hidden />}
                    title={
                      <RowLink
                        to="/admin/test-inbox"
                        search={{ email: m.id }}
                        aria-label={`Open ${m.subject}`}
                      >
                        {m.subject}
                      </RowLink>
                    }
                    meta={`To ${m.to} · ${orgName(m.orgId)} · ${formatRelative(m.createdAt, now)}`}
                  />
                ))}
              </ListRows>
            </CardBody>
          </Card>
          <LoadMore query={list} shown={rows.length} noun={['email', 'emails']} scoped />
        </>
      )}
      <EmailPreview id={search.email} orgName={(id) => orgName(id)} onClose={() => onSearch({})} />
    </>
  );
}
