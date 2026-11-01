import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { FileStack, Lock, Upload } from 'lucide-react';
import { useMemo } from 'react';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { useOrgFilter } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Badge,
  Button,
  CheckboxField,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  StatusPill,
} from '../../ui/index.ts';
import { PassPreview } from '../passes/pass-preview.tsx';
import { useTemplatePreview, useTemplates } from './api.ts';
import { styleList } from './labels.ts';

export interface TemplateListSearch {
  origin?: 'baked' | 'uploaded' | undefined;
  orgId?: string | undefined;
  archived?: boolean | undefined;
}

const ALL = 'all';

/** A still, 32 px render of the template's sample pass. */
function TemplateThumb({ template }: { template: TemplateSummaryDto }) {
  const live = template.status === 'active' && Boolean(template.activeVersion);
  const preview = useTemplatePreview(live ? template.id : '');
  return (
    // Decorative: inert keeps the pass's own links out of the tab order and the a11y tree.
    <div inert className="pointer-events-none w-8 shrink-0">
      {live && preview.data ? (
        <PassPreview
          passJson={preview.data.passJson}
          assetBaseUrl={preview.data.assetBaseUrl}
          assetNames={preview.data.assetNames}
          still
          className="mx-0 max-w-8"
        />
      ) : (
        <div className="aspect-[320/460] w-8 rounded-sm border border-border bg-surface-sunken" />
      )}
    </div>
  );
}

export function TemplatesListPage({
  search,
  onSearch,
}: {
  search: TemplateListSearch;
  onSearch: (patch: Partial<TemplateListSearch>) => void;
}) {
  const { orgId: globalOrg } = useOrgFilter();
  const orgId = search.orgId ?? globalOrg;
  const orgs = useOrgOptions();
  const list = useTemplates({ orgId, origin: search.origin, includeArchived: search.archived });

  const columns = useMemo<ColumnDef<TemplateSummaryDto, never>[]>(
    () => [
      {
        id: 'name',
        header: 'Template',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <TemplateThumb template={row.original} />
            <div className="min-w-0 max-w-xs xl:max-w-md">
              <Link
                to={`/admin/templates/${row.original.id}` as never}
                className="block truncate font-medium text-accent-fg hover:underline"
                title={row.original.name}
              >
                {row.original.name}
              </Link>
              {row.original.description ? (
                <p className="truncate text-xs text-fg-muted" title={row.original.description}>
                  {row.original.description}
                </p>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: 'origin',
        meta: { hideBelow: 'xl', stackHidden: true },
        header: 'Origin',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.origin === 'baked' ? (
            <Badge tone="accent">
              <Lock aria-hidden />
              Baked
            </Badge>
          ) : (
            <Badge>Uploaded</Badge>
          ),
      },
      {
        id: 'org',
        meta: { nowrap: true },
        header: 'Org',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="block max-w-44 truncate" title={row.original.orgName ?? undefined}>
            {row.original.orgName ?? '—'}
          </span>
        ),
      },
      {
        id: 'styles',
        meta: { hideBelow: 'xl', stackHidden: true, nowrap: true },
        header: 'Styles',
        enableSorting: false,
        cell: ({ row }) => styleList(row.original.styles),
      },
      {
        id: 'version',
        meta: { hideBelow: 'xl', stackHidden: true },
        header: 'Active',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.activeVersion?.slice(0, 8) ?? '—'}
          </span>
        ),
      },
      {
        id: 'passes',
        meta: { numeric: true, stackHidden: true },
        header: 'Passes',
        enableSorting: false,
        cell: ({ row }) => row.original.passCount,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <StatusPill
            status={row.original.status}
            tone={row.original.status === 'active' ? 'success' : 'neutral'}
          />
        ),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Templates"
        actions={
          <Button asChild iconStart={<Upload aria-hidden />}>
            <Link to="/admin/templates/upload">Upload template</Link>
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          aria-label="Origin"
          className="w-40"
          value={search.origin ?? ALL}
          onValueChange={(v) =>
            onSearch({ origin: v === ALL ? undefined : (v as 'baked' | 'uploaded') })
          }
          options={[
            { value: ALL, label: 'Origin: all' },
            { value: 'baked', label: 'Baked' },
            { value: 'uploaded', label: 'Uploaded' },
          ]}
        />
        <Select
          aria-label="Org"
          className="w-44"
          value={orgId ?? ALL}
          onValueChange={(v) => onSearch({ orgId: v === ALL ? undefined : v })}
          options={[
            { value: ALL, label: 'Org: all' },
            ...(orgs.data?.items ?? []).map((o) => ({ value: o.id, label: o.name })),
          ]}
        />
        <CheckboxField
          label="Show archived"
          checked={search.archived === true}
          onCheckedChange={(c) => onSearch({ archived: c === true ? true : undefined })}
        />
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Templates"
          columns={columns}
          data={list.data?.items ?? []}
          getRowId={(r) => r.id}
          loading={list.isPending}
          empty={
            <EmptyState
              icon={FileStack}
              title="No templates"
              action={
                <Button asChild iconStart={<Upload aria-hidden />}>
                  <Link to="/admin/templates/upload">Upload template</Link>
                </Button>
              }
            />
          }
        />
      )}
    </>
  );
}
