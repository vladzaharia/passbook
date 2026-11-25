import { lazy, type ReactNode, Suspense, useState } from 'react';
import type { z } from 'zod';
import type { TemplateDetailSchema, TemplateVersionSchema } from '@/shared/contracts/templates.ts';
import { Button, Card, CardBody, CardHeader, ListRows } from '../../ui/index.ts';
import { TellHoldersLink } from '../passes/change/entry-links.tsx';
import type { VersionReleases } from './releases/version-info.ts';
import { VersionRow } from './version-row.tsx';
import type { SheetKind } from './version-sheet.tsx';
import { shortVersion, versionNumber } from './versions.ts';

const VersionSheet = lazy(() => import('./version-sheet.tsx'));

type Template = z.infer<typeof TemplateDetailSchema>;
type Version = z.infer<typeof TemplateVersionSchema>;

/** The versions kept in view besides Live and the draft. */
const RECENT = 3;

/** Live and the draft always show; then the newest others. Newest first throughout. */
export function visibleVersions(
  newestFirst: readonly Version[],
  pinned: ReadonlySet<string>,
  all: boolean,
): Version[] {
  if (all) return [...newestFirst];
  let others = 0;
  return newestFirst.filter((v) => pinned.has(v.version) || ++others <= RECENT);
}

/** One list of the saved versions, newest first, with what each one is and does. */
export function VersionList({
  template,
  draft,
  onTry,
  onRelease,
  canCompare = false,
  onReport,
  releases,
  rollout,
}: {
  template: Template;
  /** The newest valid version newer than Live: the one a release names. */
  draft?: string | undefined;
  onTry?: ((version: string) => void) | undefined;
  onRelease?: ((version: string) => void) | undefined;
  canCompare?: boolean;
  onReport: (version: string) => void;
  releases: VersionReleases | null;
  /** How far the Live release has reached the passes: the card's first block. */
  rollout?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const [sheet, setSheet] = useState<{ kind: SheetKind; version: Version } | null>(null);
  const newestFirst = [...template.versions].sort((a, b) => b.createdAt - a.createdAt);
  const live = releases?.live ?? template.versions.find((v) => v.active)?.version;
  const pinned = new Set([live, draft].filter((h): h is string => Boolean(h)));
  const shown = visibleVersions(newestFirst, pinned, all);
  const name = (hash: string) => shortVersion(versionNumber(template, hash));
  return (
    <Card>
      <CardHeader
        title="Versions"
        actions={
          template.orgId && template.passesOnOlderVersions > 0 ? (
            <TellHoldersLink orgId={template.orgId} templateId={template.id} />
          ) : undefined
        }
      />
      <CardBody>
        {rollout}
        <ListRows label="Versions">
          {shown.map((v) => (
            <VersionRow
              key={v.version}
              v={v}
              name={name(v.version)}
              draft={v.version === draft}
              info={releases}
              canCompare={canCompare}
              onTry={onTry ? () => onTry(v.version) : undefined}
              onRelease={onRelease ? () => onRelease(v.version) : undefined}
              onReport={() => onReport(v.version)}
              onSheet={(kind) => setSheet({ kind, version: v })}
            />
          ))}
        </ListRows>
        {newestFirst.length > shown.length || all ? (
          <Button
            size="sm"
            variant="link"
            className="mt-3"
            aria-expanded={all}
            onClick={() => setAll(!all)}
          >
            {all ? 'Show fewer' : `Show all ${newestFirst.length} versions`}
          </Button>
        ) : null}
      </CardBody>
      {sheet ? (
        <Suspense fallback={null}>
          <VersionSheet
            kind={sheet.kind}
            templateId={template.id}
            version={sheet.version}
            name={name}
            info={releases}
            onClose={() => setSheet(null)}
          />
        </Suspense>
      ) : null}
    </Card>
  );
}
