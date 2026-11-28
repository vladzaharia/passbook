import { Layers, Siren } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ScanCounts } from '../../../../shared/contracts/scan.ts';
import type { ScanSession } from '../../../../shared/contracts/scan-session.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { plural } from '../../../../shared/plural.ts';
import { CountUp } from '../../../ui/count-up.tsx';
import { ScanOrgLogo } from '../../platform/scan-branding.tsx';
import { initialsOf } from '../lists/person-avatar.tsx';
import { admitNames, inNowOf, type SessionChip } from './session-state.ts';

const T = OPERATOR_COPY.top;

/** `hideToday`: the device's own count chip already says Today, so the fallback would repeat it. */
function InNowChip({ counts, hideToday }: { counts: ScanCounts; hideToday: boolean }) {
  const now = inNowOf(counts);
  if (!now && hideToday) return null;
  if (!now)
    return (
      <span className="op-chip" data-testid="op-in-now">
        {T.today.replace('{n}', '')}
        <b>
          <CountUp value={counts.today} />
        </b>
      </span>
    );
  return (
    <span
      className="op-chip"
      data-testid="op-in-now"
      data-tone={now.ratio === 1 ? 'warn' : undefined}
    >
      <span className="op-chip-k">{T.inNow}</span>
      <b>
        <CountUp value={now.count} />
      </b>
      {now.capacity !== null ? (
        <>
          {T.of.replace('{n}', String(now.capacity))}
          <span className="op-meter" aria-hidden>
            <i style={{ inlineSize: `${Math.round((now.ratio ?? 0) * 100)}%` }} />
          </span>
        </>
      ) : null}
    </span>
  );
}

/** The session at a glance: its state, what it admits, the device's chips, the count, who is signed in. */
export function TopBar({
  session,
  chip,
  counts,
  logoUrl,
  modeLabel,
  chips,
  menu,
  testing,
  onStaff,
  rollCall,
}: {
  session: ScanSession;
  chip: SessionChip;
  counts: ScanCounts;
  logoUrl: string | null;
  modeLabel: string;
  chips: ReactNode;
  menu: ReactNode;
  testing: ReactNode;
  onStaff: () => void;
  /** A roll call is open: how far it is. */
  rollCall?: { done: number; total: number } | null | undefined;
}) {
  const org = session.scanner?.orgName ?? session.admin?.orgs[0]?.name ?? '';
  const name = session.workspace?.session.name ?? session.scanner?.name ?? 'Scan';
  const types = admitNames(session);
  const staff = session.staff;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a header is only a landmark directly under body
    <div role="banner" className="op-top" aria-label={OPERATOR_COPY.landmark.banner}>
      <div className="op-org">
        <span className="op-org-tile" data-has-logo={logoUrl ? '' : undefined}>
          <ScanOrgLogo
            className="op-org-logo"
            src={logoUrl}
            name={org}
            fallback={initialsOf(org || name).slice(0, 1)}
          />
        </span>
        <div className="op-org-text">
          <h1 className="op-org-name">{name}</h1>
          <p className="op-org-sub">{[org, modeLabel].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <span className="op-sep" aria-hidden />
      {testing}
      <span className="op-chip op-chip-state" data-tone={chip.open ? 'open' : 'closed'}>
        <span className="op-dot" data-off={chip.open ? undefined : ''} aria-hidden />
        <span className="op-chip-text" title={chip.text}>
          {chip.text}
          {chip.sub ? <span className="op-chip-sub"> · {chip.sub}</span> : null}
        </span>
      </span>
      {types.length ? (
        <span className="op-chip op-admits" data-muted title={types.join(', ')}>
          <Layers aria-hidden />
          {T.admits}
          <b className="op-admits-names">{types.join(', ')}</b>
          <b className="op-admits-count">{plural(types.length, 'type')}</b>
        </span>
      ) : null}
      <div className="op-top-end">
        {rollCall ? (
          <span className="op-chip op-chip-roll" role="status">
            <Siren aria-hidden />
            {T.roll}
            <b>
              {T.rollOf
                .replace('{n}', String(rollCall.done))
                .replace('{total}', String(rollCall.total))}
            </b>
          </span>
        ) : null}
        {chips}
        <InNowChip counts={counts} hideToday={Boolean(chips)} />
        {staff ? (
          <button type="button" className="op-staff" onClick={onStaff}>
            <span className="op-staff-av" aria-hidden>
              {initialsOf(staff.name)}
            </span>
            <span className="op-staff-name">{staff.name}</span>
            <small>
              {staff.role === 'manager' ? 'Manager' : staff.role === 'desk' ? 'Desk' : 'Door'}
            </small>
          </button>
        ) : null}
        {menu}
      </div>
    </div>
  );
}
