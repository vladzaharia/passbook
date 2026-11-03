import type { ColumnDef } from '@tanstack/react-table';
import { type CSSProperties, createContext, useContext } from 'react';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { formatDay } from '../../lib/format.ts';
import type { Swatch } from '../../lib/swatches.ts';
import { Checkbox, RowLink, StatusIcon } from '../../ui/index.ts';
import { PassRowMenu } from './row-menu.tsx';

export type { Swatch };

/** What the cells read. Cells are stable components; this context carries what changes. */
export interface ListContextValue {
  templateNames: ReadonlyMap<string, string>;
  orgNames: ReadonlyMap<string, string>;
  swatches: ReadonlyMap<string, Swatch>;
  /** Some titles repeat on the page: subtitles disambiguate them. */
  showSubtitles: boolean;
  selected: ReadonlySet<string>;
  allSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

export const PassListContext = createContext<ListContextValue | null>(null);
const useList = () => {
  const ctx = useContext(PassListContext);
  if (!ctx) throw new Error('Pass list cells need PassListContext');
  return ctx;
};

/** A 20x28 chip in the pass's own colours (from its template), so rows read at a glance. */
export function PassChip({ swatch, voided }: { swatch: Swatch | undefined; voided: boolean }) {
  return (
    <span
      aria-hidden
      data-voided={voided || undefined}
      data-image={swatch?.image ? '' : undefined}
      style={
        swatch
          ? ({
              '--chip-bg': swatch.background,
              '--chip-fg': swatch.foreground,
              ...(swatch.image ? { backgroundImage: `url("${swatch.image}")` } : {}),
            } as CSSProperties)
          : undefined
      }
      className="wl-pass-chip"
    />
  );
}

const nameOf = (p: PassSummaryDto) => p.title ?? p.serial;

function SelectAll() {
  const o = useList();
  return (
    <Checkbox
      aria-label="Select all passes on this page"
      checked={o.allSelected ? true : o.selected.size > 0 ? 'indeterminate' : false}
      onCheckedChange={o.onToggleAll}
    />
  );
}

function SelectRow({ pass }: { pass: PassSummaryDto }) {
  const o = useList();
  return (
    <Checkbox
      aria-label={`Select ${nameOf(pass)}`}
      checked={o.selected.has(pass.id)}
      onCheckedChange={() => o.onToggle(pass.id)}
    />
  );
}

function TitleCell({ pass: p }: { pass: PassSummaryDto }) {
  const o = useList();
  return (
    <span className="flex min-w-0 max-w-72 items-center gap-3 contain-inline-size">
      <PassChip swatch={o.swatches.get(p.templateId)} voided={p.status === 'voided'} />
      <RowLink
        to="/admin/passes/$passId"
        params={{ passId: p.id }}
        inactive={p.status === 'voided'}
      >
        {nameOf(p)}
      </RowLink>
      {o.showSubtitles && p.subtitle ? (
        <span className="min-w-12 truncate text-sm text-fg-muted">{p.subtitle}</span>
      ) : null}
    </span>
  );
}

function OrgCell({ pass }: { pass: PassSummaryDto }) {
  const org = useList().orgNames.get(pass.orgId) ?? '—';
  return <span title={org}>{org}</span>;
}

function TemplateCell({ pass }: { pass: PassSummaryDto }) {
  const t = useList().templateNames.get(pass.templateId) ?? '—';
  return <span title={t}>{t}</span>;
}

/** Stable columns: only the org scope changes the set. */
export function passColumns(showOrg: boolean): ColumnDef<PassSummaryDto, never>[] {
  return [
    {
      id: 'select',
      meta: { stackHidden: true },
      header: () => <SelectAll />,
      cell: ({ row }) => <SelectRow pass={row.original} />,
    },
    {
      id: 'title',
      header: 'Pass',
      meta: { grow: true },
      cell: ({ row }) => <TitleCell pass={row.original} />,
    },
    {
      id: 'holder',
      header: 'Holder',
      // From xl, emails up to about 34 characters show in full.
      meta: { nowrap: 'wide' },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-2">
          <StatusIcon status={row.original.holderState} />
          <span
            className="max-w-44 truncate xl:max-w-72"
            title={row.original.holderEmail ?? undefined}
          >
            {row.original.holderEmail ?? <span className="text-fg-subtle">—</span>}
          </span>
        </span>
      ),
    },
    ...(showOrg
      ? [
          {
            id: 'org',
            header: 'Organization',
            meta: { hideBelow: 'xl', nowrap: true, stackHidden: true },
            cell: ({ row }) => <OrgCell pass={row.original} />,
          } satisfies ColumnDef<PassSummaryDto, never>,
        ]
      : []),
    {
      id: 'template',
      header: 'Template',
      // The chip already shows the template's look; the name waits for xl.
      meta: { hideBelow: 'xl', nowrap: true, stackHidden: true },
      cell: ({ row }) => <TemplateCell pass={row.original} />,
    },
    {
      id: 'devices',
      header: 'On device',
      meta: { hideBelow: '2xl', numeric: true, stackHidden: true },
      cell: ({ row }) =>
        row.original.deviceCount > 0 ? (
          row.original.deviceCount
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: 'updated',
      header: 'Updated',
      meta: { nowrap: true },
      cell: ({ row }) => (
        <span className="text-fg-muted">{formatDay(row.original.modifiedAt)}</span>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => <PassRowMenu pass={row.original} />,
    },
  ];
}
