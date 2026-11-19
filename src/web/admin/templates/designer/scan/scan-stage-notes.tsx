import type { ScanPanelDoc } from '@/passkit/template/scan-display/schema.ts';
import type { ScanAction } from '@/passkit/types.ts';
import { safePreviewText } from './scan-preview-policy.ts';

/** What the scanner's screen cannot show: panels hidden for this sample, actions the role lacks. */
export function StageNotes({
  hiddenPanels,
  restricted,
  onSelect,
}: {
  hiddenPanels: ScanPanelDoc[];
  restricted: ScanAction[];
  onSelect: (id: string | null) => void;
}) {
  return (
    <>
      {hiddenPanels.length > 0 ? (
        <div className="sp-hidden">
          {hiddenPanels.map((panel) => {
            const name =
              typeof panel.title === 'string' && safePreviewText(panel.title)
                ? panel.title
                : 'Panel';
            return (
              <button
                key={panel.id}
                type="button"
                className="sp-hidden-panel"
                aria-label={`${name}, hidden for this sample`}
                onClick={() => onSelect(panel.id)}
              >
                {name} · Hidden for this sample
              </button>
            );
          })}
        </div>
      ) : null}
      {restricted.length > 0 ? (
        <div className="sp-help">
          {restricted.map((action) => (
            <p key={action.id}>
              {`${safePreviewText(action.label) ? action.label : 'Action'} · ${action.minRole === 'manager' ? 'Manager' : 'Desk'} required`}
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function SourceStatus({
  usingReal,
  wantsReal,
  passId,
  realStatus,
  restricted,
  noOrg,
  lookFailed,
}: {
  usingReal: boolean;
  wantsReal: boolean;
  passId: string | null;
  realStatus: 'idle' | 'loading' | 'error';
  restricted: boolean;
  noOrg: boolean;
  lookFailed: boolean;
}) {
  return (
    <>
      <p className="sp-source" role="status">
        {usingReal
          ? 'Real pass · filtered for the selected role'
          : wantsReal && passId && realStatus !== 'error'
            ? 'Loading real pass · showing a synthetic sample'
            : wantsReal && realStatus === 'error'
              ? 'Real pass unavailable · showing a synthetic sample'
              : 'Synthetic sample · not a real pass'}
      </p>
      {restricted ? (
        <p className="sp-help">
          Some synthetic inputs and lookups are omitted to protect restricted data.
        </p>
      ) : null}
      {noOrg ? <p className="sp-help">Real-pass preview needs an organization.</p> : null}
      {lookFailed ? (
        <p className="sp-help">
          Couldn't load the organization's logo and color. Showing neutral branding.
        </p>
      ) : null}
    </>
  );
}
