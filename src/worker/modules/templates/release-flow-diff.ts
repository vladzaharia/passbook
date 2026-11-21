import type {
  ReleaseChange,
  ReleaseDiffGroup,
  ReleaseDiffValue,
} from '../../../shared/contracts/template-releases.ts';
import { versionDiff } from './release-impact-diff.ts';
import type { VersionRow } from './repo.ts';

type Side = Pick<VersionRow, 'passJson' | 'assets' | 'version'>;
type Rows = ReleaseDiffGroup['rows'];

const text = (value: string | null): ReleaseDiffValue | null =>
  value === null ? null : { type: 'text', text: value };
const color = (value: string | null): ReleaseDiffValue | null =>
  value === null ? null : { type: 'color', color: value };

function rows(
  changes: ReleaseChange[],
  value: (v: string | null, c: ReleaseChange, side: 'from' | 'to') => ReleaseDiffValue | null,
): Rows {
  return changes.map((c) => ({
    label: c.label,
    kind: c.kind,
    from: value(c.from, c, 'from'),
    to: value(c.to, c, 'to'),
  }));
}

/** The version diff as typed rows in the groups a release dialog shows; empty groups are left out. */
export function groupedDiff(from: Side | null, to: Side): ReleaseDiffGroup[] {
  const { diff, more } = versionDiff(from, to);
  const back = diff.fields.filter((c) => c.label.startsWith('Back:'));
  const front = diff.fields.filter((c) => !c.label.startsWith('Back:'));
  const image = (
    v: string | null,
    c: ReleaseChange,
    side: 'from' | 'to',
  ): ReleaseDiffValue | null =>
    v === null
      ? null
      : {
          type: 'image',
          version: (side === 'from' ? from : to)?.version ?? to.version,
          asset: c.label,
        };
  const groups: ReleaseDiffGroup[] = [
    { group: 'colors', rows: rows(diff.colors, color), more: more.colors },
    { group: 'front', rows: rows(front, text), more: more.fields },
    { group: 'back', rows: rows(back, text), more: 0 },
    { group: 'images', rows: rows(diff.images, image), more: more.images },
    { group: 'barcode', rows: rows(diff.barcode, text), more: more.barcode },
  ];
  return groups.filter((g) => g.rows.length > 0 || g.more > 0);
}
