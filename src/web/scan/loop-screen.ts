import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { formatTime } from '../lib/format.ts';
import { getMode } from '../lib/mode.ts';
import type { ScanAppViewProps } from './app.tsx';

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
