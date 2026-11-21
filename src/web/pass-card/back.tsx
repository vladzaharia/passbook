import { useId } from 'react';
import type {
  FieldView,
  LayoutView,
  PassView,
  UpcomingView,
} from '../../shared/pass-view/index.ts';
import { Rich } from './parts.tsx';

/** A field with no value (an empty message) says nothing. */
const shown = (fields: FieldView[]) =>
  fields.filter((f) => f.text.trim() || f.segments.some((s) => s.text.trim()));

function Group({ title, fields: all }: { title?: string; fields: FieldView[] }) {
  const fields = shown(all);
  if (!fields.length) return null;
  return (
    <section className="pc-group">
      {title ? <h3 className="pc-group-title">{title}</h3> : null}
      <ul className="pc-list">
        {fields.map((f) => (
          <li key={f.key} className="pc-item">
            {f.label ? <span className="pc-label">{f.label}</span> : null}
            <span className="pc-value">
              <Rich field={f} wrap />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Wallet's event list: a date tile, then the name over the day, time and venue. */
export function Upcoming({ events }: { events: UpcomingView[] }) {
  const titleId = useId();
  if (!events.length) return null;
  return (
    <section className="pc-group" aria-labelledby={titleId}>
      <h3 id={titleId} className="pc-group-title">
        Upcoming events
      </h3>
      <ol className="pc-list pc-upcoming">
        {events.map((e) => (
          <li key={e.id} className="pc-up" data-active={e.active || undefined}>
            {e.dated ? (
              <time className="pc-up-date" dateTime={e.dateTime}>
                <span className="pc-up-month">{e.month}</span>
                <span className="pc-up-day">{e.day}</span>
              </time>
            ) : (
              <span className="pc-up-date" data-tba="">
                <span className="pc-up-day" aria-hidden="true">
                  TBA
                </span>
                <span className="pc-sr">Date to be announced</span>
              </span>
            )}
            <span className="pc-up-text">
              <span className="pc-up-name">{e.name}</span>
              <span className="pc-up-meta">{[e.when, e.venue].filter(Boolean).join(' · ')}</span>
            </span>
            {e.active ? <span className="pc-up-now">Now</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Everything the face does not show, in Wallet's back order: the featured actions, upcoming
 * events, additional info, the back fields, then the front fields past the face's limits. The
 * card's back and the pass page's details render the same sections.
 */
export function BackSections({
  view,
  layout,
  extra = [],
}: {
  view: PassView;
  layout: LayoutView;
  /** Rows the caller adds after the back fields (the pass page's Expires). */
  extra?: FieldView[];
}) {
  return (
    <>
      {layout.actions.length ? (
        <ul className="pc-actions">
          {layout.actions.map((a) => (
            <li key={a.identifier}>
              {a.href ? (
                <a
                  className="pc-action"
                  href={a.href}
                  {...(a.href.startsWith('https:') ? { target: '_blank' } : {})}
                  rel="noopener noreferrer nofollow"
                >
                  {a.label}
                </a>
              ) : (
                <span className="pc-action" data-disabled="">
                  {a.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <Upcoming events={view.upcoming} />
      <Group title="Additional info" fields={layout.additionalInfo} />
      <Group fields={[...layout.back, ...extra]} />
      <Group title="More" fields={layout.overflow} />
    </>
  );
}

/** Whether BackSections draws anything. */
export const hasBack = (view: PassView, layout: LayoutView): boolean =>
  layout.actions.length +
    view.upcoming.length +
    shown(layout.additionalInfo).length +
    shown(layout.back).length +
    shown(layout.overflow).length >
  0;

export function Back({ view, layout }: { view: PassView; layout: LayoutView }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
    // biome-ignore lint/a11y/useSemanticElements: a landmark per card is noise on list pages
    <div className="pc-back-body" role="region" aria-label="Pass details" tabIndex={0}>
      <div className="pc-back-head">
        <h2 className="pc-title">{view.organizationName}</h2>
        {view.description && view.description !== view.organizationName ? (
          <p className="pc-sub">{view.description}</p>
        ) : null}
      </div>
      <BackSections view={view} layout={layout} />
    </div>
  );
}
