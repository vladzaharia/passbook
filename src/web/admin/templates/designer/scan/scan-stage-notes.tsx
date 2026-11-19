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
