import { Check, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { renderScanDisplay } from '@/passkit/template/scan-display/render.ts';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import type { ScanDisplay, ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';
import { SCAN_COPY, SCAN_REASON_COPY, scanLine } from '@/shared/copy/scan.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { cn } from '../../lib/cn.ts';
import { DisplayChip } from '../../scan/display/chip.tsx';
import { DisplayPanels } from '../../scan/display/display-panels.tsx';
import { Card, CardBody, CardHeader, SegmentedControl, Skeleton } from '../../ui/index.ts';
import {
  displayForPreview,
  previewActions,
  scopeForOutcome,
  syntheticScope,
} from '../templates/designer/scan/scan-preview.ts';
import { previewManifest } from '../templates/designer/scan/scan-preview-policy.ts';
import { useBlueprintVersion } from './api.ts';
import { docOfVersion } from './quick-setup.ts';
import './blueprints.css';

type Screen = Extract<ScanDisplayScreen, 'ok' | 'heads_up'>;
const SCREENS: { id: Screen; label: string }[] = [
  { id: 'ok', label: 'Checked in' },
  { id: 'heads_up', label: 'Already used' },
];

/** The scan result of a blueprint's sample pass, as the door sees it. */
function useStaffResult(
  blueprintId: string,
  version: string | null,
  screen: Screen,
): { loading: boolean; result: { display: ScanDisplay; title: string } | null } {
  const query = useBlueprintVersion(blueprintId, version);
  const now = useMemo(() => Date.now(), []);
  const result = useMemo(() => {
    if (!query.data) return null;
    try {
      const doc = docOfVersion(query.data);
      const manifest = previewManifest(doc);
      const action = previewActions(manifest)[0];
      const authored = displayForPreview(
        doc,
        (manifest.scan?.display ?? null) as ScanDisplayDoc | null,
      );
      const scope = scopeForOutcome(syntheticScope(doc, 'door', now), screen, action, now);
      const display = renderScanDisplay(authored, scope, {
        screen,
        role: 'door',
        locale: 'en',
        timeZone: DEFAULT_TIME_ZONE,
        now,
        ...(action ? { actionId: action.id } : {}),
      });
      const title =
        screen === 'heads_up'
          ? scanLine(SCAN_REASON_COPY.already_done.headline, {
              done:
                action?.kind === 'check_in' || !action
                  ? SCAN_COPY.verdict.already.checkIn
                  : SCAN_COPY.verdict.already.other,
            })
          : action?.kind === 'check_in' || !action
            ? SCAN_COPY.verdict.checkedIn
            : action.label;
      return { display, title };
    } catch {
      return null;
    }
  }, [query.data, screen, now]);
  return { loading: query.isPending && Boolean(version), result };
}

export function StaffView({
  blueprintId,
  version,
}: {
  blueprintId: string;
  version: string | null;
}) {
  const [screen, setScreen] = useState<Screen>('ok');
  const { loading, result } = useStaffResult(blueprintId, version, screen);
  if (!loading && !result) return null;
  const warn = screen === 'heads_up';
  const Glyph = warn ? TriangleAlert : Check;
  return (
    <Card>
      <CardHeader
        title="What staff see"
        actions={
          <SegmentedControl
            label="Result"
            value={screen}
            onValueChange={setScreen}
            options={SCREENS.map((o) => ({ value: o.id, label: o.label }))}
          />
        }
      />
      <CardBody>
        {result ? (
          <div
            key={screen}
            className="bp-door mx-auto grid w-full max-w-xs gap-3 overflow-hidden rounded-2xl border border-border bg-surface-sunken pb-3"
          >
            <div
              className={cn(
                'flex items-center gap-3 px-4 py-3',
                warn ? 'bg-warning text-warning-on' : 'bg-success text-success-on',
              )}
            >
              <Glyph aria-hidden className="size-6 shrink-0" strokeWidth={3} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{result.title}</p>
                <p className="truncate text-xs opacity-90">{result.display.identity.holder}</p>
              </div>
            </div>
            {result.display.header.chips.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 px-4">
                {result.display.header.chips.map((chip) => (
                  <DisplayChip key={chip.id} chip={chip} />
                ))}
              </div>
            ) : null}
            <DisplayPanels display={result.display} className="px-4" />
          </div>
        ) : (
          <Skeleton className="mx-auto h-56 w-full max-w-xs rounded-2xl" />
        )}
      </CardBody>
    </Card>
  );
}
