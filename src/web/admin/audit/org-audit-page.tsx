import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useId } from 'react';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, Card, CardBody, Combobox, Label, PageHeader } from '@/web/ui/index.ts';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { ACTION_OPTIONS } from './audit-filters.tsx';
import type { AuditSearch } from './audit-search.ts';
import { AuditTable } from './audit-table.tsx';
import { DateFilter } from './date-filter.tsx';
import { EntryDrawer } from './entry-drawer.tsx';
import { ExportButton } from './export-button.tsx';
import { useTenantAuditLog } from './queries.ts';

const NO_NAME = () => undefined;

/** An organization's own log: action and date only, since people and passes are its own. */
export function OrgAuditPage({
  search,
  onSearch,
}: {
  search: AuditSearch;
  onSearch: (next: AuditSearch) => void;
}) {
  const id = useId();
  const { membership } = useOrgScope();
  const allowed = membership?.capabilities.includes('audit:read') ? membership.orgId : undefined;
  const { entry, filterOrgId: _ignored, ...filters } = search;
  const log = useTenantAuditLog(allowed, filters);
  const rows = log.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = entry === undefined ? undefined : rows.find((r) => r.id === entry);
  // The route also carries the org scope (`orgId`); that is not a filter.
  const filtered = Object.entries(filters).some(([key, v]) => v !== undefined && key !== 'orgId');
  const patch = (next: AuditSearch) => onSearch({ ...filters, ...next });
  if (!allowed) {
    return <OrgChooser />;
  }
  const actions =
    filters.action && !ACTION_OPTIONS.some((o) => o.value === filters.action)
      ? [...ACTION_OPTIONS, { value: filters.action, label: `${filters.action} (prefix)` }]
      : ACTION_OPTIONS;
  return (
    <>
      <PageHeader
        title="Audit log"
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/admin/o/$orgId/retention" params={{ orgId: allowed }}>
                Retention
              </Link>
            </Button>
            <ExportButton path="/api/v1/audit/export" query={{ ...filters, orgId: allowed }} />
          </>
        }
      />
      <Card className="mb-6">
        <CardBody>
          <search aria-label="Filters" className="grid gap-3 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={`${id}-action`}>Action</Label>
              <Combobox
                id={`${id}-action`}
                aria-label="Action"
                className="w-full"
                options={actions}
                value={filters.action ?? ''}
                onValueChange={(v) => patch({ action: v || undefined })}
                searchPlaceholder="Search actions"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-sm font-medium text-fg">Date</span>
              <DateFilter
                from={filters.from}
                to={filters.to}
                onChange={(r) => patch(r)}
                className="w-full"
              />
            </div>
            {filtered ? (
              <div className="sm:col-span-2">
                <Button variant="ghost" iconStart={<X aria-hidden />} onClick={() => onSearch({})}>
                  Clear event filters
                </Button>
              </div>
            ) : null}
          </search>
        </CardBody>
      </Card>
      <AuditTable
        log={log}
        orgName={NO_NAME}
        showOrganization={false}
        filtered={filtered}
        scopedMore={false}
        onOpen={(next) => onSearch({ ...filters, entry: next })}
        onClear={() => onSearch({})}
      />
      <EntryDrawer
        entry={selected}
        orgName={(id) => (id === allowed ? membership?.orgName : undefined)}
        onClose={() => onSearch(filters)}
      />
    </>
  );
}
