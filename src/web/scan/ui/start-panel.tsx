import { Camera, Info } from 'lucide-react';
import type { Mode } from '../../../shared/contracts/common.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { Button } from '../../ui/button.tsx';
import { ModePill } from '../../ui/layout/mode-pill.tsx';
import { SegmentedControl } from '../../ui/segmented-control.tsx';
import { BootCard } from './boot-card.tsx';
import { fill, UI_COPY } from './copy.ts';

export interface StartPanelProps {
  scannerName: string;
  orgName: string;
  mode?: Mode;
  /** An event scanner shows the event row; a template scanner lists what it accepts. */
  event?: { name: string; when: string; count?: string | null; note?: string | null } | null;
  templates?: readonly string[];
  /** `not_open` and `closed` still scan (heads-up) and say so. */
  state: 'ready' | 'not_open' | 'closed';
  /** The formatted opening or closing time for the line. */
  time?: string;
  /** Re-entry events show In / Out. */
  reentry?: boolean;
  direction?: 'in' | 'out';
  onDirection?: (d: 'in' | 'out') => void;
  onStart: () => void;
  busy?: boolean;
}

/** Start, as a card (SD 5.1). Start gates the camera, audio and wake lock in one tap. */
export function StartPanel(p: StartPanelProps) {
  const line =
    p.state === 'not_open'
      ? fill(UI_COPY.opens, { time: p.time ?? '' })
      : p.state === 'closed'
        ? fill(UI_COPY.closed, { time: p.time ?? '' })
        : null;
  return (
    <BootCard
      title={p.scannerName}
      line={
        <>
          {p.orgName} <ModePill mode={p.mode} className="ml-1 align-middle" />
        </>
      }
      testId="scan-start-card"
    >
      {p.event ? (
        <div className="scan-start-event">
          <span className="scan-start-event-name" dir="auto">
            {p.event.name}
          </span>
          <span className="scan-card-line">{p.event.when}</span>
          {p.event.count ? <span className="scan-card-line">{p.event.count}</span> : null}
        </div>
      ) : p.templates?.length ? (
        <p className="scan-card-line" dir="auto">
          {p.templates.join(' · ')}
        </p>
      ) : null}
      {p.event?.note ? (
        <p className="scan-start-note" dir="auto">
          <Info aria-hidden size={18} />
          {p.event.note}
        </p>
      ) : null}
      {line ? <p className="scan-card-line">{line}</p> : null}
      {p.reentry && p.direction && p.onDirection ? (
        <SegmentedControl
          label={UI_COPY.direction}
          value={p.direction}
          onValueChange={p.onDirection}
          options={[
            { value: 'in', label: UI_COPY.dirIn },
            { value: 'out', label: UI_COPY.dirOut },
          ]}
          block
        />
      ) : null}
      <Button
        size="lg"
        className="w-full"
        data-testid="scan-start"
        loading={p.busy}
        onClick={p.onStart}
      >
        <Camera aria-hidden />
        {SCAN_COPY.actions.startScanning}
      </Button>
    </BootCard>
  );
}
