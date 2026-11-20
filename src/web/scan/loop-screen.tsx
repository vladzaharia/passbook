import { Nfc } from 'lucide-react';
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { formatTime } from '../lib/format.ts';
import { getMode } from '../lib/mode.ts';
import type { ScanAppViewProps } from './app.tsx';
import { TAG_EXTRA_COPY } from './assign/copy.ts';
import type { ScanOutcome } from './machine/types.ts';

/** The start panel's words before scanning starts; the loop screen after. */
export function loopScreen(session: ScanSession, started: boolean): ScanAppViewProps['screen'] {
  const scanner = session.scanner;
  return !started
    ? {
        s: 'start',
        scannerName: scanner?.name ?? 'Scan as admin',
        orgName: scanner?.orgName ?? session.admin?.orgs[0]?.name ?? '',
        mode: scanner?.mode ?? getMode(),
        state: session.state === 'not_open' || session.state === 'closed' ? session.state : 'ready',
        templates: session.templates.map((t) => t.name),
        event: session.event
          ? {
              name: session.event.name,
              when: `${formatTime(session.event.opensAt, session.event.timeZone)}–${formatTime(session.event.closesAt, session.event.timeZone)}`,
              note: session.event.note,
            }
          : null,
      }
    : { s: 'loop' };
}

export function tagExtraActions(addTag: (() => void) | undefined) {
  return addTag
    ? [
        {
          key: 'tag',
          label: TAG_EXTRA_COPY.addTag,
          icon: <Nfc aria-hidden size={20} />,
          run: addTag,
        },
      ]
    : [];
}

/** A tap on the tint dismisses a settled verdict. A hold waiting for a manager stays until Done or the PIN, not until a stray tap. */
export function tintDismissible(result: ScanOutcome | null, blocked: boolean) {
  return Boolean(
    result && result.kind !== 'ready' && result.reason !== 'needs_approval' && !blocked,
  );
}
