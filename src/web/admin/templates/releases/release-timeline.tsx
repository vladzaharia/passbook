import { History, RotateCcw, Send } from 'lucide-react';
import type { TemplateRelease } from '@/shared/contracts/template-releases.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { Badge, Button, Card, CardBody, CardHeader, TechnicalDetails } from '../../../ui/index.ts';

const WINDOW_MS = 10 * 60 * 1000;
const who = (r: TemplateRelease) =>
  r.createdByName ?? (r.createdBy === null ? 'System' : 'Someone');

export interface TimelineEntry {
  key: string;
  live: TemplateRelease | null;
  test: TemplateRelease | null;
  at: number;
}

/** One row per release: a Test release made with the Live one (same candidate) joins it. */
export function timelineEntries(
  live: readonly TemplateRelease[],
  test: readonly TemplateRelease[],
): TimelineEntry[] {
  const used = new Set<string>();
  const rows: TimelineEntry[] = live.map((l) => {
    const t = test.find(
      (x) =>
        !used.has(x.id) &&
        x.version === l.version &&
        Math.abs(x.createdAt - l.createdAt) < WINDOW_MS,
    );
    if (t) used.add(t.id);
    return { key: l.id, live: l, test: t ?? null, at: l.createdAt };
  });
  for (const t of test)
    if (!used.has(t.id)) rows.push({ key: t.id, live: null, test: t, at: t.createdAt });
  return rows.sort((a, b) => b.at - a.at);
}

export function ReleaseTimeline({
  entries,
  name,
  liveId,
  testId,
  selfApprovals,
  canRestore,
  busy,
  restorable,
  onRestore,
}: {
  entries: readonly TimelineEntry[];
  name: (hash: string) => string;
  liveId: string | null;
  testId: string | null;
  selfApprovals: ReadonlySet<string>;
  canRestore: boolean;
  busy: boolean;
  /** Live releases Restore may return to. */
  restorable: (release: TemplateRelease) => boolean;
  onRestore: (release: TemplateRelease) => void;
}) {
  return (
    <Card>
      <CardHeader title="Releases" />
      <CardBody>
        {entries.length ? (
          <ol aria-label="Releases" className="wl-timeline">
            {entries.map((e) => {
              const r = e.live ?? e.test;
              if (!r) return null;
              const modes = e.live && e.test ? 'Live and Test' : e.live ? 'Live' : 'Test';
              const restored = r.action === 'rollback';
              const current = e.live ? e.live.id === liveId : r.id === testId;
              const self = Boolean(r.approvalId && selfApprovals.has(r.approvalId));
              return (
                <li key={e.key} className="wl-timeline-row">
                  <span aria-hidden className="wl-timeline-icon" data-current={current}>
                    {restored ? <RotateCcw /> : <Send />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-fg-strong">
                      {restored ? `${name(r.version)} restored` : name(r.version)}
                      {current && e.live ? <Badge tone="success">Live</Badge> : null}
                      {self ? <Badge>Self-approved</Badge> : null}
                    </p>
                    <p className="text-sm text-fg-muted">
                      {modes} · {who(r)} · {formatDateTime(r.createdAt)}
                    </p>
                    <TechnicalDetails
                      className="mt-1"
                      items={[
                        { label: 'Generation', value: r.generation },
                        { label: 'Candidate', value: r.candidateHash },
                      ]}
                    />
                  </div>
                  {canRestore && e.live && restorable(e.live) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      iconStart={<RotateCcw aria-hidden />}
                      aria-label={`Restore ${name(r.version)}`}
                      onClick={() => e.live && onRestore(e.live)}
                    >
                      Restore
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <History aria-hidden className="size-4" />
            Not released
          </p>
        )}
      </CardBody>
    </Card>
  );
}
