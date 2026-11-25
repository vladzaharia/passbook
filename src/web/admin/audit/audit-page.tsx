import { useCallback, useMemo } from 'react';
import { RETENTION_COPY } from '@/shared/copy/retention.ts';
import { Badge, Card, CardBody, PageHeader } from '@/web/ui/index.ts';
import { useOrgPages } from '../orgs/org-pages.ts';
import { useOrgList } from '../orgs/queries.ts';
import { AuditFilters } from './audit-filters.tsx';
import type { AuditSearch } from './audit-search.ts';
import { AuditTable } from './audit-table.tsx';
import { EntryDrawer } from './entry-drawer.tsx';
import { ExportButton } from './export-button.tsx';
import { usePlatformAuditLog } from './queries.ts';

export function AuditPage({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
}) {
  const directory = useOrgPages();
  const orgs = useOrgList();
  const { entry, ...filters } = search;
  const orgId = filters.filterOrgId;
  const log = usePlatformAuditLog(filters);
  const orgNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const org of orgs.data?.items ?? []) names.set(org.id, org.name);
    for (const page of directory.data?.pages ?? []) {
      for (const org of page.items) names.set(org.id, org.name);
    }
    // A personal org is not in the directory: its entries carry the label.
    for (const page of log.data?.pages ?? [])
      for (const row of page.items)
        if (row.orgId && row.orgLabel) names.set(row.orgId, row.orgLabel);
    return names;
  }, [directory.data, orgs.data, log.data]);
  const orgName = useCallback(
    (id: string | null) => (id ? orgNames.get(id) : undefined),
    [orgNames],
  );
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = entry === undefined ? undefined : rows.find((r) => r.id === entry);
  const filtered = Object.values(filters).some((v) => v !== undefined);
  const open = (id: number) => onSearch({ ...filters, entry: id });

  const names = {
    actor: rows.find((r) => r.actorId === filters.actorId)?.actorLabel ?? undefined,
    target: rows.find((r) => r.targetId === filters.targetId)?.targetLabel ?? undefined,
    org: orgName(filters.filterOrgId ?? null),
  };
  return (
    <>
      <PageHeader
        title="Audit log"
        description={RETENTION_COPY.auditNote(365)}
        actions={
          <ExportButton
            path="/api/v1/audit/platform/export"
            query={{ ...filters, filterOrgId: undefined, orgId }}
          />
        }
        meta={
          <Badge className="max-w-full break-words whitespace-normal">
            Organization filter: {orgId ? (orgName(orgId) ?? orgId) : 'All organizations'}
          </Badge>
        }
      />
      <Card className="mb-6">
        <CardBody>
          <AuditFilters search={filters} onSearch={onSearch} names={names} />
        </CardBody>
      </Card>
      <AuditTable
        log={log}
        orgName={orgName}
        showOrganization={!orgId}
        filtered={filtered}
        scopedMore={!filters.filterOrgId}
        onOpen={open}
        onClear={() => onSearch({})}
      />
      <EntryDrawer entry={selected} orgName={orgName} onClose={() => onSearch(filters)} />
    </>
  );
}
