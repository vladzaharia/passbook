import { type CSSProperties, createContext, useContext } from 'react';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { formatDay } from '../../lib/format.ts';
import type { Swatch } from '../../lib/swatches.ts';
import { Checkbox, RowLink, StatusIcon, StatusPill } from '../../ui/index.ts';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import type { FindChip } from './find-query.ts';
import { MatchHint } from './match-hint.tsx';
import { PassRowMenu } from './row-menu.tsx';

export type { Swatch };

/** What the cells read. Cells are stable components; this context carries what changes. */
export interface ListContextValue {
  orgId: string | undefined;
  canOperate: boolean;
  templateNames: ReadonlyMap<string, string>;
  orgNames: ReadonlyMap<string, string>;
  swatches: ReadonlyMap<string, Swatch>;
  /** Some titles repeat on the page: subtitles disambiguate them. */
  showSubtitles: boolean;
  selected: ReadonlySet<string>;
  allSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  /** The query bar's chips and input labels: the matched value shows under the name. */
  find?: { chips: readonly FindChip[]; labels: ReadonlyMap<string, string> };
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

function ActionsCell({ pass }: { pass: PassSummaryDto }) {
  const { orgId, canOperate } = useList();
  return <PassRowMenu pass={pass} orgId={orgId} canOperate={canOperate} />;
}

function TitleCell({ pass: p }: { pass: PassSummaryDto }) {
  const o = useList();
  return (
    <span className="flex min-w-0 max-w-72 flex-col gap-0.5 contain-inline-size">
      <span className="flex min-w-0 items-center gap-3">
        <PassChip swatch={o.swatches.get(p.templateId)} voided={p.status === 'voided'} />
        <RowLink
          to="/admin/passes/$passId"
          params={{ passId: p.id }}
          inactive={p.status === 'voided'}
          title={nameOf(p)}
        >
          {nameOf(p)}
        </RowLink>
        <ModePill mode={p.mode} compact />
        {p.status === 'voided' ? <StatusPill status="voided" /> : null}
        {p.removedAt !== null ? <StatusIcon status="removed" /> : null}
        {o.showSubtitles && p.subtitle ? (
          <span className="min-w-12 truncate text-sm text-fg-muted">{p.subtitle}</span>
        ) : null}
      </span>
      {o.find && p.matched?.length ? (
        <MatchHint matched={p.matched} chips={o.find.chips} labels={o.find.labels} />
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
export function passColumns(showOrg: boolean): DataColumnDef<PassSummaryDto, never>[] {
  return [
    {
      id: 'select',
      meta: { stackLead: true },
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
      meta: { nowrap: 'wide', stackNoLabel: true },
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
          } satisfies DataColumnDef<PassSummaryDto, never>,
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
      meta: { nowrap: true, stackHidden: true },
      cell: ({ row }) => (
        <span className="text-fg-muted">{formatDay(row.original.modifiedAt)}</span>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => <ActionsCell pass={row.original} />,
    },
  ];
}
