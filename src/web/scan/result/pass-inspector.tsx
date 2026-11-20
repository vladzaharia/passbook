import { useQuery } from '@tanstack/react-query';
import { Eye, MoreHorizontal, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { Button } from '../../ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu.tsx';
import { SegmentedControl } from '../../ui/segmented-control.tsx';
import type { ScanApi } from '../api/scan-api.ts';
import type { ScanInput } from '../input/types.ts';
import { holdVerbs } from '../machine/access-view.ts';
import type { Recent, ScanOutcome } from '../machine/types.ts';
import { useScanMachine } from '../machine/use-scan-machine.ts';
import { scanId } from '../platform/id.ts';
import { DockButton } from '../ui/dock.tsx';
import { RecentList } from '../ui/recent-scans.tsx';
import { SheetFrame } from '../ui/sheet-frame.tsx';
import { isDenied, outcomeNotes } from './notes.ts';
import { PassPreview } from './pass-preview.tsx';
import { PassTab } from './pass-tab.tsx';
import { SheetHeader } from './sheet-header.tsx';

const COPY = SCAN_HANDHELD_COPY.sheet;

/** What opens the sheet: the verdict on the card (with how to fetch its pass), or a recent row. */
export interface PassInspection {
  outcome?: ScanOutcome | null;
  card?: ScanCard | null;
  input?: ScanInput;
  /** The verdict is still on screen: the sheet offers its Let in again. */
  live?: boolean;
  tab?: 'pass' | 'recent';
}

type Tab = 'pass' | 'recent';
export type Action = { key: string; label: string; icon?: ReactNode; run: () => void };

export function PassInspector({
  inspection,
  api,
  onClose,
  orgId,
  timeZone,
  where = '',
  eventNote,
  extraActions = [],
}: {
  inspection: PassInspection;
  api: ScanApi;
  onClose: () => void;
  orgId?: string;
  timeZone?: string;
  /** The scanner's name, for "Checked in 7:41 PM · Front door". */
  where?: string;
  eventNote?: string | null | undefined;
  /** Actions the loop owns, such as Add tag: they follow the pass's own. */
  extraActions?: Action[];
}) {
  const { state, now, dispatch } = useScanMachine();
  const [tab, setTab] = useState<Tab>(inspection.tab ?? 'pass');
  const [showPass, setShowPass] = useState(false);
  const [sel, setSel] = useState<PassInspection>(inspection);
  const o = sel.outcome ?? null;
  const query = useQuery({
    queryKey: ['scan', 'pass', sel.input?.id ?? sel.card?.passId ?? o?.scanId ?? 'none'],
    queryFn: ({ signal }) => {
      if (!sel.input) throw new Error('No pass selected.');
      const input = sel.input.passId
        ? { passId: sel.input.passId, method: 'manual' as const }
        : { code: sel.input.code ?? '', method: 'manual' as const };
      return api.resolve({ idempotencyKey: scanId(), clientTs: Date.now(), input }, { signal });
    },
    enabled: Boolean(sel.input) && !sel.card,
    staleTime: 0,
    gcTime: 0,
  });
  const card = sel.card ?? query.data?.card ?? o?.card ?? null;
  const pick = (row: Recent) => {
    setSel({ outcome: row.outcome, card: row.outcome.card });
    setShowPass(false);
    setTab('pass');
  };
  const display = o?.display ?? card?.display ?? null;
  const notes = o ? outcomeNotes(o, display, eventNote, isDenied(o, o.at ?? 0)) : [];
  const row = o?.scanId ? state.recent.find((r) => r.scanId === o.scanId) : undefined;
  const canUndo = Boolean(row?.undoable && (row.outcome.undoUntil ?? 0) > now);
  const mine = new Set(state.recent.map((r) => r.scanId).filter((id): id is string => Boolean(id)));
  const then = (act: () => void) => () => {
    act();
    onClose();
  };
  const actions: Action[] = [];
  if (o && sel.live)
    for (const verb of holdVerbs(o))
      actions.push({
        key: verb.label,
        label: verb.label,
        run: then(() =>
          dispatch(
            verb.kind === 'turn'
              ? { type: 'turn', direction: verb.direction }
              : { type: 'override', actionId: o.action?.id ?? '' },
          ),
        ),
      });
  if (canUndo && o?.scanId) {
    const scan = o.scanId;
    actions.push({
      key: 'undo',
      label: o.action?.kind === 'check_in' ? COPY.undoCheckIn : COPY.undo,
      icon: <Undo2 aria-hidden size={20} />,
      run: then(() => dispatch({ type: 'undo', scanId: scan })),
    });
  }
  if (card || query.isPending)
    actions.push({
      key: 'show',
      label: COPY.showPass,
      icon: <Eye aria-hidden size={20} />,
      run: () => setShowPass(true),
    });
  if (sel.live) actions.push(...extraActions.map((a) => ({ ...a, run: then(a.run) })));
  const hasPass = o !== null || card !== null;
  const footer =
    tab === 'recent' || !hasPass ? (
      <DockButton primary variant="filled" onClick={onClose}>
        {COPY.done}
      </DockButton>
    ) : showPass ? (
      <DockButton primary variant="filled" onClick={() => setShowPass(false)}>
        {COPY.hidePass}
      </DockButton>
    ) : (
      <>
        {actions.slice(0, 2).map((a) => (
          <DockButton key={a.key} onClick={a.run} disabled={a.key === 'show' && !card}>
            {a.icon}
            {a.label}
          </DockButton>
        ))}
        {actions.length > 2 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <DockButton shape="square" aria-label={COPY.moreLabel}>
                <MoreHorizontal aria-hidden size={24} />
              </DockButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions.slice(2).map((a) => (
                <DropdownMenuItem
                  key={a.key}
                  className="min-h-14 text-lg"
                  disabled={a.key === 'show' && !card}
                  onSelect={a.run}
                >
                  {a.icon}
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </>
    );
  return (
    <SheetFrame
      label={COPY.title}
      onClose={onClose}
      header={<SheetHeader outcome={o} card={card} />}
      footer={footer}
    >
      {hasPass ? (
        <SegmentedControl
          block
          label={COPY.views}
          value={tab}
          onValueChange={setTab}
          options={[
            { value: 'pass', label: COPY.thisPass },
            { value: 'recent', label: COPY.recent },
          ]}
        />
      ) : null}
      {tab === 'recent' ? (
        <RecentList onPick={pick} />
      ) : showPass ? (
        card ? (
          <PassPreview
            card={card}
            {...(orgId ? { orgId } : {})}
            {...(timeZone ? { timeZone } : {})}
          />
        ) : (
          <p role="status" className="scan-sheet-status">
            {COPY.loading}
          </p>
        )
      ) : hasPass ? (
        <>
          <PassTab outcome={o} card={card} notes={notes} now={now} where={where} mine={mine} />
          {query.isPending && sel.input ? (
            <p role="status" className="scan-sheet-status">
              {COPY.loading}
            </p>
          ) : null}
          {query.isError ? (
            <Button variant="secondary" onClick={() => query.refetch()}>
              {COPY.retry}
            </Button>
          ) : null}
        </>
      ) : null}
    </SheetFrame>
  );
}
