import { Moon } from 'lucide-react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { windowLabel } from '@/shared/session-window.ts';
import { StatusPill } from '@/web/ui/index.ts';

export type SessionState = 'running' | 'closed' | 'paused' | 'ended';

/** Status is the master switch; hours and holds only matter while it is active. */
export function sessionState(s: Pick<ScanningSession, 'status' | 'window'>): SessionState {
  if (s.status === 'paused') return 'paused';
  if (s.status === 'ended') return 'ended';
  return s.window && !s.window.open ? 'closed' : 'running';
}

const LABEL: Record<SessionState, string> = {
  running: 'Running',
  closed: 'Closed',
  paused: 'Paused',
  ended: 'Ended',
};

/** "Open until 22:00", "Opens 08:00 Tue", "Closed until 08:00 Tue"; null when there is nothing to say. */
export function sessionWindowLine(
  s: Pick<ScanningSession, 'status' | 'window' | 'timeZone'>,
  now: number = Date.now(),
): string | null {
  return s.status === 'active' && s.window ? windowLabel(s.window, s.timeZone, now) : null;
}

/** The pill and, under it, what the clock does next. */
export function SessionStatePill({ session }: { session: ScanningSession }) {
  const state = sessionState(session);
  const line = sessionWindowLine(session);
  return (
    <>
      <StatusPill
        status={state === 'closed' ? 'closed' : session.status}
        tone={state === 'running' ? 'success' : state === 'paused' ? 'warning' : 'neutral'}
        {...(state === 'closed' ? { icon: Moon } : {})}
      >
        {LABEL[state]}
      </StatusPill>
      {line ? <span className="text-xs text-fg-muted">{line}</span> : null}
    </>
  );
}
