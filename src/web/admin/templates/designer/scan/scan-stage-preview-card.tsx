import { Info, LockKeyhole, Ticket } from 'lucide-react';
import type { ScanPanelDoc } from '@/passkit/template/scan-display/schema.ts';
import { roleAtLeast } from '@/passkit/template/scan-display/scope.ts';
import type { ScanAction, ScanRole } from '@/passkit/types.ts';
import type { ScanDisplay } from '@/shared/contracts/scan-display.ts';
import { SCAN_COPY, SCAN_REASON_COPY, scanLine } from '@/shared/copy/scan.ts';
import { DisplayChip } from '@/web/scan/display/chip.tsx';
import { scanIcon } from '@/web/scan/display/icons.ts';
import { VerdictGlyph } from '@/web/scan/result/verdict-glyph.tsx';
import { safePreviewText } from './scan-preview-policy.ts';
import { Hit, type HitState, PreviewPanel } from './scan-stage-preview-hit.tsx';
import type { PreviewTab } from './scan-stage-types.ts';

export function PreviewCard({
  rendered,
  tab,
  actions,
  hit,
  hiddenPanels,
  role,
}: {
  rendered: ScanDisplay;
  tab: PreviewTab;
  actions: ScanAction[];
  hit: HitState;
  hiddenPanels: ScanPanelDoc[];
  role: ScanRole;
}) {
  const { screen } = rendered;
  const custom = screen === 'ok' && Boolean(rendered.header.title);
  const title =
    screen === 'heads_up'
      ? SCAN_REASON_COPY.already_done.headline
      : screen === 'refused'
        ? SCAN_REASON_COPY.voided.headline
        : tab.action?.kind === 'check_in'
          ? SCAN_COPY.verdict.checkedIn
          : tab.action && safePreviewText(tab.action.label)
            ? tab.action.label
            : SCAN_COPY.verdict.checkedIn;
  const Icon = screen === 'ok' && rendered.header.icon ? scanIcon(rendered.header.icon) : null;
  const note = screen === 'refused' ? rendered.notes.refused : rendered.notes.staff;
  return (
    <section className="scan-result sp-result" data-kind={screen} data-screen={screen}>
      {screen !== 'ready' ? (
        <div
          className="scan-result-band"
          data-layout={custom ? 'custom' : screen === 'refused' ? 'stack' : 'row'}
        >
          <div className="scan-glyph-row">
            {Icon ? (
              <Hit {...hit} id="header" focusKey="header-icon" label="Header, custom icon">
                <span className="scan-custom-glyph">
                  <Icon aria-hidden />
                  <span className="scan-custom-badge">
                    <VerdictGlyph kind="ok" />
                  </span>
                </span>
              </Hit>
            ) : null}
            <Hit
              {...hit}
              id="system-verdict"
              label="System. The verdict and its meaning cannot be changed."
              locked
              className="sp-verdict-lock"
            >
              {Icon ? (
                !custom && <LockKeyhole size={14} aria-hidden />
              ) : (
                <VerdictGlyph kind={screen} />
              )}
              {custom ? <span className="scan-verdict-eyebrow">{title}</span> : null}
            </Hit>
          </div>
          <div className="scan-verdict-text">
            {screen === 'ok' && custom ? (
              <Hit
                {...hit}
                id="header"
                focusKey="header-title"
                label="Header, custom title"
                className="sp-title-hit"
              >
                <span className="sp-headline">{rendered.header.title}</span>
              </Hit>
            ) : (
              <span className="sp-headline">{title}</span>
            )}
            {screen === 'heads_up' ? (
              <p>
                {scanLine(SCAN_REASON_COPY.already_done.sub, {
                  ago: '12 min ago',
                  scanner: 'Sample scanner',
                })}
              </p>
            ) : null}
            {screen === 'refused' ? (
              <p>{scanLine(SCAN_REASON_COPY.voided.sub, { date: 'Nov 3' })}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <Hit
          {...hit}
          id="system-verdict"
          label="System. The ready heading cannot be changed."
          locked
          className="scan-ready-heading"
        >
          Choose an action
        </Hit>
      )}
      <div className="scan-result-body">
        <div className="scan-identity" data-compact={screen === 'refused' || undefined}>
          <Hit
            {...hit}
            id="system-identity"
            label="System. The holder line always shows; choose its source in Header."
            locked
            className="sp-identity-hit"
          >
            {rendered.identity.photo?.url ? (
              <img
                className="scan-identity-photo"
                src={rendered.identity.photo.url}
                alt={rendered.identity.photo.alt}
              />
            ) : rendered.identity.photo ? (
              <span className="scan-identity-photo sp-initials" aria-hidden>
                {rendered.identity.initials}
              </span>
            ) : (
              <span className="scan-pass-tile" aria-hidden>
                <Ticket size={22} />
              </span>
            )}
            <span className="scan-identity-text">
              <span className="scan-result-holder" dir="auto">
                {rendered.identity.holder}
              </span>
            </span>
          </Hit>
          {screen !== 'refused' &&
          (rendered.header.meta ||
            rendered.header.chips.length > 0 ||
            (rendered.identity.photo && !rendered.identity.photo.url)) ? (
            <div className="sp-identity-extra">
              {rendered.header.meta ? (
                <Hit
                  {...hit}
                  id="header"
                  focusKey="header-meta"
                  label="Header, meta line"
                  className="scan-identity-meta sp-meta-hit"
                >
                  {rendered.header.meta}
                </Hit>
              ) : null}
              <div className="scan-identity-chips">
                {rendered.identity.photo && !rendered.identity.photo.url ? (
                  <span className="scan-identity-chip" data-tone="neutral">
                    No photo
                  </span>
                ) : null}
                {rendered.header.chips.map((chip) => (
                  <Hit
                    {...hit}
                    key={chip.id}
                    id={chip.id}
                    label={`Chip ${chip.text}`}
                    className="sp-chip-hit"
                  >
                    <DisplayChip chip={chip} />
                  </Hit>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {screen !== 'refused' ? (
          <div className="sd">
            {rendered.panels.map((panel) => (
              <PreviewPanel key={panel.id} panel={panel} hit={hit} />
            ))}
            {hiddenPanels.map((panel) => {
              const name =
                typeof panel.title === 'string' && safePreviewText(panel.title)
                  ? panel.title
                  : 'Panel';
              return (
                <Hit
                  {...hit}
                  key={panel.id}
                  id={panel.id}
                  label={`${name}, hidden for this sample`}
                  className="sp-hidden-panel"
                >
                  {name} · Hidden for this sample
                </Hit>
              );
            })}
          </div>
        ) : null}
        {note ? (
          <Hit
            {...hit}
            id="notes"
            label={screen === 'refused' ? 'Refused note' : 'Staff note'}
            className="scan-result-notes"
          >
            <Info size={18} aria-hidden />
            <span>{note}</span>
          </Hit>
        ) : null}
        <Hit
          {...hit}
          id="system-actions"
          label="System. Actions are configured separately from the scan display."
          locked
          className="sp-actions-lock"
        >
          <span className="sp-lock-label">
            <LockKeyhole size={13} aria-hidden /> System actions
          </span>
          <span className="sp-actions">
            {(screen === 'ready'
              ? actions
              : screen === 'heads_up'
                ? [{ id: 'done', label: 'Done' }]
                : screen === 'ok'
                  ? [{ id: 'undo', label: 'Undo' }]
                  : [{ id: 'done', label: 'Done' }]
            ).map((action) => {
              const needed =
                screen === 'ready'
                  ? actions.find((candidate) => candidate.id === action.id)?.minRole
                  : undefined;
              const restricted = needed !== undefined && !roleAtLeast(role, needed);
              return (
                <span
                  className="sp-action"
                  data-restricted={restricted || undefined}
                  key={action.id}
                >
                  {restricted ? <LockKeyhole size={14} aria-hidden /> : null}
                  {safePreviewText(action.label) ? action.label : 'Action'}
                  {restricted ? ` · ${needed === 'manager' ? 'Manager' : 'Desk'} required` : null}
                </span>
              );
            })}
          </span>
        </Hit>
      </div>
    </section>
  );
}
