import { FileText, GitCompare, Info, RotateCcw, Send, Smartphone } from 'lucide-react';
import type { z } from 'zod';
import type { TemplateVersionSchema } from '@/shared/contracts/templates.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Badge, ListRow, type RowAction, RowActions } from '../../ui/index.ts';
import type { VersionReleases } from './releases/version-info.ts';
import type { SheetKind } from './version-sheet.tsx';

type Version = z.infer<typeof TemplateVersionSchema>;

function Pills({ v, draft, info }: { v: Version; draft: boolean; info: VersionReleases | null }) {
  const errors = v.report.issues.filter((i) => i.severity === 'error').length;
  const warnings = v.report.issues.filter((i) => i.severity === 'warning').length;
  const live = info?.live ? v.version === info.live : v.active;
  return (
    <>
      {draft ? <Badge>Draft</Badge> : null}
      {live ? <Badge tone="success">Live</Badge> : null}
      {info?.test === v.version ? <Badge tone="info">Test</Badge> : null}
      {warnings > 0 ? (
        <Badge tone="warning">
          {warnings} {warnings === 1 ? 'warning' : 'warnings'}
        </Badge>
      ) : null}
      {errors > 0 ? (
        <Badge tone="danger">
          {errors} {errors === 1 ? 'error' : 'errors'}
        </Badge>
      ) : null}
    </>
  );
}

export function VersionRow({
  v,
  name,
  draft,
  info,
  onTry,
  onRelease,
  canCompare,
  onReport,
  onSheet,
}: {
  v: Version;
  name: string;
  draft: boolean;
  info: VersionReleases | null;
  onTry?: (() => void) | undefined;
  onRelease?: (() => void) | undefined;
  canCompare: boolean;
  onReport: () => void;
  onSheet: (kind: SheetKind) => void;
}) {
  const releasable = v.report.ok && !v.active;
  const restore = info?.restore.get(v.version);
  const released = info?.releasedAt.get(v.version);
  const base = info?.mode === 'test' ? info.test : info?.live;
  const compare = canCompare && Boolean(base && base !== v.version && v.report.ok);
  const actions: RowAction[] = [
    ...(releasable && onRelease ? [{ label: 'Release', icon: Send, onSelect: onRelease }] : []),
    ...(releasable && onTry ? [{ label: 'Try', icon: Smartphone, onSelect: onTry }] : []),
    ...(restore
      ? [{ label: 'Restore', icon: RotateCcw, onSelect: restore, disabled: info?.busy ?? false }]
      : []),
    ...(compare
      ? [{ label: 'Compare', icon: GitCompare, onSelect: () => onSheet('compare') }]
      : []),
    { label: 'Report', icon: FileText, onSelect: onReport },
    { label: 'Technical details', icon: Info, onSelect: () => onSheet('details') },
  ];
  return (
    <ListRow
      title={name}
      pills={<Pills v={v} draft={draft} info={info} />}
      meta={
        <>
          {released
            ? `Released ${formatDateTime(released)}`
            : `Saved ${formatDateTime(v.createdAt)}`}
          {v.passCount > 0 ? ` · ${v.passCount} ${v.passCount === 1 ? 'pass' : 'passes'}` : ''}
        </>
      }
      trailing={<RowActions actions={actions} label={`Actions for ${name}`} />}
    />
  );
}
